import { describe, expect, it } from "vitest";
import { emitFfmpeg, evaluateScalar, v } from "../looks/expr";
import {
    LEGACY_RAMP_CURVES,
    MAX_CURVE_SPEED,
    MAX_SPEED,
    MIN_CURVE_SPEED,
    MIN_SPEED,
    SPEED_CURVE_PRESETS,
    audioSegments,
    clipSpeedProfile,
    isIdentitySpeed,
    meanCurveSpeed,
    outputTimeAt,
    outputTimeExpr,
    parseSpeedCurve,
    rescaleTimes,
    sceneSpeedProfile,
    serializeSpeedCurve,
    sourceSpan,
    sourceTimeAt,
    sourceTimeExpr,
    speedAt,
    speedCurvePreset,
    timelineDuration,
    type SpeedCurve,
    type SpeedProfile,
} from "./speed";

const constant = (speed: number): SpeedProfile => ({ speed, curve: null, preservePitch: true });
const curved = (curve: SpeedCurve, speed = 1): SpeedProfile => ({ speed, curve, preservePitch: true });

/** A custom curve with a vertical step at u = 0.4 and a slope on both sides. */
const STEP_CURVE: SpeedCurve = { id: "custom", points: [[0, 0.5], [0.4, 2], [0.4, 6], [0.7, 0.3], [1, 1.5]] };

/** Ten points, every segment sloped: the longest expression a curve can produce. */
const TEN_POINTS: SpeedCurve = {
    id: "custom",
    points: [[0, 0.3], [0.1, 7.5], [0.21, 0.4], [0.33, 9.1], [0.42, 0.12], [0.55, 3.3], [0.61, 8.8], [0.77, 0.9], [0.9, 5.5], [1, 0.2]],
};

const PROFILES: Array<[string, SpeedProfile]> = [
    ...[0.1, 1, 2, 100].map((s): [string, SpeedProfile] => [`constant ${s}x`, constant(s)]),
    ...SPEED_CURVE_PRESETS.map((curve): [string, SpeedProfile] => [curve.id, curved(curve, 1.5)]),
    ...Object.values(LEGACY_RAMP_CURVES).map((curve): [string, SpeedProfile] => [curve.id, curved(curve, 0.5)]),
    ["custom step", curved(STEP_CURVE, 2)],
    ["ten points", curved(TEN_POINTS, 0.1)],
    ["ten points 100x", curved(TEN_POINTS, 100)],
];

const grid = (from: number, to: number, count: number) => Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);

// ── legacy reference (export/src/filters/video.ts, re-implemented: timeline-core cannot import export) ──

const LEGACY_RAMPS = {
    montage: [{ from: 0, to: 0.25, speed: 0.55 }, { from: 0.25, to: 0.75, speed: 1.85 }, { from: 0.75, to: 1, speed: 0.75 }],
    hero: [{ from: 0, to: 0.35, speed: 0.45 }, { from: 0.35, to: 0.65, speed: 1.35 }, { from: 0.65, to: 1, speed: 0.65 }],
    bullet: [{ from: 0, to: 0.2, speed: 1.5 }, { from: 0.2, to: 0.8, speed: 0.35 }, { from: 0.8, to: 1, speed: 1.25 }],
} as const;

function legacyTable(ramp: keyof typeof LEGACY_RAMPS, duration: number, speed: number) {
    let source = 0;
    const segments = LEGACY_RAMPS[ramp].map((segment) => {
        const entry = { sourceStart: source, outputStart: segment.from * duration, speed: segment.speed * speed };
        source += (segment.to - segment.from) * duration * entry.speed;
        return entry;
    });
    return { segments, sourceSpan: source };
}

/** speedRampFilters' setpts: inside segment i, PTS_out = outputStart_i + (T - sourceStart_i) / speed_i. */
function legacyOutputTime(ramp: keyof typeof LEGACY_RAMPS, duration: number, speed: number, T: number): number {
    const { segments } = legacyTable(ramp, duration, speed);
    let i = segments.length - 1;
    for (let k = 0; k < segments.length - 1; k += 1) {
        if (T < segments[k + 1].sourceStart) {
            i = k;
            break;
        }
    }
    return segments[i].outputStart + (T - segments[i].sourceStart) / segments[i].speed;
}

