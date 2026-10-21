// packages/timeline-core/src/design/summary.ts
// What an agent reads before editing: ids, texts, where things are, and which texts lost their lettering.
import { glyphLibrary, layoutText } from "./glyphs";
import { framesBounds, groupIds, groupMembers, layerBounds, layerFrame, type DesignBox, type LayerDesign } from "./model";

export interface LayerSummary {
    id: string;
    kind: "image" | "text";
    name?: string;
    group?: string;
    text?: string;
    lettering?: "original" | "glyphs" | "font";
    /** Characters the original lettering cannot draw (the text uses the font until they are redrawn). */
    missingGlyphs?: string[];
    bounds: DesignBox;
    visible: boolean;
    locked?: boolean;
}

export interface DesignSummary {
    size: { width: number; height: number };
    groups: { id: string; layers: string[]; bounds: DesignBox }[];
    layers: LayerSummary[];
}

const round = (b: DesignBox): DesignBox => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

export function describeDesign(design: LayerDesign): DesignSummary {
    const lib = glyphLibrary(design);
    return {
        size: { width: design.width, height: design.height },
        groups: groupIds(design).map((id) => {
            const members = groupMembers(design, id);
            return { id, layers: members.map((l) => l.id), bounds: round(framesBounds(members.map(layerFrame))) };
        }),
        layers: design.layers.map((l) => {
            const s: LayerSummary = { id: l.id, kind: l.kind, bounds: round(layerBounds(l)), visible: l.visible };
            if (l.name) s.name = l.name;
            if (l.group) s.group = l.group;
            if (l.locked) s.locked = true;
            if (l.kind === "text") {
                s.text = l.text;
                const out = layoutText(l, lib);
                s.lettering = out.mode;
                if (out.mode === "font" && out.missing.length) s.missingGlyphs = out.missing;
            }
            return s;
        }),
    };
}
