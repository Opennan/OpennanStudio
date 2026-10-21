// Pure timeline-engine types. The engine never sees SceneData/clips directly —
// the adapter maps them to EngineItem and back.

export interface EngineItem {
    id: string;
    trackId: string;      // "v1", "v2", "a1", "text1", …
    start: number;        // seconds, explicit — the single source of truth
    duration: number;     // seconds, > 0
    kind: "scene" | "clip";
}

export interface Viewport {
    pxPerSecond: number;
    scrollX: number;          // px
    viewportWidthPx: number;
}