describe("speed profile constants and presets", () => {
    it("exposes the ranges", () => {
        expect([MIN_SPEED, MAX_SPEED, MIN_CURVE_SPEED, MAX_CURVE_SPEED]).toEqual([0.1, 100, 0.1, 10]);
    });

    it("ships the six CapCut curves in catalog order", () => {
        expect(SPEED_CURVE_PRESETS.map((c) => c.id)).toEqual(["montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"]);
    });

    it("keeps every preset a valid curve of 4-7 points within [0.1, 10]", () => {
        for (const curve of SPEED_CURVE_PRESETS) {
            expect(curve.points.length).toBeGreaterThanOrEqual(4);
            expect(curve.points.length).toBeLessThanOrEqual(7);
            expect(curve.points[0][0]).toBe(0);
            expect(curve.points[curve.points.length - 1][0]).toBe(1);
            curve.points.forEach(([x, y], i) => {
                expect(y).toBeGreaterThanOrEqual(MIN_CURVE_SPEED);
                expect(y).toBeLessThanOrEqual(MAX_CURVE_SPEED);
                if (i > 0) expect(x).toBeGreaterThanOrEqual(curve.points[i - 1][0]);
            });
            expect(parseSpeedCurve(curve)).toEqual(curve);
            for (const u of grid(0, 1, 200)) {
                const y = speedAt(curved(curve), u, 1);
                expect(y).toBeGreaterThanOrEqual(MIN_CURVE_SPEED);
                expect(y).toBeLessThanOrEqual(MAX_CURVE_SPEED);
            }
        }
    });

    it("gives the presets their CapCut shapes", () => {
        const at = (id: string, u: number) => speedAt(curved(speedCurvePreset(id)!), u, 1);
        // Hero: normal, deep slow-mo in the middle, normal.
        expect(at("hero", 0.05)).toBeCloseTo(1, 9);
        expect(at("hero", 0.5)).toBeLessThan(0.35);
        expect(at("hero", 0.95)).toBeCloseTo(1, 9);
        // Bullet: fast, very slow middle, fast.
        expect(at("bullet", 0.05)).toBeGreaterThan(2);
        expect(at("bullet", 0.5)).toBeLessThan(0.2);
        expect(at("bullet", 0.95)).toBeGreaterThan(2);
        // Montage: at least two fast pulses separated by slow dips.
        const montage = grid(0, 1, 400).map((u) => at("montage", u));
        let pulses = 0;
        for (let i = 1; i < montage.length - 1; i += 1) if (montage[i] > 2 && montage[i] >= montage[i - 1] && montage[i] > montage[i + 1]) pulses += 1;
        expect(pulses).toBeGreaterThanOrEqual(2);
        expect(Math.min(...montage)).toBeLessThan(0.7);
        // Jump cut: speed changes by more than 3x within 3% of the clip.
        const jump = grid(0, 1, 100).map((u) => at("jump_cut", u));
        expect(jump.some((y, i) => i >= 3 && Math.max(y, jump[i - 3]) / Math.min(y, jump[i - 3]) > 3)).toBe(true);
        // Flash in: fast start, eases into normal (monotone non-increasing).
        expect(at("flash_in", 0)).toBeGreaterThan(4);
        expect(at("flash_in", 1)).toBeCloseTo(1, 9);
        grid(0, 1, 100).forEach((u, i, us) => i > 0 && expect(at("flash_in", u)).toBeLessThanOrEqual(at("flash_in", us[i - 1]) + 1e-12));
        // Flash out: normal, accelerates to fast at the end (monotone non-decreasing).
        expect(at("flash_out", 0)).toBeCloseTo(1, 9);
        expect(at("flash_out", 1)).toBeGreaterThan(4);
        grid(0, 1, 100).forEach((u, i, us) => i > 0 && expect(at("flash_out", u)).toBeGreaterThanOrEqual(at("flash_out", us[i - 1]) - 1e-12));
    });

    it("returns preset copies by id", () => {
        const hero = speedCurvePreset("hero")!;
        expect(hero).toEqual(SPEED_CURVE_PRESETS[1]);
        expect(hero).not.toBe(SPEED_CURVE_PRESETS[1]);
        expect(speedCurvePreset("legacy_hero")).toEqual(LEGACY_RAMP_CURVES.hero);
        expect(speedCurvePreset("nope")).toBeNull();
    });

    it("defines the legacy ramps as step curves equal to the old tables", () => {
        expect(LEGACY_RAMP_CURVES.montage).toEqual({ id: "legacy_montage", points: [[0, 0.55], [0.25, 0.55], [0.25, 1.85], [0.75, 1.85], [0.75, 0.75], [1, 0.75]] });
        expect(LEGACY_RAMP_CURVES.hero.id).toBe("legacy_hero");
        expect(LEGACY_RAMP_CURVES.bullet.id).toBe("legacy_bullet");
        for (const [ramp, segments] of Object.entries(LEGACY_RAMPS)) {
            const profile = curved(LEGACY_RAMP_CURVES[ramp as keyof typeof LEGACY_RAMPS]);
            for (const segment of segments) {
                expect(speedAt(profile, (segment.from + segment.to) / 2, 1)).toBeCloseTo(segment.speed, 12);
            }
        }
    });
});

