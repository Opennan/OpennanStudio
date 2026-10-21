// Files seeded from opennan/frontend/src into packages/timeline-react.
// Each entry: [sourcePathUnderFrontendSrc, destPathUnderPackageRoot].
export const PACKAGE_NAME = "@opennan/timeline-react";

const T = "components/editor/timeline";
const E = "components/editor";

export const FILES = [
    // 2c foundations
    ["hooks/use-document-visible.ts", "src/hooks/use-document-visible.ts"],
    ["hooks/use-document-visible.test.tsx", "src/hooks/use-document-visible.test.tsx"],
    ["lib/utils.ts", "src/ui/cn.ts"],
    ["components/ui/button.tsx", "src/ui/button.tsx"],
    ["components/ui/tooltip.tsx", "src/ui/tooltip.tsx"],
    ["components/ui/dropdown-menu.tsx", "src/ui/dropdown-menu.tsx"],
    ["components/ui/dialog.tsx", "src/ui/dialog.tsx"],
    ["components/ui/slider.tsx", "src/ui/slider.tsx"],
    [`${E}/scene-properties/properties-step-card.tsx`, "src/ui/properties-step-card.tsx"],
    // 2d small parts
    [`${T}/track-label.tsx`, "src/parts/track-label.tsx"],
    [`${T}/track-volume-control.tsx`, "src/parts/track-volume-control.tsx"],
    [`${T}/add-track-button.tsx`, "src/parts/add-track-button.tsx"],
    [`${T}/add-track-button.test.tsx`, "src/parts/add-track-button.test.tsx"],
    [`${T}/sticker-picker.tsx`, "src/parts/sticker-picker.tsx"],
    [`${T}/timeline-error-boundary.tsx`, "src/parts/timeline-error-boundary.tsx"],
    [`${T}/canvas/canvas-context-menu.tsx`, "src/timeline/canvas/canvas-context-menu.tsx"],
    // 2d canvas timeline
    [`${T}/canvas/canvas-timeline.tsx`, "src/timeline/canvas/canvas-timeline.tsx"],
    [`${T}/canvas/canvas-timeline.selection.test.tsx`, "src/timeline/canvas/canvas-timeline.selection.test.tsx"],
    [`${T}/canvas/canvas-timeline.dragdrop.test.tsx`, "src/timeline/canvas/canvas-timeline.dragdrop.test.tsx"],
    // 2d NLE timeline
    [`${T}/nle-timeline.tsx`, "src/timeline/nle-timeline.tsx"],
    [`${T}/nle-timeline-utils.ts`, "src/timeline/nle-timeline-utils.ts"],
    [`${T}/nle-timeline-deselect.test.tsx`, "src/timeline/nle-timeline-deselect.test.tsx"],
    [`${T}/nle-timeline-audio-drop.test.tsx`, "src/timeline/nle-timeline-audio-drop.test.tsx"],
    [`${T}/nle-timeline-effect-drop.test.tsx`, "src/timeline/nle-timeline-effect-drop.test.tsx"],
    [`${T}/nle-timeline-transition-drop.test.tsx`, "src/timeline/nle-timeline-transition-drop.test.tsx"],
    [`${T}/nle-timeline-scene-split.test.tsx`, "src/timeline/nle-timeline-scene-split.test.tsx"],
    // 2d clip properties
    [`${T}/clip-properties.tsx`, "src/clip-properties/clip-properties.tsx"],
    [`${T}/clip-properties-remotion.ts`, "src/clip-properties/clip-properties-remotion.ts"],
    // Seeded, then stripped to its 8 pure buildRemotionParamControls tests (Task 32 P0).
    [`${T}/clip-properties.test.ts`, "src/clip-properties/clip-properties.test.ts"],
    [`${E}/effects/effect-param-panel.tsx`, "src/clip-properties/effect-param-panel.tsx"],
    ["hooks/use-effect-catalog.ts", "src/hooks/use-effect-catalog.ts"],
    ["hooks/use-effect-catalog.test.ts", "src/hooks/use-effect-catalog.test.ts"],
    // 2e preview
    ["hooks/use-video-cache.ts", "src/hooks/use-video-cache.ts"],
    [`${E}/preview-screen-frame.ts`, "src/preview/preview-screen-frame.ts"],
    [`${E}/preview-screen-frame.test.ts`, "src/preview/preview-screen-frame.test.ts"],
    [`${E}/remotion-content-bounds.ts`, "src/preview/remotion-content-bounds.ts"],
    [`${E}/remotion-content-bounds.test.ts`, "src/preview/remotion-content-bounds.test.ts"],
    [`${E}/effects/effect-layer-overlay.tsx`, "src/preview/effect-layer-overlay.tsx"],
    [`${E}/preview-panel.tsx`, "src/preview/preview-panel.tsx"],
    [`${E}/scene-preview.tsx`, "src/preview/scene-preview.tsx"],
    [`${E}/scene-preview.behavior.test.tsx`, "src/preview/scene-preview.behavior.test.tsx"],
];

// App modules replaced by package code. "@/x" keys also match relative imports of x.
export const RULES = {
    "@/hooks/use-timeline": "@opennan/timeline-core/model/timeline",
    "@/components/editor/remotion-clip-layer": "src/remotion/remotion-layer.tsx",
};

// Bare packages replaced by package code (rewritten only in import/mock contexts).
export const BARE_RULES = {};
