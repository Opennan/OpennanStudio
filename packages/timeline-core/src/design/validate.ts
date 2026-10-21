// packages/timeline-core/src/design/validate.ts
// Parses a LayerDesign from untrusted JSON (a project file, an agent's arguments). Errors name the field,
// so an agent can fix its own input.
import { IDENTITY_TRANSFORM, LAYER_DESIGN_VERSION, type DesignBox, type DesignLayer, type LayerDesign, type LayerTransform } from "./model";

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
    throw new Error(`${path} ${what}`);
}
function obj(v: unknown, path: string): Obj {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(path, "must be an object");
    return v as Obj;
}
function num(v: unknown, path: string): number {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a number");
    return v;
}
function pos(v: unknown, path: string): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(path, "must be a positive number");
    return v;
}
function str(v: unknown, path: string): string {
    if (typeof v !== "string" || !v) fail(path, "must be a non-empty string");
    return v;
}
function optStr(v: unknown, path: string): string | undefined {
    return v === undefined ? undefined : str(v, path);
}

function box(v: unknown, path: string): DesignBox {
    const o = obj(v, path);
    return { x: num(o.x, `${path}.x`), y: num(o.y, `${path}.y`), w: pos(o.w, `${path}.w`), h: pos(o.h, `${path}.h`) };
}

function transform(v: unknown, path: string): LayerTransform {
    if (v === undefined) return { ...IDENTITY_TRANSFORM };
    const o = obj(v, path);
    return {
        dx: o.dx === undefined ? 0 : num(o.dx, `${path}.dx`),
        dy: o.dy === undefined ? 0 : num(o.dy, `${path}.dy`),
        scale: o.scale === undefined ? 1 : pos(o.scale, `${path}.scale`),
        rotation: o.rotation === undefined ? 0 : num(o.rotation, `${path}.rotation`),
    };
}

function layer(v: unknown, path: string): DesignLayer {
    const o = obj(v, path);
    const base = {
        id: str(o.id, `${path}.id`),
        name: optStr(o.name, `${path}.name`),
        group: optStr(o.group, `${path}.group`),
        box: box(o.box, `${path}.box`),
        transform: transform(o.transform, `${path}.transform`),
        opacity: o.opacity === undefined ? 1 : Math.min(1, Math.max(0, num(o.opacity, `${path}.opacity`))),
        visible: o.visible === undefined ? true : Boolean(o.visible),
        locked: o.locked === undefined ? undefined : Boolean(o.locked),
    };
    if (o.kind === "image") {
        const role = o.role;
        if (role !== undefined && role !== "background" && role !== "element" && role !== "shadow") fail(`${path}.role`, 'must be "background", "element" or "shadow"');
        return { ...base, kind: "image", src: str(o.src, `${path}.src`), role };
    }
    if (o.kind === "text") {
        const orig = obj(o.original, `${path}.original`);
        const s = obj(o.style, `${path}.style`);
        const word = orig.word === undefined ? undefined : (() => {
            const w = obj(orig.word, `${path}.original.word`);
            return { src: str(w.src, `${path}.original.word.src`), dx: num(w.dx, `${path}.original.word.dx`), dy: num(w.dy, `${path}.original.word.dy`), w: pos(w.w, `${path}.original.word.w`), h: pos(w.h, `${path}.original.word.h`) };
        })();
        const glyphs = orig.glyphs === undefined || orig.glyphs === null ? undefined : (Array.isArray(orig.glyphs) ? orig.glyphs : fail(`${path}.original.glyphs`, "must be an array")).map((g, i) => {
            const p = `${path}.original.glyphs[${i}]`;
            const c = obj(g, p);
            const cell = { ch: str(c.ch, `${p}.ch`), src: str(c.src, `${p}.src`), dx: num(c.dx, `${p}.dx`), dy: num(c.dy, `${p}.dy`), w: pos(c.w, `${p}.w`), h: pos(c.h, `${p}.h`) };
            if (c.ink === undefined) return cell;
            const ink = obj(c.ink, `${p}.ink`);
            return { ...cell, ink: { x: num(ink.x, `${p}.ink.x`), w: pos(ink.w, `${p}.ink.w`) } };
        });
        if (typeof o.text !== "string") fail(`${path}.text`, "must be a string");
        return {
            ...base,
            kind: "text",
            text: o.text,
            original: {
                text: typeof orig.text === "string" ? orig.text : fail(`${path}.original.text`, "must be a string"),
                word,
                glyphs,
                ...(orig.gap === undefined ? {} : { gap: num(orig.gap, `${path}.original.gap`) }),
            },
            style: {
                fill: str(s.fill, `${path}.style.fill`),
                stroke: optStr(s.stroke, `${path}.style.stroke`),
                strokeWidth: s.strokeWidth === undefined ? 0 : num(s.strokeWidth, `${path}.style.strokeWidth`),
                shadow: Boolean(s.shadow),
                font: str(s.font, `${path}.style.font`),
                weight: s.weight === undefined ? 700 : num(s.weight, `${path}.style.weight`),
                track: s.track === undefined ? 0 : num(s.track, `${path}.style.track`),
            },
            styleGroup: optStr(o.styleGroup, `${path}.styleGroup`),
            lettering: o.lettering === "font" ? "font" : "auto",
        };
    }
    fail(`${path}.kind`, 'must be "image" or "text"');
}

export function parseLayerDesign(json: unknown): LayerDesign {
    const o = obj(json, "design");
    if (o.version !== LAYER_DESIGN_VERSION) fail("design.version", `must be ${LAYER_DESIGN_VERSION}`);
    if (!Array.isArray(o.layers)) fail("design.layers", "must be an array");
    const layers = o.layers.map((l, i) => layer(l, `layers[${i}]`));
    const ids = new Set<string>();
    for (const l of layers) {
        if (ids.has(l.id)) throw new Error(`duplicate layer id "${l.id}"`);
        ids.add(l.id);
    }
    return { version: LAYER_DESIGN_VERSION, width: pos(o.width, "design.width"), height: pos(o.height, "design.height"), source: optStr(o.source, "design.source"), layers };
}