describe("legacy speedRamp timing", () => {
    for (const ramp of ["montage", "hero", "bullet"] as const) {
        for (const speed of [0.5, 1, 2]) {
            it(`${ramp} at ${speed}x matches speedRampTable and speedRampFilters`, () => {
                const D = 7.3;
                const profile = clipSpeedProfile({ playbackSpeed: speed, speedRamp: ramp });
                expect(profile.curve?.id).toBe(`legacy_${ramp}`);
                const table = legacyTable(ramp, D, speed);
                expect(sourceSpan(profile, D)).toBeCloseTo(table.sourceSpan, 10);
                expect(timelineDuration(profile, table.sourceSpan)).toBeCloseTo(D, 10);
                for (const T of grid(0, table.sourceSpan, 300)) {
                    expect(outputTimeAt(profile, T, D)).toBeCloseTo(legacyOutputTime(ramp, D, speed, T), 9);
                    expect(evaluateScalar(outputTimeExpr(profile, D), T)).toBeCloseTo(legacyOutputTime(ramp, D, speed, T), 9);
                }
            });
        }
    }
});

describe("clip and scene profiles", () => {
    it("defaults to identity", () => {
        expect(clipSpeedProfile({})).toEqual({ speed: 1, curve: null, preservePitch: true });
        expect(clipSpeedProfile({ playbackSpeed: 1, speedRamp: "none" })).toEqual({ speed: 1, curve: null, preservePitch: true });
        expect(isIdentitySpeed(clipSpeedProfile({}))).toBe(true);
    });

    it("clamps the base speed to [0.1, 100] and treats 0 / garbage as 1x", () => {
        expect(clipSpeedProfile({ playbackSpeed: 250 }).speed).toBe(100);
        expect(clipSpeedProfile({ playbackSpeed: 0.01 }).speed).toBe(0.1);
        expect(clipSpeedProfile({ playbackSpeed: 12 }).speed).toBe(12);
        expect(clipSpeedProfile({ playbackSpeed: 0 }).speed).toBe(1);
        expect(clipSpeedProfile({ playbackSpeed: -3 }).speed).toBe(1);
        expect(clipSpeedProfile({ playbackSpeed: Number.NaN }).speed).toBe(1);
        expect(clipSpeedProfile({ playbackSpeed: null as unknown as number }).speed).toBe(1);
    });

    it("lets speedCurveJson win over the legacy ramp and falls back when the JSON is bad", () => {
        const json = serializeSpeedCurve(SPEED_CURVE_PRESETS[0]);
        expect(clipSpeedProfile({ speedRamp: "hero", speedCurveJson: json }).curve).toEqual(SPEED_CURVE_PRESETS[0]);
        expect(clipSpeedProfile({ speedRamp: " Hero ", speedCurveJson: "{oops" }).curve).toEqual(LEGACY_RAMP_CURVES.hero);
        expect(clipSpeedProfile({ speedRamp: "warp" }).curve).toBeNull();
    });

    it("keeps pitch unless explicitly turned off", () => {
        expect(clipSpeedProfile({ preservePitch: null }).preservePitch).toBe(true);
        expect(clipSpeedProfile({ preservePitch: true }).preservePitch).toBe(true);
        expect(clipSpeedProfile({ preservePitch: false }).preservePitch).toBe(false);
        expect(sceneSpeedProfile({ preservePitch: false }).preservePitch).toBe(false);
    });

    it("reads scene speed fields", () => {
        expect(sceneSpeedProfile({})).toEqual({ speed: 1, curve: null, preservePitch: true });
        const scene = sceneSpeedProfile({ playbackSpeed: 3, speedCurveJson: serializeSpeedCurve(STEP_CURVE) });
        expect(scene.speed).toBe(3);
        expect(scene.curve).toEqual(STEP_CURVE);
    });

    it("recognises identity speed", () => {
        expect(isIdentitySpeed(constant(1))).toBe(true);
        expect(isIdentitySpeed(constant(2))).toBe(false);
        expect(isIdentitySpeed(curved({ id: "custom", points: [[0, 1], [1, 1]] }))).toBe(true);
        expect(isIdentitySpeed(curved(SPEED_CURVE_PRESETS[1]))).toBe(false);
    });
});

