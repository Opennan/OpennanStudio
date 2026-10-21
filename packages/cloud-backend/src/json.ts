// JSON values and their canonical form: sorted keys, undefined dropped (as JSON.stringify does), so two values
// that mean the same thing compare equal however they were built.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonical(value: unknown): string {
    return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sortKeys(item)));
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) out[key] = sortKeys(item);
        }
        return out;
    }
    return value;
}

export function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    return canonical(a) === canonical(b);
}

export function clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Every string inside a JSON value (keys untouched) passed through `map`. */
export function mapStrings<T>(value: T, map: (text: string) => string): T {
    if (typeof value === "string") return map(value) as unknown as T;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const next = mapStrings(item, map);
            if (next !== item) changed = true;
            return next;
        });
        return (changed ? out : value) as unknown as T;
    }
    if (value !== null && typeof value === "object") {
        let changed = false;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const next = mapStrings(item, map);
            if (next !== item) changed = true;
            out[key] = next;
        }
        return (changed ? out : value) as T;
    }
    return value;
}
