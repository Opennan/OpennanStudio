// Resizable editor panels: library and inspector widths, timeline height. Clamped, persisted per browser
// (localStorage "opennan-studio:layout"), reset by double-clicking a splitter.
export interface EditorLayout {
    library: number;
    inspector: number;
    timeline: number;
}

export const DEFAULT_LAYOUT: EditorLayout = { library: 300, inspector: 320, timeline: 300 };
export const LAYOUT_LIMITS: Record<keyof EditorLayout, [number, number]> = {
    library: [220, 520],
    inspector: [260, 480],
    timeline: [180, 640],
};
export const LAYOUT_STORAGE_KEY = "opennan-studio:layout";

export function clampLayout(layout: Partial<EditorLayout>): EditorLayout {
    const out = { ...DEFAULT_LAYOUT };
    for (const key of Object.keys(LAYOUT_LIMITS) as Array<keyof EditorLayout>) {
        const value = Number(layout[key]);
        const [min, max] = LAYOUT_LIMITS[key];
        out[key] = Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : DEFAULT_LAYOUT[key];
    }
    return out;
}

export function loadLayout(storage: Pick<Storage, "getItem"> | null = safeStorage()): EditorLayout {
    try {
        const raw = storage?.getItem(LAYOUT_STORAGE_KEY);
        return clampLayout(raw ? JSON.parse(raw) : {});
    } catch {
        return { ...DEFAULT_LAYOUT };
    }
}

export function saveLayout(layout: EditorLayout, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
    try {
        storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
        /* storage full or blocked: the layout just is not remembered */
    }
}

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

/** The new size after a drag of `delta` px (direction +1 grows with positive deltas, -1 shrinks). */
export function resizeBy(layout: EditorLayout, key: keyof EditorLayout, delta: number, direction: 1 | -1): EditorLayout {
    return clampLayout({ ...layout, [key]: layout[key] + delta * direction });
}