describe("parseSpeedCurve / serializeSpeedCurve", () => {
    it("rejects garbage", () => {
        for (const bad of [
            null, undefined, "", "{oops", "42", 7, [], {}, { points: "x" }, { points: [] }, { points: [[0, 1]] },
            { points: [[0, 1], [1]] }, { points: [[0, 1], ["a", 2]] }, { points: [[0, 1], [1, Number.NaN]] },
            { points: [[0, 1], [1, Infinity]] },
            { points: Array.from({ length: 11 }, (_, i) => [i / 10, 1]) },
        ]) {
            expect(parseSpeedCurve(bad)).toBeNull();
        }
    });

    it("accepts JSON strings, objects, and {x, y} points", () => {
        expect(parseSpeedCurve(JSON.stringify(STEP_CURVE))).toEqual(STEP_CURVE);
        expect(parseSpeedCurve({ id: "hero", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] })).toEqual({ id: "hero", points: [[0, 1], [1, 2]] });
    });

    it("clamps values, sorts by x, snaps the ends to 0 and 1, and maps unknown ids to custom", () => {
        expect(parseSpeedCurve({ id: "warp", points: [[0.9, 50], [-0.5, 0], [0.5, 0.05]] })).toEqual({
            id: "custom",
            points: [[0, 0.1], [0.5, 0.1], [1, 10]],
        });
        expect(parseSpeedCurve({ points: [[0.2, 2], [0.6, 3]] })).toEqual({ id: "custom", points: [[0, 2], [1, 3]] });
        // Stable sort keeps the order of a vertical step.
        expect(parseSpeedCurve({ id: "custom", points: [[1, 1], [0.5, 4], [0, 1], [0.5, 0.5]] })?.points).toEqual([[0, 1], [0.5, 4], [0.5, 0.5], [1, 1]]);
        expect(parseSpeedCurve({ id: "LEGACY_HERO", points: LEGACY_RAMP_CURVES.hero.points })?.id).toBe("legacy_hero");
    });

    it("round-trips through JSON", () => {
        for (const curve of [...SPEED_CURVE_PRESETS, STEP_CURVE, TEN_POINTS, ...Object.values(LEGACY_RAMP_CURVES)]) {
            expect(parseSpeedCurve(serializeSpeedCurve(curve))).toEqual(curve);
        }
        expect(serializeSpeedCurve(null)).toBeNull();
        expect(serializeSpeedCurve({ id: "custom", points: [] })).toBeNull();
    });
});

describe("mean speed and durations", () => {
    it("integrates curves, steps included", () => {
        expect(meanCurveSpeed(null)).toBe(1);
        expect(meanCurveSpeed({ id: "custom", points: [[0, 1], [1, 3]] })).toBeCloseTo(2, 12);
        expect(meanCurveSpeed(LEGACY_RAMP_CURVES.montage)).toBeCloseTo(0.25 * 0.55 + 0.5 * 1.85 + 0.25 * 0.75, 12);
        // 0.4·(0.5+2)/2 + 0.3·(6+0.3)/2 + 0.3·(0.3+1.5)/2
        expect(meanCurveSpeed(STEP_CURVE)).toBeCloseTo(0.5 + 0.945 + 0.27, 12);
    });

    it("derives source span and timeline length from each other", () => {
        expect(sourceSpan(constant(2), 5)).toBeCloseTo(10, 12);
        expect(timelineDuration(constant(2), 10)).toBeCloseTo(5, 12);
        expect(timelineDuration(constant(0.1), 1)).toBeCloseTo(10, 12);
        expect(timelineDuration(constant(100), 50)).toBeCloseTo(0.5, 12);
        for (const [, profile] of PROFILES) {
            const D = 4.2;
            const span = sourceSpan(profile, D);
            expect(span).toBeCloseTo(profile.speed * D * meanCurveSpeed(profile.curve), 9);
            expect(timelineDuration(profile, span)).toBeCloseTo(D, 9);
            expect(sourceTimeAt(profile, D, D)).toBeCloseTo(span, 9);
        }
        expect(sourceSpan(constant(2), 0)).toBe(0);
        expect(sourceSpan(constant(2), -1)).toBe(0);
    });

    it("drives the preview rate as s·y(t/D)", () => {
        expect(speedAt(constant(3), 1.2, 4)).toBe(3);
        const p = curved({ id: "custom", points: [[0, 1], [1, 3]] }, 2);
        expect(speedAt(p, 0, 10)).toBeCloseTo(2, 12);
        expect(speedAt(p, 5, 10)).toBeCloseTo(4, 12);
        expect(speedAt(p, 10, 10)).toBeCloseTo(6, 12);
        expect(speedAt(p, 20, 10)).toBeCloseTo(6, 12);
        expect(speedAt(p, -1, 10)).toBeCloseTo(2, 12);
        // At a vertical step the value after the step applies.
        expect(speedAt(curved(STEP_CURVE), 0.4, 1)).toBeCloseTo(6, 12);
        expect(speedAt(curved(STEP_CURVE), 0.39999, 1)).toBeCloseTo(2, 3);
    });
});

