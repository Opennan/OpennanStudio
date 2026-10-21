// Local motion tracker (phase 10d): follows a rectangular region (the template) chosen on a start frame through
// later frames of grayscale luma images. No dependency, no remote service.
//
// Per frame:
//   1. predict the region centre with constant velocity (no velocity right after a loss);
//   2. coarse-to-fine search over an image pyramid (2×2 box downsampling): an exhaustive zero-mean normalized
//      cross-correlation (NCC) search over a window around the prediction on the coarsest level, then ±2 px
//      refinements on every finer level, so large motion costs little;
//   3. sub-pixel peak: a parabola through the NCC scores at the best integer offset and its neighbours, per axis;
//   4. confidence = the peak NCC (0..1). Below `lostThreshold` the sample is marked lost and the last good
//      position is held; the search window grows with every lost frame and the original template is tried too,
//      so the region is found again after an occlusion;
//   5. above `updateThreshold` the template is blended towards the new appearance (sampled at the exact
//      sub-pixel position, so it stays aligned) to follow slow changes of light and shape.
//
// Coordinates are continuous (pixel i spans [i, i + 1)); a level-l coordinate is the level-0 one over 2^l.
// Positions go out as the region centre in frame fractions.
//
// motionTrackerRuntime() is self-contained (it references nothing outside its own body but globals such as Math
// and typed arrays), so a Web Worker can run it from its source text (timeline-react tracking worker).

export interface LumaFrame {
    width: number;
    height: number;
    /** Row-major luma, one value per pixel (0..255). */
    data: ArrayLike<number>;
}

/** Frame fractions: top-left corner and size. */
export interface TrackRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TrackerOptions {
    /** Search radius around the prediction as a multiple of the region's longer side (default 1, at least 16 px). */
    searchScale?: number;
    /** Pyramid levels at most (default 4). */
    maxLevels?: number;
    /** Below this NCC the sample is lost (default 0.5). */
    lostThreshold?: number;
    /** At or above this NCC the template is blended towards the new patch (default 0.85). */
    updateThreshold?: number;
    /** Weight of the new patch in a template update (default 0.1). */
    templateBlend?: number;
}

/** A tracked position: the region centre in frame fractions. */
export interface TrackPoint {
    x: number;
    y: number;
    /** Peak NCC, 0..1. */
    confidence: number;
    /** True when the region was not found: x/y hold the last good position. */
    lost: boolean;
}

export interface TrackSample extends TrackPoint {
    /** Seconds (the caller's clock, e.g. clip-local time). */
    time: number;
}

export interface MotionTracker {
    /** Tracks the region into the next frame (same size as the start frame). */
    step(frame: LumaFrame): TrackPoint;
    /** The start position (confidence 1, unless the region has no texture). */
    readonly start: TrackPoint;
}

export interface TimedFrame {
    time: number;
    frame: LumaFrame;
}

export interface TrackerRuntime {
    createTracker(frame: LumaFrame, region: TrackRegion, options?: TrackerOptions): MotionTracker;
    trackFrames(frames: readonly TimedFrame[], startIndex: number, region: TrackRegion, options?: TrackerOptions): TrackSample[];
}

