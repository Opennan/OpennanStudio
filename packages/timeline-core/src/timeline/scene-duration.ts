// Scene speed (phase 10b): scenes keep their media spans (duration, cardConfig trims, shots) in SOURCE
// seconds, and every scene-duration rule divides by the speed factor (constant speed × the curve's mean
// speed, motion/speed.ts), so the timeline, preview, and export agree on a sped-up scene's length.
import { meanCurveSpeed, sceneSpeedProfile } from "../motion/speed";
import type { SceneData } from "./canvas/types";

type SpeedFields = Pick<SceneData, "playbackSpeed" | "speedCurveJson" | "preservePitch">;
/** Any scene shape (hosts keep their own scene types); only the speed fields are read. */
type SceneLike = object;

const factorCache = new WeakMap<object, number>();

/** Source seconds per timeline second on average: 1 for scenes without speed fields. */
export function sceneSpeedFactor(item: SceneLike): number {
    const scene = item as Partial<SpeedFields>;
    if (scene.playbackSpeed == null && !scene.speedCurveJson) return 1;
    const cached = factorCache.get(scene);
    if (cached !== undefined) return cached;
    const profile = sceneSpeedProfile(scene as SpeedFields);
    const factor = profile.speed * meanCurveSpeed(profile.curve);
    const value = Number.isFinite(factor) && factor > 0 ? factor : 1;
    factorCache.set(scene, value);
    return value;
}

/** A source span (media seconds) as timeline seconds. */
export function sceneTimelineSeconds(scene: SceneLike, sourceSeconds: number): number {
    const factor = sceneSpeedFactor(scene);
    return factor === 1 ? sourceSeconds : sourceSeconds / factor;
}

/** Timeline seconds as a source span (media seconds), e.g. for edge trims. */
export function sceneSourceSeconds(scene: SceneLike, timelineSeconds: number): number {
    const factor = sceneSpeedFactor(scene);
    return factor === 1 ? timelineSeconds : timelineSeconds * factor;
}
