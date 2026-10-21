// Files copied from opennan/frontend/src into packages/timeline-core.
// Each entry: [sourcePathRelativeToFrontendSrc, destPathRelativeToPackageRoot].

const T = "components/editor/timeline";

const ENGINE = ["layout", "move", "persist", "ripple", "types", "viewport"];
const ENGINE_TESTS = ["layout", "move", "persist", "ripple", "viewport"];

const CANVAS = [
    "timeline-renderer", "hit-detector", "snap-engine", "drag-controller", "multi-select",
    "transition-markers", "scene-position", "colors", "clip-render-cache",
    "timeline-json-cache", "canvas-timeline-utils", "types",
];
const CANVAS_TESTS = [
    "timeline-renderer", "hit-detector", "snap-engine", "drag-controller", "multi-select",
    "transition-markers", "clip-render-cache", "timeline-json-cache", "media-drop-ghost",
];

const LIB = [
    "timeline-editing", "timeline-editing-operations", "timeline-editing-properties",
    "timeline-editing-navigation", "timeline-editing-shared", "timeline-text-style",
    "timeline-animation-presets", "timeline-tracks", "timeline-commits", "timeline-history",
    "local-timeline-history", "timeline-sync-queue", "shot-utils", "keyframe-interpolation",
    "preview-text-layout", "local-export",
    "subtitle-import", "local-scene-history", "color-input", "ai-reference-urls",
    "preview-timeline-clips",
];
const LIB_TESTS = [
    "timeline-animation-presets", "timeline-commits", "timeline-editing-audio-visual",
    "timeline-editing-clipboard-keyframes", "timeline-editing-nudge-paste",
    "timeline-editing-range-selection", "timeline-editing-selection-markers",
    "timeline-history", "timeline-sync-queue", "timeline-tracks", "local-timeline-history",
    "shot-utils", "keyframe-interpolation", "preview-text-layout", "local-export",
    "subtitle-import", "local-scene-history", "color-input", "ai-reference-urls",
    "preview-timeline-clips",
];

export const FILES = [
    ...ENGINE.map((n) => [`${T}/engine/${n}.ts`, `src/timeline/engine/${n}.ts`]),
    ...ENGINE_TESTS.map((n) => [`${T}/engine/${n}.test.ts`, `src/timeline/engine/${n}.test.ts`]),
    ...CANVAS.map((n) => [`${T}/canvas/${n}.ts`, `src/timeline/canvas/${n}.ts`]),
    ...CANVAS_TESTS.map((n) => [`${T}/canvas/${n}.test.ts`, `src/timeline/canvas/${n}.test.ts`]),
    [`${T}/nle-timeline-layout.ts`, "src/timeline/nle-timeline-layout.ts"],
    ...LIB.map((n) => [`lib/${n}.ts`, `src/lib/${n}.ts`]),
    ...LIB_TESTS.map((n) => [`lib/${n}.test.ts`, `src/lib/${n}.test.ts`]),
    [`${T}/nle-timeline-layout.test.ts`, "src/timeline/nle-timeline-layout.test.ts"],
    [`${T}/timeline-workflow-usercases.test.ts`, "src/timeline/timeline-workflow-usercases.test.ts"],
];

export const DOCS = [[`${T}/TIMELINE_RULES.md`, "TIMELINE_RULES.md"]];

// Global alias rules: specifier -> package-root-relative target.
export const RULES = {
    "@/hooks/use-timeline": "src/model/timeline.ts",
    "@/stores/editor-store": "src/model/editor.ts",
};

// Per-file rules for relative imports that pointed at app-coupled modules.
export const LOCAL_RULES = {
    "src/timeline/canvas/transition-markers.ts": { "../nle-timeline-utils": "src/timeline/scene-timing.ts" },
    "src/lib/timeline-sync-queue.ts": { "./local-db": "src/lib/sync-queue-types.ts" },
    "src/lib/preview-timeline-clips.ts": {
        "@/lib/local-media-path": "src/lib/media-url-path.ts",
        "@/lib/preview-media-url": "src/lib/media-url-path.ts",
    },
};

// Files edited inside the package after import (phase 2). import-core skips them,
// so re-running the import never reverts package-side changes.
export const FORKED = new Set([
    "src/timeline/canvas/colors.ts",
    "src/timeline/canvas/timeline-renderer.ts",
    "src/timeline/nle-timeline-layout.test.ts",
    "src/timeline/timeline-workflow-usercases.test.ts",
    "src/lib/preview-timeline-clips.ts",
]);
