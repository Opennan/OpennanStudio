// Field-level deltas between two server-space documents (codec.ts). A field change keeps its value before ("b") and
// after ("a"); a missing key means "absent". A column missing from the later document is "left as it is" (the write
// could not send it and kept the exact value in extras); an extras field ("x.…") missing is removed. Deltas merge
// (oldest before, newest after), rebase onto a newer server document (the later writer wins per field, a delete
// beats an edit, a patch of a row deleted elsewhere becomes a conflict), and undo field by field.
import { isExtrasField, type Fields, type ServerDoc } from "./codec";
import { clone, same, type Json } from "./json";

export interface FieldChange {
    b?: Json;
    a?: Json;
}

export interface EntityDelta {
    op: "create" | "patch" | "delete";
    fields: Record<string, FieldChange>;
}

export interface Delta {
    entities: Record<string, EntityDelta>;
}

export interface RebaseConflict {
    key: string;
    reason: "deleted";
}

export function emptyDelta(): Delta {
    return { entities: {} };
}

export function isEmptyDelta(delta: Delta): boolean {
    return Object.keys(delta.entities).length === 0;
}

function sameChange(x: FieldChange, y: FieldChange): boolean {
    return ("a" in x) === ("a" in y) && (!("a" in x) || same(x.a, y.a));
}

function patchFields(before: Fields, after: Fields): Record<string, FieldChange> {
    const fields: Record<string, FieldChange> = {};
    for (const [name, value] of Object.entries(after)) {
        if (name in before && same(before[name], value)) continue;
        fields[name] = name in before ? { b: clone(before[name]!), a: clone(value) } : { a: clone(value) };
    }
    for (const [name, value] of Object.entries(before)) {
        if (!(name in after) && isExtrasField(name)) fields[name] = { b: clone(value) };
    }
    return fields;
}

export function diffEntity(before: Fields | undefined, after: Fields | undefined): EntityDelta | null {
    if (!before && !after) return null;
    if (!before) return { op: "create", fields: Object.fromEntries(Object.entries(after!).map(([k, v]) => [k, { a: clone(v) }])) };
    if (!after) return { op: "delete", fields: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, { b: clone(v) }])) };
    const fields = patchFields(before, after);
    return Object.keys(fields).length > 0 ? { op: "patch", fields } : null;
}

export function diffDocs(before: ServerDoc, after: ServerDoc, keys?: Iterable<string>): Delta {
    const delta = emptyDelta();
    const all = keys ? new Set(keys) : new Set([...Object.keys(before.entities), ...Object.keys(after.entities)]);
    for (const key of all) {
        const change = diffEntity(before.entities[key], after.entities[key]);
        if (change) delta.entities[key] = change;
    }
    return delta;
}

function applyFields(target: Fields, fields: Record<string, FieldChange>): void {
    for (const [name, change] of Object.entries(fields)) {
        if ("a" in change) target[name] = clone(change.a!);
        else delete target[name];
    }
}

/** `doc` with `delta` applied as it is (no rebase rules): what a server holding `doc` would hold after it. */
export function applyDelta(doc: ServerDoc, delta: Delta): ServerDoc {
    const entities = { ...doc.entities };
    for (const [key, change] of Object.entries(delta.entities)) {
        if (change.op === "delete") {
            delete entities[key];
            continue;
        }
        const target = change.op === "create" ? {} : { ...(entities[key] ?? {}) };
        applyFields(target, change.fields);
        entities[key] = target;
    }
    return { ...doc, entities };
}

function mergeFields(into: Record<string, FieldChange>, next: Record<string, FieldChange>): void {
    for (const [name, change] of Object.entries(next)) {
        const old = into[name];
        if (!old) {
            into[name] = clone(change);
            continue;
        }
        const merged: FieldChange = {};
        if ("b" in old) merged.b = old.b;
        if ("a" in change) merged.a = clone(change.a!);
        into[name] = merged;
    }
}

function dropNoops(fields: Record<string, FieldChange>): void {
    for (const [name, change] of Object.entries(fields)) {
        const before: FieldChange = "b" in change ? { a: change.b! } : {};
        if (sameChange(before, change)) delete fields[name];
    }
}

/** One delta with the effect of `deltas` applied in order. */
export function mergeDeltas(deltas: Delta[]): Delta {
    const out = emptyDelta();
    for (const delta of deltas) {
        for (const [key, change] of Object.entries(delta.entities)) {
            const old = out.entities[key];
            if (!old) {
                out.entities[key] = clone(change);
                continue;
            }
            if (old.op === "create") {
                if (change.op === "delete") delete out.entities[key];
                else if (change.op === "patch") mergeFields(old.fields, change.fields);
                else out.entities[key] = clone(change);
                continue;
            }
            if (old.op === "delete") {
                if (change.op === "create") {
                    // Deleted then made again before anything was sent: a patch from the old row to the new.
                    const fields: Record<string, FieldChange> = {};
                    for (const [name, value] of Object.entries(old.fields)) fields[name] = { b: value.b! };
                    for (const [name, value] of Object.entries(change.fields)) fields[name] = name in fields ? { b: fields[name]!.b!, a: clone(value.a!) } : { a: clone(value.a!) };
                    for (const [name, value] of Object.entries(fields)) if (!("a" in value) && !isExtrasField(name)) delete fields[name];
                    dropNoops(fields);
                    if (Object.keys(fields).length > 0) out.entities[key] = { op: "patch", fields };
                    else delete out.entities[key];
                }
                continue;
            }
            // old is a patch
            if (change.op === "delete") {
                const fields: Record<string, FieldChange> = {};
                for (const [name, value] of Object.entries(change.fields)) fields[name] = { b: name in old.fields && "b" in old.fields[name]! ? old.fields[name]!.b! : value.b! };
                for (const [name, value] of Object.entries(old.fields)) if (!(name in fields) && "b" in value) fields[name] = { b: value.b! };
                out.entities[key] = { op: "delete", fields };
            } else if (change.op === "patch") {
                mergeFields(old.fields, change.fields);
                dropNoops(old.fields);
                if (Object.keys(old.fields).length === 0) delete out.entities[key];
            } else {
                out.entities[key] = clone(change);
            }
        }
    }
    return out;
}

