// Argument helpers shared by handlers: lookups by 1-based scene order, snake_case
// to camelCase patches, and detection of arguments that need a provider.
import type { ControllerSnapshot, SceneData, TimelineClip } from "@opennan/timeline-core";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core";
import { toCamelCase } from "@opennan/mcp-schema";

export type Args = Record<string, unknown>;

/** Scenes sorted by `order`; scene_order N is index N - 1. */
export function scenesInOrder(scenes: SceneData[]): SceneData[] {
    return [...scenes].sort((a, b) => a.order - b.order);
}

export function sceneByOrder(snapshot: ControllerSnapshot, sceneOrder: unknown): SceneData {
    const n = Number(sceneOrder);
    const scene = Number.isInteger(n) ? scenesInOrder(snapshot.scenes)[n - 1] : undefined;
    if (!scene) throw new Error(`Scene ${String(sceneOrder)} not found (the project has ${snapshot.scenes.length} scenes)`);
    return scene;
}

/** Start and duration of a scene on the timeline, in seconds. */
export function sceneSpan(snapshot: ControllerSnapshot, scene: SceneData): { start: number; duration: number } {
    const index = snapshot.scenes.findIndex((s) => s.id === scene.id);
    return { start: getSceneStart(scene, snapshot.scenes, index), duration: getSceneDuration(scene) };
}

export function clipById(snapshot: ControllerSnapshot, clipId: unknown): TimelineClip {
    const clip = snapshot.clips.find((c) => c.id === clipId);
    if (!clip) throw new Error(`Timeline clip not found: ${String(clipId)}`);
    return clip;
}

/** Picks the given snake_case arguments that are present and renames them to camelCase. */
export function camelPatch(args: Args, snakeKeys: readonly string[]): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const key of snakeKeys) {
        if (args[key] !== undefined) patch[toCamelCase(key)] = args[key];
    }
    return patch;
}

/** Arguments set in `args` among `fields` ("a" or "a[].b"). */
export function presentFields(args: Args, fields: readonly string[]): string[] {
    const found: string[] = [];
    for (const field of fields) {
        const [head, tail] = field.split("[].");
        if (tail === undefined) {
            if (args[head] !== undefined) found.push(field);
            continue;
        }
        const items = args[head];
        if (Array.isArray(items) && items.some((item) => item && typeof item === "object" && (item as Args)[tail] !== undefined)) {
            found.push(field);
        }
    }
    return found;
}

export function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

export function overlaps(start: number, end: number, from?: number, to?: number): boolean {
    return (to === undefined || start < to) && (from === undefined || end > from);
}
