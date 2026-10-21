import type { Fields, ServerDoc } from "./codec";
import { applyDelta, diffDocs, invertDelta, isEmptyDelta, mergeDeltas, rebase, undoDelta, type Delta } from "./delta";

const doc = (entities: Record<string, Fields>, revision = 1): ServerDoc => ({ revision, entities });

describe("diffDocs", () => {
    it("finds creates, deletes, and field patches; columns a write stopped sending are left alone", () => {
        const before = doc({ "clip:a": { start_time: 0, label: "A", "x.maskJson": "m" }, "clip:b": { start_time: 1 } });
        const after = doc({ "clip:a": { start_time: 2, "x.$x.label": "x".repeat(300) }, "clip:c": { start_time: 3 } });
        const delta = diffDocs(before, after);
        expect(delta.entities["clip:a"]).toEqual({ op: "patch", fields: { start_time: { b: 0, a: 2 }, "x.$x.label": { a: "x".repeat(300) }, "x.maskJson": { b: "m" } } });
        expect(delta.entities["clip:b"]).toEqual({ op: "delete", fields: { start_time: { b: 1 } } });
        expect(delta.entities["clip:c"]).toEqual({ op: "create", fields: { start_time: { a: 3 } } });
    });

    it("applies back to the target", () => {
        for (let seed = 1; seed < 60; seed++) {
            const a = randomDoc(seed);
            const b = randomDoc(seed * 7 + 3);
            const applied = applyDelta(a, diffDocs(a, b));
            for (const [key, fields] of Object.entries(b.entities)) {
                for (const [name, value] of Object.entries(fields)) expect(applied.entities[key]?.[name]).toEqual(value);
                for (const name of Object.keys(applied.entities[key] ?? {})) if (name.startsWith("x.")) expect(name in fields).toBe(true);
            }
            for (const key of Object.keys(applied.entities)) expect(key in b.entities).toBe(true);
        }
    });
});

describe("mergeDeltas", () => {
    it("keeps the oldest before and the newest after, cancels create+delete, and drops no-op fields", () => {
        const d1: Delta = { entities: { "clip:a": { op: "patch", fields: { start_time: { b: 0, a: 1 } } }, "clip:n": { op: "create", fields: { start_time: { a: 5 } } } } };
        const d2: Delta = { entities: { "clip:a": { op: "patch", fields: { start_time: { b: 1, a: 0 }, label: { b: "A", a: "B" } } }, "clip:n": { op: "delete", fields: { start_time: { b: 5 } } } } };
        expect(mergeDeltas([d1, d2])).toEqual({ entities: { "clip:a": { op: "patch", fields: { label: { b: "A", a: "B" } } } } });
        const d3: Delta = { entities: { "clip:n": { op: "patch", fields: { start_time: { b: 5, a: 6 } } } } };
        expect(mergeDeltas([d1, d3]).entities["clip:n"]).toEqual({ op: "create", fields: { start_time: { a: 6 } } });
        const d4: Delta = { entities: { "clip:a": { op: "delete", fields: { start_time: { b: 1 }, label: { b: "A" } } } } };
        expect(mergeDeltas([d1, d4]).entities["clip:a"]).toEqual({ op: "delete", fields: { start_time: { b: 0 }, label: { b: "A" } } });
        expect(isEmptyDelta(mergeDeltas([d1, invertDelta(d1)]))).toBe(true);
    });

    it("turns an unsent delete followed by a create of the same row into a patch", () => {
        const del: Delta = { entities: { "clip:a": { op: "delete", fields: { start_time: { b: 0 }, label: { b: "A" }, "x.k": { b: 1 } } } } };
        const create: Delta = { entities: { "clip:a": { op: "create", fields: { start_time: { a: 2 }, label: { a: "A" } } } } };
        expect(mergeDeltas([del, create]).entities["clip:a"]).toEqual({ op: "patch", fields: { start_time: { b: 0, a: 2 }, "x.k": { b: 1 } } });
    });
});

