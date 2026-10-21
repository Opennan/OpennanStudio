// packages/timeline-core/src/design/ops.ts
// The editing API of a layered design: the editor's gestures and the agent's edits are both op lists.
import { framesBounds, groupIds, layerFrame, type DesignLayer, type LayerDesign, type TextLayer, type TextStyle } from "./model";

export type DesignOp =
    | { op: "set_text"; target: string; text: string }
    | { op: "move"; target: string; dx?: number; dy?: number; x?: number; y?: number }
    | { op: "scale"; target: string; factor: number }
    | { op: "rotate"; target: string; degrees: number }
    | { op: "set_visible"; target: string; visible: boolean }
    | { op: "set_opacity"; target: string; opacity: number }
    | { op: "reorder"; target: string; to: "front" | "back" | "forward" | "backward" }
    | { op: "set_style"; target: string; style: Partial<TextStyle> & { lettering?: "auto" | "font" } };

export interface OpResult {
    index: number;
    ok: boolean;
    /** Layer ids the op changed. */
    layers?: string[];
    error?: string;
}

export interface ApplyResult {
    design: LayerDesign;
    results: OpResult[];
    changed: boolean;
}

class OpError extends Error {}

/** Layers a target names: a layer id, a group id, or the current text of a text layer. */
export function resolveTarget(design: LayerDesign, target: string): DesignLayer[] {
    const byId = design.layers.find((l) => l.id === target);
    if (byId) return [byId];
    const group = design.layers.filter((l) => l.group === target);
    if (group.length) return group;
    const byText = design.layers.filter((l) => l.kind === "text" && l.text === target);
    if (byText.length === 1) return byText;
    const editable = design.layers.filter((l) => !l.locked).map((l) => l.id);
    throw new OpError(`no layer, group or text "${target}"; groups: ${groupIds(design).join(", ") || "none"}; layers: ${editable.join(", ")}`);
}

function editable(layers: DesignLayer[]): DesignLayer[] {
    const locked = layers.find((l) => l.locked);
    if (locked) throw new OpError(`"${locked.id}" is locked`);
    return layers;
}

function finite(v: unknown, what: string): number {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new OpError(`${what} must be a number`);
    return v;
}

/** Scale and/or rotate layers as one block about the centre of their bounds. */
function transformAbout(layers: DesignLayer[], factor: number, degrees: number): void {
    const b = framesBounds(layers.map(layerFrame));
    const ox = b.x + b.w / 2, oy = b.y + b.h / 2;
    const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    for (const l of layers) {
        const f = layerFrame(l);
        const vx = (f.cx - ox) * factor, vy = (f.cy - oy) * factor;
        const nx = ox + vx * c - vy * s, ny = oy + vx * s + vy * c;
        l.transform.dx += nx - f.cx;
        l.transform.dy += ny - f.cy;
        l.transform.scale *= factor;
        l.transform.rotation += degrees;
    }
}

function reorder(design: LayerDesign, block: DesignLayer[], to: "front" | "back" | "forward" | "backward"): void {
    const ids = new Set(block.map((l) => l.id));
    const rest = design.layers.filter((l) => !ids.has(l.id));
    const firstIdx = design.layers.findIndex((l) => ids.has(l.id));
    // position of the block within `rest`, counted in layers below it
    let at = design.layers.slice(0, firstIdx).filter((l) => !ids.has(l.id)).length;
    const floor = rest.filter((l) => l.locked).length; // stay above locked layers (the background)
    if (to === "front") at = rest.length;
    else if (to === "back") at = floor;
    else if (to === "forward") at = Math.min(rest.length, at + 1);
    else at = Math.max(floor, at - 1);
    design.layers = [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

function applyOne(design: LayerDesign, op: DesignOp): string[] {
    const layers = editable(resolveTarget(design, op.target));
    switch (op.op) {
        case "set_text": {
            if (typeof op.text !== "string") throw new OpError("text must be a string");
            const t = layers.filter((l): l is TextLayer => l.kind === "text");
            if (t.length !== 1 || layers.length !== 1) {
                const img = layers.find((l) => l.kind !== "text");
                throw new OpError(img && layers.length === 1 ? `"${img.id}" is an image layer; set_text needs a text layer` : `"${op.target}" is a group; set_text needs one text layer: ${layers.filter((l) => l.kind === "text").map((l) => l.id).join(", ")}`);
            }
            t[0].text = op.text;
            return [t[0].id];
        }
        case "move": {
            let dx = op.dx === undefined ? 0 : finite(op.dx, "dx");
            let dy = op.dy === undefined ? 0 : finite(op.dy, "dy");
            if (op.x !== undefined || op.y !== undefined) {
                const b = framesBounds(layers.map(layerFrame));
                if (op.x !== undefined) dx = finite(op.x, "x") - (b.x + b.w / 2);
                if (op.y !== undefined) dy = finite(op.y, "y") - (b.y + b.h / 2);
            }
            for (const l of layers) {
                l.transform.dx += dx;
                l.transform.dy += dy;
            }
            return layers.map((l) => l.id);
        }
        case "scale": {
            if (typeof op.factor !== "number" || !(op.factor > 0) || !Number.isFinite(op.factor)) throw new OpError("factor must be a positive number");
            transformAbout(layers, op.factor, 0);
            return layers.map((l) => l.id);
        }
        case "rotate": {
            transformAbout(layers, 1, finite(op.degrees, "degrees"));
            return layers.map((l) => l.id);
        }
        case "set_visible":
            for (const l of layers) l.visible = Boolean(op.visible);
            return layers.map((l) => l.id);
        case "set_opacity": {
            const o = Math.min(1, Math.max(0, finite(op.opacity, "opacity")));
            for (const l of layers) l.opacity = o;
            return layers.map((l) => l.id);
        }
        case "reorder":
            if (!["front", "back", "forward", "backward"].includes(op.to)) throw new OpError('to must be "front", "back", "forward" or "backward"');
            reorder(design, layers, op.to);
            return layers.map((l) => l.id);
        case "set_style": {
            const t = layers.filter((l): l is TextLayer => l.kind === "text");
            if (!t.length) throw new OpError(`"${op.target}" has no text layer; set_style styles text`);
            const { lettering, ...style } = op.style ?? {};
            for (const l of t) {
                l.style = { ...l.style, ...style };
                if (lettering === "auto" || lettering === "font") l.lettering = lettering;
                // a font property only shows when the font draws the text
                else if (Object.keys(style).some((k) => k !== "shadow")) l.lettering = "font";
            }
            return t.map((l) => l.id);
        }
        default:
            throw new OpError(`unknown op "${(op as { op: unknown }).op}"`);
    }
}

export function applyDesignOps(design: LayerDesign, ops: readonly DesignOp[]): ApplyResult {
    const next: LayerDesign = structuredClone(design);
    const results: OpResult[] = [];
    ops.forEach((op, index) => {
        const before = JSON.stringify(next.layers);
        try {
            const layers = applyOne(next, op);
            results.push({ index, ok: true, layers });
        } catch (e) {
            if (!(e instanceof OpError)) throw e;
            next.layers = JSON.parse(before);
            results.push({ index, ok: false, error: e.message });
        }
    });
    const changed = JSON.stringify(next.layers) !== JSON.stringify(design.layers);
    return { design: changed ? next : design, results, changed };
}
