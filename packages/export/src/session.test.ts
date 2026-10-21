import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { encoderChoice, type EncoderOptions } from "./encoders";
import { exportTimeline } from "./export-timeline";
import type { ExportRunner } from "./runner";
import { createExportSession, type ExportSessionState } from "./session";
import type { ExportInput } from "./types";

const input: ExportInput = {
    project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 },
    tracks: [{ type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }],
    scenes: [],
    clips: [optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" }, "p", "t")],
};

function fakeRunner(run: ExportRunner["run"]): ExportRunner {
    return {
        kind: "wasm", supportsGl: false, maxResolution: "1080p",
        probe: async () => new Map(),
        chooseEncoder: async (o) => encoderChoice("mpeg4", o),
        run,
    };
}
const rasterizer = {
    rasterize: async () => ({ id: "text-t", png: new Uint8Array([1]), width: 10, height: 10, boxWidth: 8, boxHeight: 8, pad: 1, scale: 1 }),
};

describe("createExportSession", () => {
    it("reports running → done with the result", async () => {
        const session = createExportSession({
            runner: fakeRunner(async (_plan, _enc, o) => {
                o?.onProgress?.(0.5);
                return { kind: "bytes", data: new Uint8Array([1]) };
            }),
            rasterizer,
        });
        const seen: ExportSessionState["status"][] = [];
        session.subscribe(() => seen.push(session.getState().status));
        const final = await session.start(input, { resolution: "720p" });
        expect(final.status).toBe("done");
        if (final.status === "done") expect(final.result.mimeType).toBe("video/mp4");
        expect(seen[0]).toBe("running");
        expect(seen[seen.length - 1]).toBe("done");
    });

    it("cancel aborts the run", async () => {
        const session = createExportSession({
            runner: fakeRunner((_plan, _enc, o) => new Promise((_resolve, reject) => {
                o?.signal?.addEventListener("abort", () => reject(new Error("killed")));
            })),
            rasterizer,
        });
        const pending = session.start(input, { resolution: "720p" });
        await new Promise((r) => setTimeout(r, 0));
        session.cancel();
        expect((await pending).status).toBe("cancelled");
    });

    it("cancel settles the session even when the rasterizer never answers", async () => {
        const session = createExportSession({
            runner: fakeRunner(async () => ({ kind: "bytes", data: new Uint8Array([1]) })),
            rasterizer: { rasterize: () => new Promise<never>(() => {}) },
        });
        const pending = session.start(input, { resolution: "720p" });
        await new Promise((r) => setTimeout(r, 0));
        session.cancel();
        expect((await pending).status).toBe("cancelled");
        expect(session.getState().status).toBe("cancelled");
    });

    it("errors carry the ExportError code", async () => {
        const session = createExportSession({ runner: fakeRunner(async () => ({ kind: "bytes", data: new Uint8Array() })), rasterizer });
        const final = await session.start({ ...input, clips: [] }, { resolution: "720p" });
        expect(final).toMatchObject({ status: "error", code: "empty-timeline" });
        const tooBig = await session.start(input, { resolution: "4k" });
        expect(tooBig).toMatchObject({ status: "error", code: "resolution-unsupported" });
    });

    it("a second start while running resolves with the running state instead of rejecting", async () => {
        let finish: (() => void) | undefined;
        const session = createExportSession({
            runner: fakeRunner(() => new Promise((resolve) => {
                finish = () => resolve({ kind: "bytes", data: new Uint8Array([1]) });
            })),
            rasterizer,
        });
        const first = session.start(input, { resolution: "720p" });
        await expect(session.start(input, { resolution: "720p" })).resolves.toMatchObject({ status: "running" });
        await new Promise((r) => setTimeout(r, 0));
        finish?.();
        expect((await first).status).toBe("done");
    });
});

describe("exportTimeline warnings", () => {
    const run = async () => ({ kind: "bytes" as const, data: new Uint8Array([1]) });

    it("leaves text out with text-unsupported when the host has no rasterizer", async () => {
        const result = await exportTimeline(input, { resolution: "720p" }, { runner: fakeRunner(run) });
        expect(result.warnings.map((w) => [w.code, w.clipId])).toEqual([["text-unsupported", "t"], ["encoder-fallback", undefined]]);
    });

    it("reports an MPEG-4 or VP9 fallback, not H.264", async () => {
        expect((await exportTimeline(input, { resolution: "720p" }, { runner: fakeRunner(run), rasterizer })).warnings.map((w) => w.code)).toEqual(["encoder-fallback"]);
        const h264: ExportRunner = { ...fakeRunner(run), chooseEncoder: async (o: EncoderOptions) => encoderChoice("h264_videotoolbox", o) };
        expect((await exportTimeline(input, { resolution: "720p" }, { runner: h264, rasterizer })).warnings).toEqual([]);
    });
});
