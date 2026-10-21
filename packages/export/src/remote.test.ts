import { MessageChannel } from "node:worker_threads";
import { createRemoteGlFrameProcessor, createRemoteRasterizer, serveGlFrameProcessor, serveOverlayRasterizer, type BridgePort } from "./remote";

// Node's MessagePort is an EventTarget like the DOM one; Electron's MessagePortMain needs a small .on adapter.
const ports = () => {
    const channel = new MessageChannel();
    return { main: channel.port1 as unknown as BridgePort, renderer: channel.port2 as unknown as BridgePort, close: () => { channel.port1.close(); channel.port2.close(); } };
};

describe("main ↔ renderer bridge", () => {
    it("rasterizes through a message port", async () => {
        const { main, renderer, close } = ports();
        const stop = serveOverlayRasterizer(renderer, {
            rasterize: async (job) => ({ id: job.id, png: new Uint8Array([1, 2]), width: 1, height: 1, boxWidth: 1, boxHeight: 1, pad: 0, scale: 1 }),
        });
        const remote = createRemoteRasterizer(main);
        const result = await remote.rasterize({ kind: "emoji", id: "emoji-e", clipId: "e", text: "★", scale: 1, frameScale: 1 });
        expect([result.id, [...result.png]]).toEqual(["emoji-e", [1, 2]]);
        remote.close();
        stop();
        close();
    });

    it("runs GL frames through a message port and surfaces errors", async () => {
        const { main, renderer, close } = ports();
        const stop = serveGlFrameProcessor(renderer, {
            process: async (frame, effects) => {
                if (effects.length === 0) throw new Error("no effects");
                return frame.data.map((v) => 255 - v);
            },
        });
        const remote = createRemoteGlFrameProcessor(main);
        const out = await remote.process({ data: new Uint8Array([0, 10, 20, 255]), width: 1, height: 1, time: 0 }, [{ id: "invert", glsl: "", floatParams: {} }]);
        expect([...out]).toEqual([255, 245, 235, 0]);
        await expect(remote.process({ data: new Uint8Array(4), width: 1, height: 1, time: 0 }, [])).rejects.toThrow("no effects");
        remote.dispose?.();
        stop();
        close();
    });

    it("rejects raster results that break the RasterResult contract", async () => {
        const job = { kind: "emoji" as const, id: "emoji-e", clipId: "e", text: "★", scale: 1, frameScale: 1 };
        const good = { id: job.id, png: new Uint8Array([1]), width: 4, height: 4, boxWidth: 2, boxHeight: 2, pad: 1, scale: 1 };
        const bad: Record<string, unknown>[] = [
            { ...good, png: "not bytes" },
            { ...good, width: Number.NaN },
            { ...good, height: 100000 },
            { ...good, boxWidth: -1 },
            { ...good, pad: Number.POSITIVE_INFINITY },
            { ...good, scale: 0.0001 },
            { ...good, id: "text-other" },
        ];
        for (const value of [good, ...bad]) {
            const { main, renderer, close } = ports();
            // A raw responder: the renderer process is not trusted to send a well-formed result.
            const answer = (event: { data: unknown }) => renderer.postMessage({ id: (event.data as { id: number }).id, ok: true, value });
            renderer.addEventListener("message", answer);
            renderer.start?.();
            const stop = () => renderer.removeEventListener("message", answer);
            const remote = createRemoteRasterizer(main);
            if (value === good) await expect(remote.rasterize(job)).resolves.toMatchObject({ id: job.id, width: 4 });
            else await expect(remote.rasterize(job), JSON.stringify(value)).rejects.toThrow("invalid raster result");
            remote.close();
            stop();
            close();
        }
    });

    it("checks graphics sequences against their job (one PNG per entry, same frame and size)", async () => {
        const job = {
            kind: "graphics" as const, id: "graphics-g", clipId: "g", templateId: "lower-third", propsJson: null, startTime: 0, endTime: 1,
            width: 4, height: 4, firstFrame: 3, frames: [null, null], scale: 1 as const,
        };
        const png = new Uint8Array([1]);
        const good = { id: job.id, png, width: 4, height: 4, boxWidth: 4, boxHeight: 4, pad: 0, scale: 1, sequence: [png, png], firstFrame: 3 };
        const bad: Record<string, unknown>[] = [
            { ...good, sequence: [png] },
            { ...good, sequence: [png, "x"] },
            { ...good, sequence: undefined },
            { ...good, firstFrame: 0 },
            { ...good, width: 8 },
            { ...good, missingAssets: [5] },
            { ...good, missingAssets: "x" },
        ];
        for (const value of [good, ...bad]) {
            const { main, renderer, close } = ports();
            const answer = (event: { data: unknown }) => renderer.postMessage({ id: (event.data as { id: number }).id, ok: true, value });
            renderer.addEventListener("message", answer);
            renderer.start?.();
            const remote = createRemoteRasterizer(main);
            if (value === good) await expect(remote.rasterize(job)).resolves.toMatchObject({ id: job.id, firstFrame: 3 });
            else await expect(remote.rasterize(job), JSON.stringify(value)).rejects.toThrow("invalid raster result");
            remote.close();
            renderer.removeEventListener("message", answer);
            close();
        }
    });

    it("rejects GL frames of the wrong length", async () => {
        const { main, renderer, close } = ports();
        const stop = serveGlFrameProcessor(renderer, { process: async () => new Uint8Array(3) });
        const remote = createRemoteGlFrameProcessor(main);
        await expect(remote.process({ data: new Uint8Array(4), width: 1, height: 1, time: 0 }, [])).rejects.toThrow("invalid GL frame");
        remote.dispose?.();
        stop();
        close();
    });

    it("ignores malformed replies instead of throwing in the main process", async () => {
        const { main, renderer, close } = ports();
        const remote = createRemoteRasterizer(main);
        const job = remote.rasterize({ kind: "emoji", id: "emoji-e", clipId: "e", text: "★", scale: 1, frameScale: 1 });
        const errors: unknown[] = [];
        const onError = (error: unknown) => errors.push(error);
        process.on("uncaughtException", onError);
        renderer.postMessage(null);
        renderer.postMessage("nope");
        renderer.postMessage({ id: "0", ok: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        process.off("uncaughtException", onError);
        expect(errors).toEqual([]);
        renderer.postMessage({ id: 0, ok: false, message: "boom" });
        await expect(job).rejects.toThrow("boom");
        remote.close();
        close();
    });
});