export function invertDelta(delta: Delta): Delta {
    const out = emptyDelta();
    for (const [key, change] of Object.entries(delta.entities)) {
        const fields: Record<string, FieldChange> = {};
        for (const [name, value] of Object.entries(change.fields)) {
            const inverse: FieldChange = {};
            if ("a" in value) inverse.b = value.a;
            if ("b" in value) inverse.a = value.b;
            fields[name] = inverse;
        }
        out.entities[key] = { op: change.op === "create" ? "delete" : change.op === "delete" ? "create" : "patch", fields };
    }
    return out;
}

/**
 * `confirmed` (the server's newest document) with `pending` re-applied: each pending field keeps its value (the later
 * writer wins), a patch of a row that is gone is dropped as a conflict, a delete of a row already gone is dropped,
 * and a delete still deletes a row the server edited. Pending befores are taken from the new server state.
 */
export function rebase(confirmed: ServerDoc, pending: Delta[]): { doc: ServerDoc; pending: Delta[]; conflicts: RebaseConflict[] } {
    const entities: Record<string, Fields> = { ...confirmed.entities };
    const conflicts: RebaseConflict[] = [];
    const kept: Delta[] = [];
    for (const delta of pending) {
        const next = emptyDelta();
        for (const [key, change] of Object.entries(delta.entities)) {
            const current = entities[key];
            if (change.op === "delete") {
                if (!current) continue;
                next.entities[key] = { op: "delete", fields: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, { b: clone(v) }])) };
                delete entities[key];
                continue;
            }
            if (change.op === "patch" && !current) {
                conflicts.push({ key, reason: "deleted" });
                continue;
            }
            const fields: Record<string, FieldChange> = {};
            const target = current ? { ...current } : {};
            for (const [name, value] of Object.entries(change.fields)) {
                const rebased: FieldChange = current && name in current ? { b: clone(current[name]!) } : {};
                if ("a" in value) rebased.a = clone(value.a!);
                if (current && sameChange({ ...(name in current ? { a: current[name]! } : {}) }, rebased)) continue;
                if (!current && !("a" in value)) continue;
                fields[name] = rebased;
                if ("a" in value) target[name] = clone(value.a!);
                else delete target[name];
            }
            entities[key] = target;
            if (Object.keys(fields).length > 0 || !current) next.entities[key] = { op: current ? "patch" : "create", fields };
        }
        if (!isEmptyDelta(next)) kept.push(next);
    }
    return { doc: { ...confirmed, entities }, pending: kept, conflicts };
}

/**
 * Undo of one history entry on `current`: each field goes back to its before only where it still holds the entry's
 * after (another device's or an agent's later edit is kept and reported). A created row is deleted; a deleted row
 * is made again.
 */
export function undoDelta(current: ServerDoc, entry: Delta): { doc: ServerDoc; skipped: Array<{ key: string; field: string }> } {
    const entities = { ...current.entities };
    const skipped: Array<{ key: string; field: string }> = [];
    for (const [key, change] of Object.entries(entry.entities)) {
        const row = entities[key];
        if (change.op === "create") {
            if (row) delete entities[key];
            continue;
        }
        if (change.op === "delete") {
            if (!row) entities[key] = Object.fromEntries(Object.entries(change.fields).filter(([, v]) => "b" in v).map(([k, v]) => [k, clone(v.b!)]));
            continue;
        }
        if (!row) {
            skipped.push(...Object.keys(change.fields).map((field) => ({ key, field })));
            continue;
        }
        const target = { ...row };
        for (const [name, value] of Object.entries(change.fields)) {
            const holdsAfter = "a" in value ? name in row && same(row[name], value.a) : !(name in row);
            if (!holdsAfter) {
                skipped.push({ key, field: name });
                continue;
            }
            if ("b" in value) target[name] = clone(value.b!);
            else delete target[name];
        }
        entities[key] = target;
    }
    return { doc: { ...current, entities }, skipped };
}

/** Number of field changes in a delta (queue compaction, progress). */
export function deltaSize(delta: Delta): number {
    let count = 0;
    for (const change of Object.values(delta.entities)) count += Math.max(1, Object.keys(change.fields).length);
    return count;
}
