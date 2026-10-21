// Masks in the ffmpeg look chain (phase 10c): graph shape only; pixels are checked in parity/masks.parity.test.ts.
import { describe, expect, it } from "vitest";
import { itemLook } from "@opennan/timeline-core/looks/look-plan";
import type { CompileContext } from "../compile/context";
import { FilterGraph } from "../graph";
import { gplFiltersIn } from "../lgpl-filters";
import { resolveOutputFormat } from "../presets";
import { applyLook } from "./look-filters";

const circle = '{"shape":"circle","x":0.4,"width":0.5,"height":0.5,"feather":0.2}';
const keyed = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 1, mask_x: 0.8, easing: 3 }] });

function context(): CompileContext {
    return { graph: new FilterGraph(), format: resolveOutputFormat("16:9", "720p"), duration: 2, media: new Map(), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
}

describe("applyLook with a mask", () => {
    it("a static mask is a generated gray image merged as the alpha of an opaque item (no geq)", () => {
        const ctx = context();
        const out = applyLook(ctx, "0:v", itemLook({ kind: "scene", maskJson: circle }), { width: 96, height: 54, alpha: false, duration: 2 });
        const graph = ctx.graph.toString();
        expect(ctx.files).toHaveLength(1);
        expect(ctx.files[0].name).toMatch(/^mask-\d+\.png$/);
        // PNG signature, gray 96×54.
        expect([...ctx.files[0].data.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
        expect(graph).toContain("alphamerge");
        expect(graph).toContain(`[${out}]`);
        expect(graph).not.toContain("geq");
        expect(gplFiltersIn(graph)).toEqual([]);
    });

    it("an item with alpha multiplies its own alpha by the mask (blend multiply on the alpha plane)", () => {
        const ctx = context();
        applyLook(ctx, "0:v", itemLook({ kind: "clip", trackType: "video", maskJson: circle, visualFilter: "warm" }), { width: 96, height: 54, alpha: true, duration: 2 });
        const graph = ctx.graph.toString();
        expect(graph).toContain("alphaextract");
        expect(graph).toContain("blend=all_mode=multiply");
        expect(graph.match(/alphamerge/g)).toHaveLength(1);
    });

    it("one image serves every item with the same mask and size", () => {
        const ctx = context();
        const plan = itemLook({ kind: "scene", maskJson: circle });
        applyLook(ctx, "0:v", plan, { width: 96, height: 54, alpha: false, duration: 2 });
        applyLook(ctx, "0:v", plan, { width: 96, height: 54, alpha: false, duration: 2 });
        applyLook(ctx, "0:v", plan, { width: 64, height: 54, alpha: false, duration: 2 });
        expect(ctx.files).toHaveLength(2);
        expect(ctx.graph.inputs.filter((input) => input.kind === "file")).toHaveLength(2);
    });

    it("an animated mask is geq on the alpha plane with the keyframes as expressions of the frame-snapped keyframe clock", () => {
        const ctx = context();
        applyLook(ctx, "0:v", itemLook({ kind: "scene", maskJson: circle, keyframesJson: keyed }), { width: 96, height: 54, alpha: false, duration: 2, timeOffset: 0.5, keyframeOffset: 1.5 });
        const graph = ctx.graph.toString();
        expect(ctx.files).toHaveLength(0);
        expect(graph).toMatch(/format=gray,geq=i=n:lum='/);
        expect(graph).toContain("(floor(T*30+0.5)/30)");
        expect(graph).toContain("-(-1.5))");
        expect(graph).toContain("alphamerge");
        const alpha = context();
        applyLook(alpha, "0:v", itemLook({ kind: "scene", maskJson: circle, keyframesJson: keyed }), { width: 96, height: 54, alpha: true, duration: 2 });
        expect(alpha.graph.toString()).toMatch(/geq=i=n:lum='floor\(lum\(X,Y\)\*/);
    });
});
