// Files seeded from opennan/frontend/src into packages/timeline-media.
// Each entry: [sourcePathUnderFrontendSrc, destPathUnderPackageRoot].
export const PACKAGE_NAME = "@opennan/timeline-media";

const C = "components/editor/timeline/canvas";

export const FILES = [
    [`${C}/thumbnail-generator.ts`, "src/thumbnail-generator.ts"],
    [`${C}/thumbnail-generator.test.ts`, "src/thumbnail-generator.test.ts"],
    [`${C}/webcodecs-frame-source.ts`, "src/webcodecs-frame-source.ts"],
    [`${C}/webcodecs-frame-source.test.ts`, "src/webcodecs-frame-source.test.ts"],
    [`${C}/waveform-generator.ts`, "src/waveform-generator.ts"],
    ["lib/audio-duration.ts", "src/audio-duration.ts"],
    ["lib/audio-duration.test.ts", "src/audio-duration.test.ts"],
    ["lib/local-db.ts", "src/dexie/local-db.ts"],
    ["lib/timeline-local-store.ts", "src/dexie/timeline-local-store.ts"],
    ["lib/effect-renderer.ts", "src/effects/effect-renderer.ts"],
    ["lib/effect-renderer.test.ts", "src/effects/effect-renderer.test.ts"],
    ["lib/effect-layer-prep.ts", "src/effects/effect-layer-prep.ts"],
];

export const RULES = {
    "@/hooks/use-timeline": "@opennan/timeline-core/model/timeline",
    "@/lib/effects-api": "@opennan/timeline-core/model/effects",
};
