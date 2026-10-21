import { describe, it, expect } from "vitest";
import { createLocalSceneHistory, sceneStateSignature, type SceneRow } from "./local-scene-history";

const scene = (id: string, pos: number, extra: Partial<SceneRow> = {}): SceneRow => ({
    id,
    order: 0,
    trackIndex: 1,
    timelinePositionSeconds: pos,
    duration: 5,
    ...extra,
});

describe("local scene history", () => {
    it("returns the previous state on undo and the newer one on redo", () => {
        const history = createLocalSceneHistory();
        history.record([scene("a", 0)]);
        history.record([scene("a", 10)]);

        expect(history.canUndo()).toBe(true);
        expect(history.undo()?.[0].timelinePositionSeconds).toBe(0);
        expect(history.canUndo()).toBe(false);
        expect(history.redo()?.[0].timelinePositionSeconds).toBe(10);
    });

    it("ignores a re-record of the state at the cursor", () => {
        // The server refetch that lands after an undo replays the state we just
        // restored — recording it would push a duplicate entry and make the
        // next Ctrl+Z a no-op.
        const history = createLocalSceneHistory();
        history.record([scene("a", 0)]);
        history.record([scene("a", 10)]);
        history.undo();

        expect(history.record([scene("a", 0)])).toBe(false);
        expect(history.size()).toBe(2);
        expect(history.canRedo()).toBe(true);
    });

    it("drops the redo tail once a fresh edit is recorded", () => {
        const history = createLocalSceneHistory();
        history.record([scene("a", 0)]);
        history.record([scene("a", 10)]);
        history.undo();
        history.record([scene("a", 20)]);

        expect(history.canRedo()).toBe(false);
        expect(history.undo()?.[0].timelinePositionSeconds).toBe(0);
    });

    it("walks multiple steps at once", () => {
        const history = createLocalSceneHistory();
        history.record([scene("a", 0)]);
        history.record([scene("a", 1)]);
        history.record([scene("a", 2)]);
        history.record([scene("a", 3)]);

        expect(history.undo(3)?.[0].timelinePositionSeconds).toBe(0);
        expect(history.redo(2)?.[0].timelinePositionSeconds).toBe(2);
    });

    it("clamps instead of overshooting at the ends", () => {
        const history = createLocalSceneHistory();
        history.record([scene("a", 0)]);
        history.record([scene("a", 1)]);

        expect(history.undo(50)?.[0].timelinePositionSeconds).toBe(0);
        expect(history.undo()).toBeNull();
        expect(history.redo(50)?.[0].timelinePositionSeconds).toBe(1);
        expect(history.redo()).toBeNull();
    });

    it("keeps entries bounded", () => {
        const history = createLocalSceneHistory(5);
        for (let i = 0; i < 20; i += 1) history.record([scene("a", i)]);
        expect(history.size()).toBe(5);
    });

    it("signature tracks scene identity, add/remove, and edited fields only", () => {
        const base = [scene("a", 0), scene("b", 5)];
        expect(sceneStateSignature(base)).toBe(sceneStateSignature([scene("a", 0), scene("b", 5)]));
        expect(sceneStateSignature(base)).not.toBe(sceneStateSignature([scene("a", 0)]));
        expect(sceneStateSignature(base)).not.toBe(sceneStateSignature([scene("a", 2), scene("b", 5)]));
        // Generation churn (status/media urls) must not read as a user edit.
        expect(sceneStateSignature([scene("a", 0, { videoUrl: "x", status: "ready" })]))
            .toBe(sceneStateSignature([scene("a", 0)]));
    });
});
