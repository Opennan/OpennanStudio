// Optional Remotion add-on registration. An add-on (custom-code graphics through Remotion) calls
// registerRemotionAddon(); without one, the built-in graphics renderer (phase 10d) draws the built-in templates.
import type { ComponentType } from "react";
import type { TimelineClip } from "@opennan/timeline-core";

// Template metadata shape from SRC/remotion/template-registry.ts:9-26.
export interface TemplateParam {
    key: string;
    label: string;
    type: "text" | "color" | "number" | "select" | "json";
    default: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

export interface TemplateDef {
    id: string;
    name: string;
    category: string;
    description: string;
    params: TemplateParam[];
}

/** Live drag override, from SRC/components/editor/remotion-clip-layer.tsx:23-28. */
export interface RemotionTransformOverride {
    clipId: string;
    positionX?: number;
    positionY?: number;
    scale?: number;
    /** Base rotation in degrees (phase 10c). */
    rotation?: number;
}

export interface RemotionOverlayProps {
    clips: TimelineClip[];
    playing: boolean;
    projectRatio: number; // width / height (SRC/components/editor/remotion-clip-layer.tsx:208)
    transformOverride?: RemotionTransformOverride | null;
    /**
     * Phase 10c: the layer style of a clip at a timeline time (the shared motion model: keyframes, animations, rotation,
     * opacity, and the live drag). Overlays apply it to each clip's full-frame layer (`data-remotion-clip-id`).
     */
    layerStyle?(clip: TimelineClip, timelineSeconds: number): { transform: string; opacity: number; transformOrigin: string };
}

export interface RemotionAddon {
    templates: TemplateDef[];
    fps?: number;
    TimelineOverlay?: ComponentType<RemotionOverlayProps>;
}

let addon: RemotionAddon | null = null;

export function registerRemotionAddon(next: RemotionAddon): () => void {
    addon = next;
    return () => {
        if (addon === next) addon = null;
    };
}

export function getRemotionAddon(): RemotionAddon | null {
    return addon;
}
