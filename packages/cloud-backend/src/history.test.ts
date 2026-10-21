import type { ServerDoc } from "./codec";
import type { Delta } from "./delta";
import { DeltaHistory } from "./history";

const doc = (start: number, label = "A"): ServerDoc => ({ revision: 1, entities: { "clip:a": { start_time: start, label } } });
const move = (from: number, to: number): Delta => ({ entities: { "clip:a": { op: "patch", fields: { start_time: { b: from, a: to } } } } });

describe("DeltaHistory", () => {
    it("undoes and redoes by entries, one per write call (an empty write is still a step)", () => {
        const history = new DeltaHistory(100);
        history.record(move(0, 1));
        history.record({ entities: {} });
        history.record(move(1, 2));
        expect(history.canUndo()).toBe(true);
        const undone = history.undo(doc(2), 2);
        expect(undone.doc.entities["clip:a"]!.start_time).toBe(1);
        expect(history.canRedo()).toBe(true);
        expect(history.undo(undone.doc, 1).doc.entities["clip:a"]!.start_time).toBe(0);
        const redone = history.redo(doc(0), 3);
        expect(redone.doc.entities["clip:a"]!.start_time).toBe(2);
        expect(history.canRedo()).toBe(false);
    });

    it("keeps fields edited elsewhere and says which", () => {
        const history = new DeltaHistory(100);
        history.record({ entities: { "clip:a": { op: "patch", fields: { start_time: { b: 0, a: 1 }, label: { b: "A", a: "B" } } } } });
        const result = history.undo({ revision: 2, entities: { "clip:a": { start_time: 1, label: "Remote" } } }, 1);
        expect(result.doc.entities["clip:a"]).toEqual({ start_time: 0, label: "Remote" });
        expect(result.skipped).toEqual([{ key: "clip:a", field: "label" }]);
    });

    it("a new write clears redo; the limit drops the oldest", () => {
        const history = new DeltaHistory(2);
        history.record(move(0, 1));
        history.record(move(1, 2));
        history.record(move(2, 3));
        expect(history.depth()).toEqual({ undo: 2, redo: 0 });
        history.undo(doc(3), 1);
        history.record(move(2, 5));
        expect(history.canRedo()).toBe(false);
    });

    it("rewrites a local media URL to its upload in every entry", () => {
        const history = new DeltaHistory(10);
        history.record({ entities: { "clip:a": { op: "create", fields: { media_url: { a: "opennan-local://media/x1" } } } } });
        history.rewrite((text) => text.replace("opennan-local://media/x1", "https://cdn.opennan.com/m.mp4"));
        const result = history.undo({ revision: 1, entities: { "clip:a": { media_url: "https://cdn.opennan.com/m.mp4" } } }, 1);
        expect(result.doc.entities["clip:a"]).toBeUndefined();
    });

    it("throws when there is nothing to undo or redo", () => {
        const history = new DeltaHistory(10);
        expect(() => history.undo(doc(0), 1)).toThrow("Nothing to undo");
        expect(() => history.redo(doc(0), 1)).toThrow("Nothing to redo");
    });
});