describe("rebase", () => {
    const pending: Delta[] = [
        { entities: { "clip:a": { op: "patch", fields: { start_time: { b: 0, a: 4 } } } } },
        { entities: { "clip:gone": { op: "patch", fields: { label: { b: "G", a: "H" } } } } },
        { entities: { "clip:alsogone": { op: "delete", fields: { start_time: { b: 1 } } } } },
        { entities: { "clip:edited": { op: "delete", fields: { label: { b: "E" } } } } },
        { entities: { "clip:new": { op: "create", fields: { start_time: { a: 9 } } } } },
    ];
    const server = doc({ "clip:a": { start_time: 2, label: "server" }, "clip:edited": { label: "E2" } }, 7);

    it("re-applies pending edits field by field: the later writer wins, a delete beats an edit", () => {
        const result = rebase(server, pending);
        expect(result.doc.revision).toBe(7);
        expect(result.doc.entities["clip:a"]).toEqual({ start_time: 4, label: "server" });
        expect(result.doc.entities["clip:edited"]).toBeUndefined();
        expect(result.doc.entities["clip:new"]).toEqual({ start_time: 9 });
        expect(result.conflicts).toEqual([{ key: "clip:gone", reason: "deleted" }]);
        // What is left to send, with befores taken from the new server state.
        const merged = mergeDeltas(result.pending);
        expect(merged.entities["clip:a"]).toEqual({ op: "patch", fields: { start_time: { b: 2, a: 4 } } });
        expect(merged.entities["clip:edited"]).toEqual({ op: "delete", fields: { label: { b: "E2" } } });
        expect(merged.entities["clip:gone"]).toBeUndefined();
        expect(merged.entities["clip:alsogone"]).toBeUndefined();
    });

    it("keeps a create whose row already landed as a patch", () => {
        const result = rebase(doc({ "clip:new": { start_time: 8 } }), [{ entities: { "clip:new": { op: "create", fields: { start_time: { a: 9 } } } } }]);
        expect(mergeDeltas(result.pending).entities["clip:new"]).toEqual({ op: "patch", fields: { start_time: { b: 8, a: 9 } } });
    });
});

describe("undoDelta", () => {
    it("restores only fields still holding the entry's after, and reports the others", () => {
        const entry: Delta = { entities: { "clip:a": { op: "patch", fields: { start_time: { b: 0, a: 1 }, label: { b: "A", a: "B" } } } } };
        const current = doc({ "clip:a": { start_time: 1, label: "C" } });
        const result = undoDelta(current, entry);
        expect(result.doc.entities["clip:a"]).toEqual({ start_time: 0, label: "C" });
        expect(result.skipped).toEqual([{ key: "clip:a", field: "label" }]);
    });

    it("undoes a create by deleting the row and a delete by making it again", () => {
        const created: Delta = { entities: { "clip:n": { op: "create", fields: { start_time: { a: 1 } } } } };
        expect(undoDelta(doc({ "clip:n": { start_time: 1 } }), created).doc.entities["clip:n"]).toBeUndefined();
        const deleted: Delta = { entities: { "clip:d": { op: "delete", fields: { start_time: { b: 3 }, "x.k": { b: true } } } } };
        expect(undoDelta(doc({}), deleted).doc.entities["clip:d"]).toEqual({ start_time: 3, "x.k": true });
    });
});

function randomDoc(seed: number): ServerDoc {
    let x = seed;
    const next = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const entities: Record<string, Fields> = {};
    for (const id of ["a", "b", "c", "d", "e"]) {
        if (next() < 0.3) continue;
        const fields: Fields = {};
        for (const name of ["start_time", "label", "x.mask", "x.$x.volume", "x.$u.trim_end"]) if (next() < 0.6) fields[name] = Math.round(next() * 3);
        entities[`clip:${id}`] = fields;
    }
    return doc(entities);
}
