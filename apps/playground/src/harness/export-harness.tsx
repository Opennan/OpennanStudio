// ?harness=export: browser-side checks for @opennan/export (e2e/export-web.spec.ts): canvas text
// rasterizer, WebGL frame processor, and a real ffmpeg.wasm export.
import { useEffect } from "react";
import type { SceneData, TimelineTrack } from "@opennan/timeline-core";
import { optimistic } from "@opennan/timeline-core";
import { exportTimeline, type ExportInput } from "@opennan/export";
import { createBrowserRasterizer, createFetchMediaReader, createWasmRunner } from "@opennan/export/web";
import { createWebGlFrameProcessor } from "@opennan/export/web-gl";

const INVERT_GLSL = "vec4 effect(sampler2D tex, vec2 uv) { vec4 c = texture2D(tex, uv); return vec4(1.0 - c.rgb, c.a); }";

function sampleInput(): ExportInput {
    const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
    const scene: SceneData = {
        id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
        sourceVideoUrl: "/sample/testsrc-6s.webm", status: "ready", transition: "cut", cardType: "source_clip", duration: 2,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, timelinePositionSeconds: 0.001, fitMode: "contain",
    };
    const title = optimistic.optimisticTimelineClipFromInput(
        { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Exported in the browser", textStyle: JSON.stringify({ fontSize: 48, bgColor: "#000000" }) },
        "harness",
        "title",
    );
    return { project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: [track("video", 1), track("text", 1)], scenes: [scene], clips: [title] };
}

async function opaquePixels(png: Uint8Array): Promise<number> {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

const harness = {
    async rasterizeText() {
        const result = await createBrowserRasterizer().rasterize({
            kind: "text", id: "text-h", clipId: "h", text: "Hello", textStyle: JSON.stringify({ fontSize: 48, color: "#ffffff" }),
            scale: 1, frameScale: 1, frameWidth: 1920,
        });
        return { width: result.width, height: result.height, boxHeight: result.boxHeight, opaque: await opaquePixels(result.png) };
    },
    async glInvert() {
        const processor = createWebGlFrameProcessor();
        const frame = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < frame.length; i += 4) frame.set([255, 0, 0, 255], i);
        const out = await processor.process({ data: frame, width: 4, height: 4, time: 0 }, [{ id: "invert", glsl: INVERT_GLSL, floatParams: {} }]);
        processor.dispose?.();
        return [...out.slice(0, 4)];
    },
    async wasmExport() {
        const runner = createWasmRunner({ readMedia: createFetchMediaReader({ resolveMediaUrl: (url) => url }), coreBaseUrl: `${location.origin}/ffmpeg-core` });
        try {
            const result = await exportTimeline(sampleInput(), { resolution: "720p" }, { runner, rasterizer: createBrowserRasterizer() });
            if (result.output.kind !== "bytes") throw new Error("wasm runner returns bytes");
            return { container: result.container, encoder: result.encoder, warnings: result.warnings, base64: toBase64(result.output.data) };
        } finally {
            runner.dispose();
        }
    },
};

export function ExportHarness() {
    useEffect(() => {
        Object.assign(window, { __exportHarness: harness });
    }, []);
    return <p className="loading">export harness ready</p>;
}