/** The tracker's whole implementation, closed over nothing (see the header). */
export function motionTrackerRuntime(): TrackerRuntime {
    interface Level {
        data: Float32Array;
        width: number;
        height: number;
    }
    interface Template {
        /** Zero-mean values. */
        values: Float32Array;
        width: number;
        height: number;
        /** sqrt(Σ values²). */
        norm: number;
        /** Region centre inside the template (level px from its top-left). */
        ox: number;
        oy: number;
    }
    interface Match {
        x: number;
        y: number;
        score: number;
    }

    const MIN_TEMPLATE = 6;
    const MIN_LEVEL_SIZE = 16;
    const FLAT_NORM = 1e-3;

    function toLevel(frame: LumaFrame): Level {
        const n = frame.width * frame.height;
        const data = new Float32Array(n);
        const src = frame.data;
        for (let i = 0; i < n; i += 1) data[i] = src[i];
        return { data, width: frame.width, height: frame.height };
    }

    function downsample(level: Level): Level {
        const width = Math.floor(level.width / 2);
        const height = Math.floor(level.height / 2);
        const data = new Float32Array(width * height);
        const src = level.data;
        const sw = level.width;
        for (let y = 0; y < height; y += 1) {
            const row0 = 2 * y * sw;
            const row1 = row0 + sw;
            for (let x = 0; x < width; x += 1) {
                const i = 2 * x;
                data[y * width + x] = (src[row0 + i] + src[row0 + i + 1] + src[row1 + i] + src[row1 + i + 1]) * 0.25;
            }
        }
        return { data, width, height };
    }

    function pyramid(frame: LumaFrame, levels: number): Level[] {
        const out = [toLevel(frame)];
        while (out.length < levels) out.push(downsample(out[out.length - 1]));
        return out;
    }

    /** Bilinear sample with edge clamping. */
    function sample(level: Level, x: number, y: number): number {
        const fx = Math.min(Math.max(x - 0.5, 0), level.width - 1);
        const fy = Math.min(Math.max(y - 0.5, 0), level.height - 1);
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, level.width - 1);
        const y1 = Math.min(y0 + 1, level.height - 1);
        const ax = fx - x0;
        const ay = fy - y0;
        const d = level.data;
        const w = level.width;
        const top = d[y0 * w + x0] * (1 - ax) + d[y0 * w + x1] * ax;
        const bottom = d[y1 * w + x0] * (1 - ax) + d[y1 * w + x1] * ax;
        return top * (1 - ay) + bottom * ay;
    }

    /** The patch whose top-left corner is at (left, top) (sub-pixel allowed), as a zero-mean template. */
    function makeTemplate(level: Level, left: number, top: number, width: number, height: number, ox: number, oy: number): Template {
        const values = new Float32Array(width * height);
        const integral = left === Math.floor(left) && top === Math.floor(top)
            && left >= 0 && top >= 0 && left + width <= level.width && top + height <= level.height;
        let sum = 0;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const value = integral ? level.data[(top + y) * level.width + left + x] : sample(level, left + x + 0.5, top + y + 0.5);
                values[y * width + x] = value;
                sum += value;
            }
        }
        const mean = sum / values.length;
        let squares = 0;
        for (let i = 0; i < values.length; i += 1) {
            values[i] -= mean;
            squares += values[i] * values[i];
        }
        return { values, width, height, norm: Math.sqrt(squares), ox, oy };
    }

    function blendTemplate(into: Template, next: Template, weight: number): Template {
        const values = new Float32Array(into.values.length);
        let squares = 0;
        for (let i = 0; i < values.length; i += 1) {
            values[i] = into.values[i] * (1 - weight) + next.values[i] * weight;
            squares += values[i] * values[i];
        }
        return { ...into, values, norm: Math.sqrt(squares) };
    }

    /** NCC of the template with the patch at integer top-left (x, y); null when the patch leaves the image. */
    function nccAt(level: Level, template: Template, x: number, y: number): number | null {
        const tw = template.width;
        const th = template.height;
        if (x < 0 || y < 0 || x + tw > level.width || y + th > level.height) return null;
        if (template.norm < FLAT_NORM) return 0;
        const d = level.data;
        const w = level.width;
        const t = template.values;
        let sum = 0;
        let squares = 0;
        let cross = 0;
        for (let row = 0; row < th; row += 1) {
            let i = (y + row) * w + x;
            let j = row * tw;
            for (let col = 0; col < tw; col += 1) {
                const value = d[i];
                sum += value;
                squares += value * value;
                cross += value * t[j];
                i += 1;
                j += 1;
            }
        }
        const n = tw * th;
        const variance = squares - (sum * sum) / n;
        if (variance <= FLAT_NORM) return 0;
        return cross / (Math.sqrt(variance) * template.norm);
    }

    /** The best integer top-left within `radius` of (gx, gy). */
    function searchLevel(level: Level, template: Template, gx: number, gy: number, radius: number): Match | null {
        let best: Match | null = null;
        for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                const score = nccAt(level, template, gx + dx, gy + dy);
                if (score !== null && (!best || score > best.score)) best = { x: gx + dx, y: gy + dy, score };
            }
        }
        return best;
    }

    /**
     * Lucas-Kanade refinement of a level-0 centre estimate (x, y): a few Gauss-Newton steps aligning the bilinear
     * image patch with the gain-matched zero-mean template. Returns the refined centre, or null when the steps do
     * not converge within `maxShift` px (the caller keeps its estimate).
     */
    function refine(level: Level, template: Template, x: number, y: number, maxShift: number): { x: number; y: number } | null {
        const tw = template.width;
        const th = template.height;
        const n = tw * th;
        const values = new Float32Array(n);
        const gxs = new Float32Array(n);
        const gys = new Float32Array(n);
        let px = x;
        let py = y;
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const left = px - template.ox;
            const top = py - template.oy;
            if (left < 1 || top < 1 || left + tw > level.width - 1 || top + th > level.height - 1) return null;
            let sum = 0;
            let sumGx = 0;
            let sumGy = 0;
            for (let j = 0; j < th; j += 1) {
                for (let i = 0; i < tw; i += 1) {
                    const sx = left + i + 0.5;
                    const sy = top + j + 0.5;
                    const k = j * tw + i;
                    values[k] = sample(level, sx, sy);
                    gxs[k] = (sample(level, sx + 1, sy) - sample(level, sx - 1, sy)) * 0.5;
                    gys[k] = (sample(level, sx, sy + 1) - sample(level, sx, sy - 1)) * 0.5;
                    sum += values[k];
                    sumGx += gxs[k];
                    sumGy += gys[k];
                }
            }
            const mean = sum / n;
            const meanGx = sumGx / n;
            const meanGy = sumGy / n;
            let squares = 0;
            for (let k = 0; k < n; k += 1) {
                values[k] -= mean;
                squares += values[k] * values[k];
            }
            if (!(template.norm > FLAT_NORM) || !(squares > FLAT_NORM)) return null;
            const gain = Math.sqrt(squares) / template.norm;
            let a = 0;
            let b = 0;
            let c = 0;
            let ex = 0;
            let ey = 0;
            for (let k = 0; k < n; k += 1) {
                const gx = gxs[k] - meanGx;
                const gy = gys[k] - meanGy;
                const r = template.values[k] * gain - values[k];
                a += gx * gx;
                b += gx * gy;
                c += gy * gy;
                ex += gx * r;
                ey += gy * r;
            }
            const det = a * c - b * b;
            if (!(Math.abs(det) > 1e-9)) return null;
            const dx = (c * ex - b * ey) / det;
            const dy = (a * ey - b * ex) / det;
            px += dx;
            py += dy;
            if (Math.hypot(px - x, py - y) > maxShift) return null;
            if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) break;
        }
        return { x: px, y: py };
    }

    /** Vertex offset of the parabola through (−1, a), (0, b), (1, c), within ±0.5. */
    function parabola(a: number | null, b: number, c: number | null): number {
        if (a === null || c === null) return 0;
        const denominator = a - 2 * b + c;
        if (!(denominator < 0)) return 0;
        return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator));
    }

    function createTracker(frame: LumaFrame, region: TrackRegion, options: TrackerOptions = {}): MotionTracker {
        const width = frame.width;
        const height = frame.height;
        if (!(width > 0 && height > 0) || frame.data.length < width * height) throw new Error("tracker frame size does not match its data");
        const valid = [region.x, region.y, region.width, region.height].every((v) => Number.isFinite(v))
            && region.width > 0 && region.height > 0 && region.x >= -1e-6 && region.y >= -1e-6
            && region.x + region.width <= 1 + 1e-6 && region.y + region.height <= 1 + 1e-6;
        if (!valid) throw new Error("the tracking region must lie inside the frame");
        const tw0 = Math.round(region.width * width);
        const th0 = Math.round(region.height * height);
        if (tw0 < MIN_TEMPLATE || th0 < MIN_TEMPLATE) throw new Error(`the tracking region must be at least ${MIN_TEMPLATE} px on each side at analysis size`);
        const searchScale = options.searchScale ?? 1;
        const lostThreshold = options.lostThreshold ?? 0.5;
        const updateThreshold = options.updateThreshold ?? 0.85;
        const blend = options.templateBlend ?? 0.1;
        let levels = 1;
        const maxLevels = Math.max(1, Math.min(6, options.maxLevels ?? 4));
        while (levels < maxLevels) {
            const scale = 2 ** levels;
            if (Math.min(tw0, th0) / scale < MIN_TEMPLATE || Math.min(width, height) / scale < MIN_LEVEL_SIZE) break;
            levels += 1;
        }
        const baseRadius = Math.max(16, Math.ceil(searchScale * Math.max(tw0, th0)));
        let cx = (region.x + region.width / 2) * width;
        let cy = (region.y + region.height / 2) * height;

        /** Templates of every level, extracted around centre (x, y) of `frames`; top-left rounded, centre offset kept. */
        const extract = (frames: Level[], x: number, y: number): Template[] => frames.map((level, l) => {
            const scale = 2 ** l;
            const tw = Math.max(1, Math.round(tw0 / scale));
            const th = Math.max(1, Math.round(th0 / scale));
            const left = Math.min(Math.max(0, Math.round(x / scale - tw / 2)), level.width - tw);
            const top = Math.min(Math.max(0, Math.round(y / scale - th / 2)), level.height - th);
            return makeTemplate(level, left, top, tw, th, x / scale - left, y / scale - top);
        });
        const first = pyramid(frame, levels);
        const original = extract(first, cx, cy);
        let current = original;
        const flat = original[0].norm / Math.sqrt(original[0].values.length) < 1;
        let vx = 0;
        let vy = 0;
        let lostFrames = 0;
        const start: TrackPoint = { x: cx / width, y: cy / height, confidence: flat ? 0 : 1, lost: flat };

        /** Coarse-to-fine match of `templates` around the predicted centre (px, py) with level-0 radius `radius`. */
        const locate = (frames: Level[], templates: Template[], px: number, py: number, radius: number): { x: number; y: number; score: number } | null => {
            const top = levels - 1;
            let level = frames[top];
            let t = templates[top];
            let scale = 2 ** top;
            const coarseRadius = Math.max(2, Math.ceil(radius / scale) + 1);
            let match = searchLevel(level, t, Math.round(px / scale - t.ox), Math.round(py / scale - t.oy), coarseRadius);
            if (!match) return null;
            for (let l = top - 1; l >= 0; l -= 1) {
                const centreX = (match.x + t.ox) * 2;
                const centreY = (match.y + t.oy) * 2;
                level = frames[l];
                t = templates[l];
                scale = 2 ** l;
                const refined = searchLevel(level, t, Math.round(centreX - t.ox), Math.round(centreY - t.oy), 2);
                if (!refined) return null;
                match = refined;
            }
            const sx = parabola(nccAt(level, t, match.x - 1, match.y), match.score, nccAt(level, t, match.x + 1, match.y));
            const sy = parabola(nccAt(level, t, match.x, match.y - 1), match.score, nccAt(level, t, match.x, match.y + 1));
            return { x: match.x + sx + t.ox, y: match.y + sy + t.oy, score: match.score };
        };

        const step = (next: LumaFrame): TrackPoint => {
            if (next.width !== width || next.height !== height) throw new Error("every tracked frame must have the start frame's size");
            if (flat) return { x: cx / width, y: cy / height, confidence: 0, lost: true };
            const frames = pyramid(next, levels);
            const radius = Math.min(Math.max(width, height), baseRadius * (1 + lostFrames));
            const px = cx + vx;
            const py = cy + vy;
            let found = locate(frames, current, px, py, radius);
            if ((!found || found.score < lostThreshold) && current !== original) {
                const again = locate(frames, original, px, py, radius);
                if (again && (!found || again.score > found.score)) found = again;
            }
            if (!found || found.score < lostThreshold) {
                lostFrames += 1;
                vx = 0;
                vy = 0;
                return { x: cx / width, y: cy / height, confidence: Math.max(0, Math.min(1, found?.score ?? 0)), lost: true };
            }
            // Sub-pixel alignment with the current template, then a drift correction against the original one: a
            // blended template slowly drifts off the region, the original does not while the appearance still matches.
            const level0 = frames[0];
            const aligned = refine(level0, current[0], found.x, found.y, 1) ?? found;
            const anchored = current === original ? null : refine(level0, original[0], aligned.x, aligned.y, 0.75);
            const anchoredScore = anchored ? nccAt(level0, original[0], Math.round(anchored.x - original[0].ox), Math.round(anchored.y - original[0].oy)) : null;
            const final = anchored && anchoredScore !== null && anchoredScore >= updateThreshold ? anchored : aligned;
            // Constant velocity from the last two good frames; none right after a loss.
            vx = lostFrames === 0 ? final.x - cx : 0;
            vy = lostFrames === 0 ? final.y - cy : 0;
            lostFrames = 0;
            cx = final.x;
            cy = final.y;
            if (found.score >= updateThreshold && blend > 0) {
                // The new appearance at the exact sub-pixel position, aligned with each template's centre offset.
                current = current.map((template, l) => {
                    const scale = 2 ** l;
                    const patch = makeTemplate(frames[l], cx / scale - template.ox, cy / scale - template.oy, template.width, template.height, template.ox, template.oy);
                    return blendTemplate(template, patch, blend);
                });
            }
            return { x: cx / width, y: cy / height, confidence: Math.max(0, Math.min(1, found.score)), lost: false };
        };

        return { step, start };
    }

    function trackFrames(frames: readonly TimedFrame[], startIndex: number, region: TrackRegion, options: TrackerOptions = {}): TrackSample[] {
        if (!(startIndex >= 0 && startIndex < frames.length)) throw new Error("the start frame is outside the frame list");
        const out: TrackSample[] = new Array(frames.length);
        const forward = createTracker(frames[startIndex].frame, region, options);
        out[startIndex] = { time: frames[startIndex].time, ...forward.start };
        for (let i = startIndex + 1; i < frames.length; i += 1) out[i] = { time: frames[i].time, ...forward.step(frames[i].frame) };
        if (startIndex > 0) {
            const backward = createTracker(frames[startIndex].frame, region, options);
            for (let i = startIndex - 1; i >= 0; i -= 1) out[i] = { time: frames[i].time, ...backward.step(frames[i].frame) };
        }
        return out;
    }

    return { createTracker, trackFrames };
}

const runtime = motionTrackerRuntime();

/** A tracker for `region` (frame fractions) on `frame`; step() it through the next frames in order. */
export function createMotionTracker(frame: LumaFrame, region: TrackRegion, options?: TrackerOptions): MotionTracker {
    return runtime.createTracker(frame, region, options);
}

/**
 * Tracks `region` (drawn on frames[startIndex]) forward to the last frame and backward to the first one. One
 * sample per frame, in the frames' order, with each frame's time.
 */
export function trackFrames(frames: readonly TimedFrame[], startIndex: number, region: TrackRegion, options?: TrackerOptions): TrackSample[] {
    return runtime.trackFrames(frames, startIndex, region, options);
}