describe("time maps", () => {
    it("integrates a linear curve exactly", () => {
        const p = curved({ id: "custom", points: [[0, 1], [1, 3]] }, 2);
        // S(t) = s·D·(u + u²) for y = 1 + 2u
        for (const t of grid(0, 10, 50)) {
            const u = t / 10;
            expect(sourceTimeAt(p, t, 10)).toBeCloseTo(2 * 10 * (u + u * u), 9);
        }
    });

    it("clamps outside the item", () => {
        const p = curved(STEP_CURVE, 2);
        expect(sourceTimeAt(p, -3, 5)).toBe(0);
        expect(sourceTimeAt(p, 99, 5)).toBeCloseTo(sourceSpan(p, 5), 12);
        expect(outputTimeAt(p, -3, 5)).toBe(0);
        expect(outputTimeAt(p, 999, 5)).toBeCloseTo(5, 12);
        expect(sourceTimeAt(constant(2), 9, 4)).toBe(8);
        expect(outputTimeAt(constant(2), 9, 4)).toBe(4);
        expect(sourceTimeAt(constant(2), 1, 0)).toBe(0);
        expect(outputTimeAt(constant(2), 1, 0)).toBe(0);
    });

    for (const [name, profile] of PROFILES) {
        it(`round-trips output → source → output for ${name}`, () => {
            const D = 6.4;
            for (const t of grid(0, D, 500)) {
                expect(Math.abs(outputTimeAt(profile, sourceTimeAt(profile, t, D), D) - t)).toBeLessThan(1e-9);
            }
            const span = sourceSpan(profile, D);
            for (const T of grid(0, span, 500)) {
                expect(Math.abs(sourceTimeAt(profile, outputTimeAt(profile, T, D), D) - T)).toBeLessThan(1e-9 * Math.max(1, span));
            }
        });

        it(`evaluates the same in JS and the expression IR for ${name}`, () => {
            const D = 6.4;
            const forward = sourceTimeExpr(profile, D);
            const inverse = outputTimeExpr(profile, D);
            for (const t of grid(-0.5, D + 0.5, 700)) {
                expect(Math.abs(evaluateScalar(forward, t) - sourceTimeAt(profile, t, D))).toBeLessThan(1e-9);
            }
            const span = sourceSpan(profile, D);
            for (const T of grid(-0.5, span + 0.5, 700)) {
                expect(Math.abs(evaluateScalar(inverse, T) - outputTimeAt(profile, T, D))).toBeLessThan(1e-9);
            }
        });
    }

    it("is monotone (setpts never moves backwards)", () => {
        for (const [, profile] of PROFILES) {
            let last = -1;
            for (const T of grid(0, sourceSpan(profile, 3), 400)) {
                const t = outputTimeAt(profile, T, 3);
                expect(t).toBeGreaterThanOrEqual(last - 1e-12);
                last = t;
            }
        }
    });

    it("accepts a custom time expression", () => {
        const p = curved(STEP_CURVE, 2);
        const shifted = sourceTimeExpr(p, 5, { k: "bin", op: "-", a: v("T"), b: { k: "num", v: 1 } });
        expect(evaluateScalar(shifted, 3)).toBeCloseTo(sourceTimeAt(p, 2, 5), 12);
    });

    it("emits a compact ffmpeg setpts expression without bindings", () => {
        const p = curved(TEN_POINTS, 3);
        const inverse = emitFfmpeg(outputTimeExpr(p, 12.5), { target: "scalar", time: "T" });
        const forward = emitFfmpeg(sourceTimeExpr(p, 12.5), { target: "scalar", time: "t" });
        expect(inverse.length).toBeLessThan(8000);
        expect(forward.length).toBeLessThan(8000);
        expect(inverse).not.toMatch(/st\(|ld\(/);
        expect(inverse.match(/sqrt\(/g)?.length).toBe(9);
        // Steps add no segment.
        expect(emitFfmpeg(outputTimeExpr(curved(LEGACY_RAMP_CURVES.hero), 4), { target: "scalar", time: "T" })).not.toMatch(/sqrt/);
        expect(emitFfmpeg(outputTimeExpr(constant(2), 4), { target: "scalar", time: "T" })).toBe("(clip(T,0,8)/2)");
    });
});

describe("audioSegments", () => {
    it("uses one segment at constant speed", () => {
        expect(audioSegments(constant(2), 5)).toEqual([{ outputStart: 0, outputEnd: 5, sourceStart: 0, sourceEnd: 10, speed: 2 }]);
        expect(audioSegments(curved({ id: "custom", points: [[0, 2], [0.5, 2], [1, 2]] }, 1.5), 4)).toEqual([
            { outputStart: 0, outputEnd: 4, sourceStart: 0, sourceEnd: 12, speed: 3 },
        ]);
        expect(audioSegments(constant(2), 0)).toEqual([]);
    });

    it("keeps steps exact and slices sloped parts", () => {
        const legacy = audioSegments(curved(LEGACY_RAMP_CURVES.bullet, 2), 10);
        expect(legacy.map((s) => [s.outputStart, s.outputEnd])).toEqual([[0, 2], [2, 8], [8, 10]]);
        expect(legacy.map((s) => s.speed)).toEqual([3, 0.7, 2.5].map((x) => expect.closeTo(x, 12)));
        // A fully sloped curve gets n slices, each no longer than D/n.
        const ramp = audioSegments(curved({ id: "custom", points: [[0, 1], [1, 3]] }), 8, 16);
        expect(ramp).toHaveLength(16);
        ramp.forEach((s) => expect(s.outputEnd - s.outputStart).toBeLessThanOrEqual(0.5 + 1e-12));
    });

    for (const [name, profile] of PROFILES) {
        it(`covers [0, D] contiguously with spans summing to the source span for ${name}`, () => {
            const D = 9.1;
            const segments = audioSegments(profile, D);
            expect(segments[0].outputStart).toBe(0);
            expect(segments[0].sourceStart).toBe(0);
            expect(segments[segments.length - 1].outputEnd).toBe(D);
            segments.forEach((s, i) => {
                expect(s.outputEnd).toBeGreaterThan(s.outputStart);
                if (i > 0) {
                    expect(s.outputStart).toBe(segments[i - 1].outputEnd);
                    expect(s.sourceStart).toBe(segments[i - 1].sourceEnd);
                }
                expect(s.speed).toBeCloseTo((s.sourceEnd - s.sourceStart) / (s.outputEnd - s.outputStart), 9);
                expect(s.sourceStart).toBeCloseTo(sourceTimeAt(profile, s.outputStart, D), 9);
            });
            const total = segments.reduce((sum, s) => sum + (s.sourceEnd - s.sourceStart), 0);
            expect(total).toBeCloseTo(sourceSpan(profile, D), 9);
            expect(segments.length).toBeLessThanOrEqual(16 + 10);
        });
    }
});

describe("rescaleTimes", () => {
    it("keeps a source moment when the speed changes", () => {
        const before = constant(1);
        const after = constant(2);
        // A keyframe at 4 s of an 8 s clip at 1x sits at 2 s once the clip plays 2x (4 s long).
        expect(rescaleTimes(before, 8, after, 4, 4)).toBeCloseTo(2, 12);
        const hero = curved(SPEED_CURVE_PRESETS[1]);
        const D1 = timelineDuration(hero, sourceSpan(before, 8));
        for (const t of grid(0, 8, 40)) {
            const t1 = rescaleTimes(before, 8, hero, D1, t);
            expect(sourceTimeAt(hero, t1, D1)).toBeCloseTo(t, 9);
            expect(rescaleTimes(hero, D1, before, 8, t1)).toBeCloseTo(t, 9);
        }
    });
});
