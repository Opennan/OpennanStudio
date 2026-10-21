// packages/timeline-react/src/layer-editor/selection.ts
import { framesBounds, groupMembers, layerFrame, type DesignLayer, type LayerDesign, type LayerFrame } from "@opennan/timeline-core/design/model";

export type Selection = { kind: "group"; id: string } | { kind: "layer"; id: string };

export function selectionLayers(design: LayerDesign, sel: Selection | null): DesignLayer[] {
    if (!sel) return [];
    if (sel.kind === "group") return groupMembers(design, sel.id);
    const l = design.layers.find((x) => x.id === sel.id);
    return l ? [l] : [];
}

/** One layer keeps its rotated frame; a group gets the axis-aligned bounds of its members. */
export function selectionFrame(design: LayerDesign, sel: Selection | null): LayerFrame | null {
    const layers = selectionLayers(design, sel);
    if (!layers.length) return null;
    if (layers.length === 1) return layerFrame(layers[0]);
    const b = framesBounds(layers.map(layerFrame));
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rotation: 0 };
}

/** The op target of a selection. */
export function selectionTarget(sel: Selection): string {
    return sel.id;
}

/** What a click on `layer` selects. */
export function clickSelection(layer: DesignLayer): Selection {
    return layer.group ? { kind: "group", id: layer.group } : { kind: "layer", id: layer.id };
}
