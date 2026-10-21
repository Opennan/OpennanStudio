// Executes a frame's draw list (gpu/plan.ts) with the preview's WebGL2 LookRenderer (phase 10c). Every pixel
// operation is a LookRenderer pass the preview already runs and the 10a/10b parity tests check against ffmpeg:
// looks (CLUTs, Adjust keyframe mixes, sharpen, vignette, grain, effect passes), transitions, and placement. The
// result is presented on the renderer's canvas at the output size, where the encoder captures it.
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import type { AffineMatrix, GlFrame, LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import type { GlFrameProcessor } from "../gl";
import type { OutputFormat } from "../types";
import type { DrawOp, GraphicsOp, LaneOp, LayerOp, Placement, VideoRead } from "./plan";

export interface CompositorSources {
    /** The decoded frame a read shows at its piece frame (null: nothing, e.g. past the media's end). */
    frame(read: VideoRead, index: number): Promise<{ source: TexImageSource; width: number; height: number; rotation: number; close(): void } | null>;
    image(url: string): Promise<ImageBitmap | null>;
    raster(id: string): Promise<ImageBitmap | null>;
    /** A graphics clip's full-frame picture for this op (format size, placement baked in), or null. */
    graphics?(op: GraphicsOp): Promise<{ source: TexImageSource; width: number; height: number } | null>;
}

/** The inverse of placing a bw×bh bitmap at `place` (target pixel → bitmap pixel), in CSS matrix order. */
export function placementInverse(place: Placement, bw: number, bh: number): AffineMatrix {
    const sx = bw / place.width;
    const sy = bh / place.height;
    const cos = Math.cos(place.rotation);
    const sin = Math.sin(place.rotation);
    const a = sx * cos;
    const c = sx * sin;
    const b = -sy * sin;
    const d = sy * cos;
    return [a, b, c, d, bw / 2 - (a * place.cx + c * place.cy), bh / 2 - (b * place.cx + d * place.cy)];
}

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];
const BLACK = [0, 0, 0, 1] as const;
const CLEAR = [0, 0, 0, 0] as const;

export class GpuCompositor {
    constructor(
        private readonly renderer: LookRenderer,
        private readonly format: Pick<OutputFormat, "width" | "height">,
        private readonly sources: CompositorSources,
        private readonly glProcessor?: GlFrameProcessor,
    ) {}

    /** Renders one output frame and leaves it on the renderer's canvas (format size). */
    async render(ops: readonly DrawOp[]): Promise<void> {
        const r = this.renderer;
        const { width, height } = this.format;
        try {
            let acc = r.fill(width, height, BLACK);
            for (const op of ops) {
                if (op.kind === "lane") acc = await this.lane(acc, op);
                else if (op.kind === "layer") {
                    const layer = await this.layer(op);
                    if (layer) acc = this.place(acc, op.place, layer, op.opacity);
                } else if (op.kind === "graphics") {
                    const picture = await this.sources.graphics?.(op);
                    if (picture) acc = r.composite(acc, r.upload(picture.source, picture.width, picture.height), IDENTITY, 1);
                } else if (op.kind === "span") {
                    acc = r.look(acc, op.plan, op.time);
                } else if (op.kind === "gl" && this.glProcessor) {
                    const data = await this.glProcessor.process({ data: r.readPixels(acc), width, height, time: op.time }, op.effects);
                    if (data.length !== width * height * 4) throw new Error("a GL effect returned a frame of the wrong size"); // i18n-ignore
                    acc = r.uploadPixels(data, width, height);
                }
            }
            r.present(acc, width, height);
        } finally {
            r.releaseAll();
        }
    }

    private async lane(acc: GlFrame, op: LaneOp): Promise<GlFrame> {
        const r = this.renderer;
        const { width, height } = this.format;
        const side = async (layerOp: LayerOp | null | undefined) => {
            let frame = r.fill(width, height, op.opaque ? BLACK : CLEAR);
            if (layerOp) {
                const layer = await this.layer(layerOp);
                if (layer) frame = this.place(frame, layerOp.place, layer, layerOp.opacity);
            }
            return frame;
        };
        let frame = await side(op.a);
        const def = op.transition ? transitionById(op.transition) : undefined;
        if (def && op.b !== undefined) frame = r.transition(frame, await side(op.b), def, op.p ?? 0, op.opaque ? 3 : 4);
        return op.opaque ? frame : r.composite(acc, frame, IDENTITY, 1);
    }

    /** A layer's processed bitmap (source → bitmap size → crop → look → legacy blur/key/eq → mosaic → flips/fades), or null. */
    private async layer(op: LayerOp): Promise<GlFrame | null> {
        const r = this.renderer;
        let frame: GlFrame;
        const source = op.source;
        if (source.kind === "video") {
            const decoded = await this.sources.frame(source.read, source.index);
            if (!decoded) return null;
            try {
                frame = r.upload(decoded.source, decoded.width, decoded.height);
            } finally {
                decoded.close();
            }
            if (decoded.rotation) frame = r.rotate90(frame, decoded.rotation);
        } else if (source.kind === "image") {
            const image = await this.sources.image(source.url);
            if (!image) return null;
            frame = r.upload(image, image.width, image.height);
        } else {
            const image = await this.sources.raster(source.id);
            if (!image) return null;
            frame = r.upload(image, image.width, image.height);
            if (source.cell) frame = r.crop(frame, source.cell);
        }
        const bw = Math.max(1, Math.round(op.bitmap.width));
        const bh = Math.max(1, Math.round(op.bitmap.height));
        frame = frame.width > bw * 2 || frame.height > bh * 2 ? r.downscale(frame, bw, bh) : r.resize(frame, bw, bh);
        if (op.crop) frame = r.crop(frame, op.crop);
        if (op.look) {
            if (op.look.mix) frame = r.lutMix(frame, op.look.mix.a, op.look.mix.b, op.look.mix.w);
            frame = r.look(frame, op.look.plan, op.look.time, op.look.keyframeTime, op.look.maskBox);
        }
        if (op.legacy) frame = r.legacy(frame, op.legacy);
        if (op.mosaic > 1) {
            const small = r.nearest(frame, Math.max(1, Math.trunc(frame.width / op.mosaic)), Math.max(1, Math.trunc(frame.height / op.mosaic)));
            frame = r.nearest(small, small.width * op.mosaic, small.height * op.mosaic);
        }
        return r.adjustLayer(frame, { flipX: op.flipX, flipY: op.flipY, alpha: op.fadeAlpha, dip: op.dip });
    }

    /** Composites a bitmap at its placement; large reductions are box-filtered first. */
    private place(base: GlFrame, place: Placement, layer: GlFrame, opacity: number): GlFrame {
        if (!(place.width > 0) || !(place.height > 0)) return base;
        let bitmap = layer;
        if (layer.width > place.width * 2 && layer.height > place.height * 2) bitmap = this.renderer.downscale(layer, place.width, place.height);
        return this.renderer.composite(base, bitmap, placementInverse(place, bitmap.width, bitmap.height), opacity);
    }
}
