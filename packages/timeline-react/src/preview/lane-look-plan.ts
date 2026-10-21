// What the main-track (V1) look overlay draws at a time: one scene with its look, or a centered
// transition window between two touching scenes (looks/windows.ts — the export's own rule). Pure.
//
// Adjust keyframes (phase 10b): a scene or clip whose keyframes carry `adj_*` or `filter_intensity`
// channels is drawn as a cross-fade between the CLUTs of the two keyframes around the time, with the
// easing of the earlier point: out = trunc(LUT_k(x) + (LUT_k+1(x) − LUT_k(x))·e(T)) (LookRenderer.lutMix,
// weight quantized to k / 1024). The look of keyframe k is the item's look with every keyframed Adjust
// channel (and filter intensity) replaced by that channel's own curve value at t_k; a neutral keyframe is
// the identity CLUT. Sharpen, vignette, grain, and effects are not keyframable and run after the mix.
import type { ClipEffect, SceneData } from "@opennan/timeline-core";
import { itemLook, type LookPlan, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import type { KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import {
    keyframeLut, lookAfterKeyframes, lookKeyframeMix, lookKeyframeTimes, type LutStep,
} from "@opennan/timeline-core/motion/look-keyframes";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { planTransitionWindows, windowProgress } from "@opennan/timeline-core/looks/windows";
import { handleMediaTime, sceneHandleMedia, snapHandles, transitionHandles } from "@opennan/timeline-core/looks/handles";
import { SCENE_CUT_TOLERANCE } from "@opennan/timeline-core/lib/scene-transitions";
import { parseShotBreakdown, shotVisualDuration } from "@opennan/timeline-core/lib/shot-utils";
import { parseSceneCardConfig } from "@opennan/timeline-core/timeline/scene-timing";
import { sceneSpeedProfile, sourceTimeAt } from "@opennan/timeline-core/motion/speed";
import { sceneSpeedFactor } from "@opennan/timeline-core/timeline/scene-duration";

/** The scene fields the overlay reads (ScenePreview keeps its own scene type). */
export type LaneScene = Pick<SceneData, "id"> & Partial<Pick<SceneData,
    "visualFilter" | "filterIntensity" | "adjustmentsJson" | "fitMode" | "transformScale" | "transformOffsetX" | "transformOffsetY" |
    "videoUrl" | "sourceVideoUrl" | "cardType" | "startImageUrl" | "startImageThumbUrl" | "cardConfig" | "shotBreakdown" |
    "playbackSpeed" | "speedCurveJson" | "preservePitch" | "keyframesJson" | "animationJson" | "rotationDegrees" | "opacity" | "maskJson">> & {
    effects?: Array<Pick<ClipEffect, "id" | "effectId" | "order" | "paramsJson" | "enabled">> | null;
};

export interface LaneRange {
    scene: LaneScene;
    start: number;
    end: number;
    trackIndex: number;
    transitionType: string;
    transitionDuration: number;
}

// The keyframed-look rules live in timeline-core (motion/look-keyframes.ts), shared with the export.
export {
    IDENTITY_LUT_KEY, LOOK_KEYFRAME_CHANNELS, keyframeLookSource, keyframeLut, lookKeyframeMix, lookKeyframeTimes, type LutStep,
} from "@opennan/timeline-core/motion/look-keyframes";

/** The Adjust-keyframe cross-fade at a time: the CLUTs of the keyframes at `from` and `to` seconds, eased weight `w`. */
export interface LaneLookMix {
    from: number;
    to: number;
    a: LutStep;
    b: LutStep;
    w: number;
}

export interface LaneSide {
    scene: LaneScene;
    /** The look's steps; with `mix`, the steps after the keyframed CLUT (spatial steps, effects). */
    plan: LookPlan | null;
    /** Adjust keyframes: the CLUT cross-fade that replaces the plan's adjust CLUT, else null. */
    mix: LaneLookMix | null;
    /** Item-local seconds of the frame to show. */
    local: number;
    /** True: the editor's playing element shows this frame; false: a still (held, or a live handle frame). */
    live: boolean;
    /**
     * A moving frame past the scene's own range (a live transition handle, looks/handles.ts): read it through the
     * overlay's hidden decoder. False for held frames (fixed snapshots).
     */
    decoder: boolean;
    /** Local seconds of the side's held frame (what the export clones once the handle runs out). */
    heldLocal: number;
    /** The scene's length on the timeline (shot-sequenced scenes time their shots by it). */
    length: number;
}

export type LaneFrame =
    | { kind: "none" }
    | { kind: "scene"; side: LaneSide }
    | { kind: "window"; a: LaneSide; b: LaneSide; transitionId: string; p: number };

/** Seconds of the held last frame (the export clones its last frame at 30 fps). */
export const HELD_FRAME_SECONDS = 1 / 30;
/** Frame rate the export snaps live handles to (its default). */
const HANDLE_FPS = 30;

/** A scene's look, built once per edit of the lane: the static plan, or the keyframed one. */
export interface LaneLook {
    /** The full static look (no Adjust keyframes), else null. */
    plan: LookPlan | null;
    /** Adjust keyframes: the look's steps after its adjust CLUT, the points, and a CLUT per keyframe time. */
    keyed: { rest: LookPlan | null; points: KeyframePoints; luts: Map<number, LutStep> } | null;
}

export function laneLook(scene: LaneScene): LaneLook {
    const source: LookSource = { kind: "scene", ...scene };
    const points = scene.keyframesJson ? parseTimelineKeyframes(scene.keyframesJson) : [];
    if (lookKeyframeTimes(points).length === 0) return { plan: itemLook(source), keyed: null };
    return { plan: null, keyed: { rest: lookAfterKeyframes(itemLook(source)), points, luts: new Map() } };
}

function laneSide(look: LaneLook, scene: LaneScene, local: number, live: boolean, length: number, source: LookSource, decoder = false, heldLocal = local): LaneSide {
    if (!look.keyed) return { scene, plan: look.plan, mix: null, local, live, length, decoder, heldLocal };
    const { rest, points, luts } = look.keyed;
    const at = lookKeyframeMix(points, local)!;
    const lutAt = (time: number) => {
        let lut = luts.get(time);
        if (!lut) {
            lut = keyframeLut(source, points, time);
            luts.set(time, lut);
        }
        return lut;
    };
    return { scene, plan: rest, mix: { from: at.from, to: at.to, a: lutAt(at.from), b: lutAt(at.to), w: at.w }, local, live, length, decoder, heldLocal };
}

export function laneLookFrame(ranges: LaneRange[], t: number, looks: Map<string, LaneLook> = new Map()): LaneFrame {
    const lane = ranges.filter((r) => r.trackIndex === 1).sort((a, b) => a.start - b.start);
    const lookOf = (scene: LaneScene) => {
        let look = looks.get(scene.id);
        if (!look) {
            look = laneLook(scene);
            looks.set(scene.id, look);
        }
        return look;
    };
    const side = (scene: LaneScene, local: number, live: boolean, length: number, decoder = false, heldLocal = local) =>
        laneSide(lookOf(scene), scene, local, live, length, { kind: "scene", ...scene }, decoder, heldLocal);
    const joins = new Map<number, { type: string; duration: number }>();
    lane.forEach((range, i) => {
        const next = lane[i + 1];
        if (next && Math.abs(next.start - range.end) <= SCENE_CUT_TOLERANCE && range.transitionDuration > 0 && transitionById(range.transitionType)) {
            joins.set(i, { type: range.transitionType, duration: range.transitionDuration });
        }
    });
    const windows = planTransitionWindows(lane.map((r) => r.end - r.start), joins);
    for (const [i, window] of windows) {
        const a = lane[i];
        const b = lane[i + 1];
        const p = windowProgress(t, a.end, window.half);
        if (p === null) continue;
        const beforeCut = t < a.end;
        // Live handles (the export's rule, frames at 30 fps): real media past the cut, then the last real frame held.
        const { outgoingAfter: after, incomingBefore: before } = snapHandles(transitionHandles(sceneHandleMedia(a.scene), sceneHandleMedia(b.scene), window.half), HANDLE_FPS);
        const lengthA = a.end - a.start;
        const lengthB = b.end - b.start;
        if (beforeCut) {
            const heldB = before > 0 ? -before : 0;
            const liveB = before > 0 && b.start - t <= before;
            return {
                kind: "window", transitionId: window.type, p,
                a: side(a.scene, t - a.start, true, lengthA),
                b: side(b.scene, liveB ? t - b.start : heldB, false, lengthB, liveB, heldB),
            };
        }
        const heldA = after > 0 ? lengthA + after - HELD_FRAME_SECONDS : Math.max(0, lengthA - HELD_FRAME_SECONDS);
        const liveA = after > 0 && t - a.end < after - 1e-9;
        return {
            kind: "window", transitionId: window.type, p,
            a: side(a.scene, liveA ? t - a.start : heldA, false, lengthA, liveA, heldA),
            b: side(b.scene, Math.max(0, t - b.start), true, lengthB),
        };
    }
    const active = lane.find((r) => t >= r.start - 0.005 && t < r.end - 0.005);
    if (!active) return { kind: "none" };
    const look = lookOf(active.scene);
    if (!look.plan && !look.keyed) return { kind: "none" };
    return { kind: "scene", side: side(active.scene, Math.max(0, t - active.start), true, active.end - active.start) };
}

/** Where a scene's frame at scene-local `local` comes from: url, whether it is a video, and the media time. */
export interface LaneSceneSource {
    url: string;
    video: boolean;
    time: number;
}

function sceneTrimStart(scene: LaneScene): number {
    const config = parseSceneCardConfig({ cardConfig: scene.cardConfig ?? null });
    const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Speed (phase 10b): scene-local timeline time `local` as constant-speed scene seconds, S(local) / factor
 * (S = the scene's exact time map, factor = its mean speed). Equal to `local` without a curve, so the
 * linear mappings below (which already include the mean speed through `length`) only change for curves.
 */
function warpedLocal(scene: LaneScene, local: number, length: number): number {
    if (!scene.speedCurveJson) return local;
    const profile = sceneSpeedProfile(scene);
    if (!profile.curve || !(length > 0)) return local;
    return sourceTimeAt(profile, Math.max(0, local), length) / sceneSpeedFactor(scene);
}

/**
 * The scene's video (at its trim offset), else the shot under `local` for a shot-sequenced scene
 * (no stitched video, every shot has a video: shot i covers [acc_i, acc_i + d_i) / timeScale and
 * plays at timeScale = Σd / length, export timeline-model.ts sceneShotSequence), else the start image.
 * `local` and `length` are timeline seconds; a sped-up scene's media time goes through its time map
 * (the stitched video shows trimStart + S(local), as ScenePreview plays it), so looks, held frames and
 * transitions show the right frame.
 */
export function laneSceneSource(scene: LaneScene, local: number, length: number): LaneSceneSource | null {
    const video = scene.videoUrl || (scene.cardType === "source_clip" ? scene.sourceVideoUrl : null);
    const factor = sceneSpeedFactor(scene);
    if (video) {
        // Past the scene's own range (live transition handles): the media continues at the speed factor.
        const media = local > length || local < 0 ? sceneHandleMedia(scene) : null;
        if (media && !media.still) return { url: video, video: true, time: local > length ? handleMediaTime(media, "after", local - length) : handleMediaTime(media, "before", -local) };
        return { url: video, video: true, time: sceneTrimStart(scene) + warpedLocal(scene, local, length) * factor };
    }
    const shots = scene.cardType === "source_clip" && scene.sourceVideoUrl
        ? []
        : parseShotBreakdown<{ video_url?: string; duration?: string | number; duration_seconds?: string | number }>(scene.shotBreakdown);
    if (shots.length > 0 && shots.every((shot) => Boolean(shot.video_url))) {
        local = warpedLocal(scene, local, length);
        const durations = shots.map((shot) => shotVisualDuration(shot));
        const total = durations.reduce((sum, d) => sum + d, 0);
        const timeScale = total > 0 && length > 0 ? total / length : 1;
        let acc = 0;
        for (let i = 0; i < shots.length; i += 1) {
            const start = acc / timeScale;
            const end = (acc + durations[i]) / timeScale;
            acc += durations[i];
            if (local < end || i === shots.length - 1) {
                return { url: String(shots[i].video_url), video: true, time: Math.max(0, Math.min(local, end) - start) * timeScale };
            }
        }
    }
    const image = scene.startImageUrl || scene.startImageThumbUrl;
    return image ? { url: image, video: false, time: 0 } : null;
}

/** Ranges whose scene transitions the CSS fallback draws: every lane without WebGL2, else V2 and up (V1 is the looks overlay's). */
export function cssTransitionRanges<T extends { trackIndex: number }>(ranges: T[], webgl: boolean): T[] {
    return webgl ? ranges.filter((range) => range.trackIndex !== 1) : ranges;
}
