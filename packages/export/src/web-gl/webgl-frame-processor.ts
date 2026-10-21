// GlFrameProcessor on WebGL with the preview's own EffectRenderer (timeline-media), for browser and
// Electron renderer contexts. Frames arrive as RGBA bytes and leave as RGBA bytes.
import { EffectRenderer } from "@opennan/timeline-media/effects/effect-renderer";
import type { GlFrameProcessor } from "../gl";

export function createWebGlFrameProcessor(): GlFrameProcessor {
    const source = document.createElement("canvas");
    const glCanvas = document.createElement("canvas");
    const readback = document.createElement("canvas");
    const sourceCtx = source.getContext("2d");
    const readCtx = readback.getContext("2d", { willReadFrequently: true });
    if (!sourceCtx || !readCtx) throw new Error("2D canvas context unavailable");
    const renderer = new EffectRenderer(glCanvas, { preserveDrawingBuffer: true });
    return {
        async process(frame, effects) {
            for (const canvas of [source, readback]) {
                if (canvas.width !== frame.width) canvas.width = frame.width;
                if (canvas.height !== frame.height) canvas.height = frame.height;
            }
            sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
            renderer.render(source, effects, frame.time);
            readCtx.clearRect(0, 0, frame.width, frame.height);
            readCtx.drawImage(glCanvas, 0, 0, frame.width, frame.height);
            return new Uint8Array(readCtx.getImageData(0, 0, frame.width, frame.height).data.buffer);
        },
        dispose() {
            renderer.destroy();
        },
    };
}
