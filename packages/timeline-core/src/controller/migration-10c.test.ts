// Phase 10c projects open unchanged in 10d: the same clips, masks, and legacy controls; graphics clips (which 10c
// could not draw) now draw from their stored template and props; text keeps no mask. The 10d edits — a mask on text,
// a group mask on text and a sticker, keyframes from motion tracking — round-trip through persistence, one undo step
// each. No new fields are stored (10d writes maskJson, keyframesJson, and the existing graphics props only).
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { graphicsLayerAt } from "../graphics/layer";
import { graphicsProps, isBuiltinGraphics } from "../graphics/render";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { itemLook } from "../looks/look-plan";
import { parseMask } from "../looks/masks";
import { createEditorStore } from "../store/editor-store";
import { TimelineController } from "./timeline-controller";
import phase10c from "./__fixtures__/phase10c-project.json";

async function seeded() {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("legacy10c", structuredClone(phase10c) as unknown as LocalProjectState);
    return persistence;
}

async function open(persistence: ReturnType<typeof createMemoryPersistence>) {
    const backend = new LocalBackend({ persistence });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "legacy10c", onToast: vi.fn() });
    await controller.load();
    const clip = (id: string) => store.getState().timelineData!.clips.find((c) => c.id === id)!;
    return { store, controller, clip };
}

describe("phase 10c projects in 10d", () => {
    it("open with the same clips, masks, and legacy controls; graphics draw from their stored props", async () => {
        const { store, clip } = await open(await seeded());
        const clips = store.getState().timelineData!.clips;
        expect(clips.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3", "c4", "g1", "t1"]);
        expect(parseMask(clip("c1").maskJson)).toMatchObject({ shape: "circle", width: 0.7, feather: 0.1 });
        expect(clip("c3")).toMatchObject({ blurStrength: 3, blendMode: "screen" });
        expect(clip("t1").maskJson ?? null).toBeNull();
        expect(itemLook({ kind: "clip", ...clip("t1") })).toBeNull();
        const graphic = clip("g1");
        expect(isBuiltinGraphics(graphic)).toBe(true);
        expect(graphicsProps(graphic)).toMatchObject({ name: "Ada Lovelace", barColor: "#e11d48", role: "Title, Company" });
        expect(graphicsLayerAt(graphic, 2)).toMatchObject({ rotation: 5, scale: 1, opacity: 1 });
    });

    it("round-trip a text mask, a group mask, and tracked keyframes through persistence, one undo step each", async () => {
        const persistence = await seeded();
        const first = await open(persistence);
        const steps = () => first.controller.historyDepth().recorded;
        let before = steps();
        expect((await first.controller.execute({ type: "mask.set", clipId: "t1", mask: { shape: "rectangle", width: 0.9, height: 0.5, roundness: 0.2 } })).ok).toBe(true);
        expect(steps()).toBe(before + 1);
        before = steps();
        expect((await first.controller.execute({ type: "mask.set", targets: [{ clipId: "t1" }, { clipId: "c2" }], mask: { feather: 0.25 } })).ok).toBe(true);
        expect(steps()).toBe(before + 1);
        before = steps();
        const samples = [0, 0.5, 1, 1.5].map((time, i) => ({ time, x: 0.5 + i * 0.05, y: 0.5, confidence: 1, lost: false }));
        const tracked = await first.controller.execute({ type: "tracking.apply", clipId: "c1", samples, followers: [{ clipId: "t1" }] });
        expect(tracked.ok).toBe(true);
        expect(steps()).toBe(before + 1);
        const trackedPoints = parseTimelineKeyframes(first.clip("t1").keyframesJson);
        expect(trackedPoints.length).toBeGreaterThanOrEqual(2);
        // One undo takes the tracked keyframes back, redo puts them again.
        await first.controller.execute({ type: "history.undo" });
        expect(first.clip("t1").keyframesJson ?? null).toBeNull();
        await first.controller.execute({ type: "history.redo" });
        expect(parseTimelineKeyframes(first.clip("t1").keyframesJson)).toEqual(trackedPoints);

        const second = await open(persistence);
        expect(parseMask(second.clip("t1").maskJson)).toMatchObject({ shape: "rectangle", width: 0.9, roundness: 0.2, feather: 0.25 });
        expect(parseMask(second.clip("c2").maskJson)).toMatchObject({ feather: 0.25 });
        expect(itemLook({ kind: "clip", ...second.clip("t1") })!.steps.map((s) => s.kind)).toEqual(["mask"]);
        expect(parseTimelineKeyframes(second.clip("t1").keyframesJson)).toEqual(trackedPoints);
    });
});
