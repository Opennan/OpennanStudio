import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { encoderChoice } from "./encoders";
import { MAX_FRAME_SIDE, createExportFrameRenderer, frameSize } from "./frame-renderer";
import type { ExportRunner } from "./runner";

const rasterizer = {
    rasterize: async () => ({ id: "text-t", png: new Uint8Array([1]), width: 10, height: 10, boxWidth: 8, boxHeight: 8, pad: 1, scale: 1 }),
};
const snapshot = {
    project: { aspectRatio: "9:16", musicUrl: null, musicVolume: 1 },
    tracks: [{ type: "text" as const, index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }],
    scenes: [],
    clips: [optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" }, "p", "t")],
};

describe("frameSize", () => {
    it("keeps the project ratio when one side is given", () => {
        expect(frameSize("16:9", 640)).toEqual({ width: 640, height: 360 });
        expect(frameSize("9:16", undefined, 640)).toEqual({ width: 360, height: 640 });
        expect(frameSize("16:9", 100, 100)).toEqual({ width: 100, height: 100 });
        expect(frameSize("16:9")).toBeNull();
    });

    it("caps the longest side at MAX_FRAME_SIDE and keeps the ratio", () => {
        expect(MAX_FRAME_SIDE).toBe(3840);
        expect(frameSize("16:9", 100000)).toEqual({ width: 3840, height: 2160 });
        expect(frameSize("9:16", undefined, 100000)).toEqual({ width: 2160, height: 3840 });
        expect(frameSize("16:9", 100000, 50000)).toEqual({ width: 3840, height: 1920 });
        expect(frameSize("16:9", 3840, 2160)).toEqual({ width: 3840, height: 2160 });
    });

    it("rejects sizes that are not finite and positive", () => {
        for (const bad of [0, -640, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => frameSize("16:9", bad)).toThrow(expect.objectContaining({ code: "resolution-unsupported" }));
            expect(() => frameSize("16:9", 640, bad)).toThrow(expect.objectContaining({ code: "resolution-unsupported" }));
        }
    });
});

describe("createExportFrameRenderer", () => {
    it("compiles the snapshot and asks the runner for one frame inside the timeline", async () => {
        const renderFrame = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
        const runner: ExportRunner = {
            kind: "node", supportsGl: true, maxResolution: "4k",
            probe: async () => new Map(), chooseEncoder: async (o) => encoderChoice("mpeg4", o), run: async () => ({ kind: "bytes", data: new Uint8Array() }),
            renderFrame,
        };
        const frame = await createExportFrameRenderer({ runner, rasterizer }).renderFrame({ snapshot, seconds: 99, width: 360 });
        expect(frame).toEqual({ mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71]), width: 360, height: 640 });
        const [plan, seconds, options] = renderFrame.mock.calls[0] as unknown as [{ format: { width: number } }, number, { size: unknown }];
        expect(plan.format.width).toBe(720);
        expect(seconds).toBeCloseTo(2 - 1 / 30);
        expect(options.size).toEqual({ width: 360, height: 640 });
    });

    it("rejects an oversized or invalid frame size before probing or rendering", async () => {
        const probe = vi.fn(async () => new Map());
        const renderFrame = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
        const runner: ExportRunner = {
            kind: "node", supportsGl: true, maxResolution: "4k",
            probe, chooseEncoder: async (o) => encoderChoice("mpeg4", o), run: async () => ({ kind: "bytes", data: new Uint8Array() }),
            renderFrame,
        };
        const renderer = createExportFrameRenderer({ runner, rasterizer });
        await expect(renderer.renderFrame({ snapshot, seconds: 0, width: -1 })).rejects.toMatchObject({ code: "resolution-unsupported" });
        expect(probe).not.toHaveBeenCalled();
        const frame = await renderer.renderFrame({ snapshot, seconds: 0, height: 100000 });
        expect(frame).toMatchObject({ width: 2160, height: 3840 });
        expect((renderFrame.mock.calls[0] as unknown as [unknown, number, { size: unknown }])[2].size).toEqual({ width: 2160, height: 3840 });
    });

    it("rejects with cancelled when aborted while the rasterizer hangs", async () => {
        const runner: ExportRunner = {
            kind: "node", supportsGl: true, maxResolution: "4k",
            probe: async () => new Map(), chooseEncoder: async (o) => encoderChoice("mpeg4", o), run: async () => ({ kind: "bytes", data: new Uint8Array() }),
            renderFrame: async () => new Uint8Array([137, 80, 78, 71]),
        };
        const controller = new AbortController();
        const pending = createExportFrameRenderer({ runner, rasterizer: { rasterize: () => new Promise<never>(() => {}) } })
            .renderFrame({ snapshot, seconds: 0, signal: controller.signal });
        await new Promise((r) => setTimeout(r, 0));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    });

    it("refuses runners without single-frame support", async () => {
        const runner = { kind: "wasm", supportsGl: false, maxResolution: "1080p" } as unknown as ExportRunner;
        await expect(createExportFrameRenderer({ runner, rasterizer }).renderFrame({ snapshot, seconds: 0 })).rejects.toMatchObject({ code: "no-encoder" });
    });
});
