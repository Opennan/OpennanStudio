import { describe, expect, it, vi } from "vitest";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { drawClipWindow, type WindowSideDraw } from "./clip-window-draw";

/** A 2D context that records the calls this module makes, in order. */
function recorder(log: string[], name: string) {
    return {
        setTransform: (...args: number[]) => log.push(`${name}.setTransform(${args.join(",")})`),
        clearRect: (...args: number[]) => log.push(`${name}.clearRect(${args.join(",")})`),
        save: () => log.push(`${name}.save`),
        restore: () => log.push(`${name}.restore`),
        translate: (x: number, y: number) => log.push(`${name}.translate(${x},${y})`),
        rotate: (r: number) => log.push(`${name}.rotate(${r.toFixed(4)})`),
        set globalAlpha(value: number) { log.push(`${name}.alpha(${value})`); },
        drawImage: (source: { id?: string }, ...args: number[]) => log.push(`${name}.drawImage(${source.id ?? "?"},${args.join(",")})`),
    };
}

function layer(log: string[], name: string) {
    const ctx = recorder(log, name);
    return { width: 0, height: 0, id: name, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe("drawClipWindow", () => {
    const frame = { x: 10, y: 20, w: 160, h: 90 };
    const side = (log: string[], name: string, patch: Partial<WindowSideDraw["transform"]> = {}): WindowSideDraw => ({
        box: { w: 80, h: 45 },
        transform: { opacity: 1, scale: 1, scaleX: 1, posX: 0.5, posY: 0.5, dx: 0, dy: 0, rotation: 0, ...patch },
        paint: (_ctx, x, y, w, h) => log.push(`${name}.paint(${x},${y},${w},${h})`),
    });

    it("draws each clip with its placement on a clear frame-sized layer, blends the layers with the transition, and draws the result on the frame", () => {
        const log: string[] = [];
        const renderer = {
            isLost: false,
            canvas: { id: "gl" },
            upload: vi.fn((source: { id: string }, w: number, h: number) => { log.push(`upload(${source.id},${w},${h})`); return { id: source.id, width: w, height: h }; }),
            transition: vi.fn((a: { id: string }, b: { id: string }, def: { id: string }, p: number, channels: number) => { log.push(`transition(${a.id},${b.id},${def.id},${p},${channels})`); return { id: "out" }; }),
            // The shared canvas only grows: the frame sits in a region of it (bottom-left), drawn by source rect.
            presentRegion: vi.fn((_f: unknown, w: number, h: number) => { log.push(`presentRegion(${w},${h})`); return { x: 0, y: 20, width: w, height: h }; }),
            releaseAll: vi.fn(() => log.push("releaseAll")),
        } as unknown as LookRenderer;
        const target = recorder(log, "main") as unknown as CanvasRenderingContext2D;
        const ok = drawClipWindow(target, renderer, frame, 2, transitionById("wipe_left")!, 0.25,
            side(log, "A", { opacity: 0.5 }), side(log, "B", { rotation: 90, posX: 0 }), [layer(log, "LA"), layer(log, "LB")]);
        expect(ok).toBe(true);
        expect(log).toEqual([
            "LA.setTransform(1,0,0,1,0,0)", "LA.clearRect(0,0,320,180)", "LA.setTransform(2,0,0,2,-20,-40)",
            // A centred in the frame (posX 0.5 of the free space + half its width).
            "LA.save", "LA.translate(90,65)", "LA.alpha(0.5)", "A.paint(-40,-22.5,80,45)", "LA.restore",
            "LB.setTransform(1,0,0,1,0,0)", "LB.clearRect(0,0,320,180)", "LB.setTransform(2,0,0,2,-20,-40)",
            "LB.save", "LB.translate(50,65)", "LB.rotate(1.5708)", "LB.alpha(1)", "B.paint(-40,-22.5,80,45)", "LB.restore",
            "upload(LA,320,180)", "upload(LB,320,180)", "transition(LA,LB,wipe_left,0.25,4)", "presentRegion(320,180)",
            "main.drawImage(gl,0,20,320,180,10,20,160,90)", "releaseAll",
        ]);
    });

    it("reports failure (the caller draws the clip alone) when the renderer is lost or throws", () => {
        const log: string[] = [];
        const lost = { isLost: true } as unknown as LookRenderer;
        expect(drawClipWindow(recorder(log, "main") as unknown as CanvasRenderingContext2D, lost, frame, 1, transitionById("spin")!, 0.5, side(log, "A"), side(log, "B"), [layer(log, "LA"), layer(log, "LB")])).toBe(false);
        const broken = { isLost: false, upload: () => { throw new Error("gl"); }, releaseAll: vi.fn() } as unknown as LookRenderer;
        expect(drawClipWindow(recorder(log, "main") as unknown as CanvasRenderingContext2D, broken, frame, 1, transitionById("spin")!, 0.5, side(log, "A"), side(log, "B"), [layer(log, "LA"), layer(log, "LB")])).toBe(false);
        expect(log.some((entry) => entry.startsWith("main.drawImage"))).toBe(false);
    });
});
