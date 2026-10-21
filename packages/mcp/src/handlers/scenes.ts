// Scene, shot, and project tools. scene_order is the 1-based rank by scene
// `order`; shot_index is 0-based (the OpenNan argument conventions).
import type { AddSceneInput, SceneData } from "@opennan/timeline-core";
import { planSourceClipSceneSplit, shots as shotUtils } from "@opennan/timeline-core";
import { camelPatch, round3, sceneByOrder, sceneSpan, scenesInOrder, type Args } from "../args";
import { commandFailure, failure, success, type ToolOutcome } from "../outcome";
import type { StudioSession } from "../session";
import { parseShots } from "./summaries";
import type { ToolHandler } from "./types";

/** A tool call must fit in the undo history to stay undoable as one step (undo_last_edit). */
async function undoBudget(session: StudioSession, commands: number): Promise<ToolOutcome | null> {
    const depth = await session.historyDepth?.();
    if (depth && commands > depth.limit) {
        return failure(`This call needs ${commands} edits, more than the undo history keeps (${depth.limit}). Split it into smaller calls.`);
    }
    return null;
}

const SCENE_FIELD_ARGS = [
    "caption", "start_image_url", "transition", "visual_transition", "visual_transition_duration",
    "card_type", "source_video_url", "audio_text",
] as const;

function shotList(items: unknown): string | undefined {
    if (!Array.isArray(items)) return undefined;
    return JSON.stringify(items.map((item) => {
        const shot = item as Args;
        return { prompt: String(shot.prompt ?? ""), duration: String(shot.duration ?? ""), ...(shot.speech ? { speech: String(shot.speech) } : {}) };
    }));
}

async function writeShots(session: StudioSession, scene: SceneData, shots: Record<string, unknown>[], text: string) {
    const result = await session.execute({ type: "scene.update", sceneId: scene.id, patch: { shotBreakdown: JSON.stringify(shots) } });
    return commandFailure("scene.update", result) ?? success(text, { sceneId: scene.id, shotCount: shots.length });
}

function shotAt(shots: Record<string, unknown>[], index: unknown, name = "shot_index"): number {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= shots.length) throw new Error(`${name} ${String(index)} is out of range (the scene has ${shots.length} shots)`);
    return i;
}

interface PlannedScene {
    input: Omit<AddSceneInput, "afterOrder">;
    patch: Partial<SceneData>;
}

/** Validates one create_scenes item and maps it to scene.add input plus a scene.update patch. */
function planScene(item: Args, position: number): PlannedScene | string {
    const sourceUrl = item.source_url as string | undefined;
    let duration = item.duration !== undefined ? Number(item.duration) : undefined;
    let cardConfig: string | undefined;
    if (item.source_start_time !== undefined || item.source_end_time !== undefined) {
        // OpenNan's source_* arguments: a source-clip scene that plays [start, end) of the source.
        const start = Number(item.source_start_time ?? 0);
        const end = item.source_end_time !== undefined ? Number(item.source_end_time) : duration !== undefined ? start + duration : undefined;
        if (end === undefined) return `Scene ${position}: source_start_time needs source_end_time or duration.`;
        if (!(end > start)) return `Scene ${position}: source_end_time must be after source_start_time.`;
        duration ??= end - start;
        cardConfig = JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end });
    }
    const patch: Partial<SceneData> = {
        ...(item.transition !== undefined ? { transition: String(item.transition) } : {}),
        ...(item.audio_text !== undefined ? { audioText: String(item.audio_text) } : {}),
        ...(item.shot_breakdown !== undefined ? { shotBreakdown: shotList(item.shot_breakdown) } : {}),
        ...(cardConfig !== undefined ? { cardConfig } : {}),
    };
    return {
        input: {
            caption: (item.caption as string | undefined) ?? "",
            ...(duration !== undefined ? { duration } : {}),
            cardType: (item.card_type as string | undefined) ?? (sourceUrl ? "source_clip" : null),
            sourceVideoUrl: (item.source_video_url as string | undefined) ?? sourceUrl ?? null,
            startImageUrl: (item.start_image_url as string | undefined) ?? null,
            videoUrl: (item.video_url as string | undefined) ?? sourceUrl ?? null,
        },
        patch,
    };
}

const createScenes: ToolHandler = async (args, { session }) => {
    const items = (args.scenes as Args[] | undefined) ?? [];
    if (items.length === 0) return failure("scenes must list at least one scene.");
    // Validate every item before the first command, so a bad item changes nothing.
    const planned: PlannedScene[] = [];
    for (const [i, item] of items.entries()) {
        const plan = planScene(item, i + 1);
        if (typeof plan === "string") return failure(plan);
        planned.push(plan);
    }
    let snap = await session.snapshot();
    const deletes = args.replace_existing === true ? snap.scenes.length : 0;
    const commands = deletes + planned.reduce((n, plan) => n + 1 + (Object.keys(plan.patch).length > 0 ? 1 : 0), 0);
    const overBudget = await undoBudget(session, commands);
    if (overBudget) return overBudget;
    if (deletes > 0) {
        for (const scene of scenesInOrder(snap.scenes)) {
            const removed = await session.execute({ type: "scene.delete", sceneId: scene.id });
            const failed = commandFailure("scene.delete", removed);
            if (failed) return failed;
        }
        snap = await session.snapshot();
    }
    let afterOrder = snap.scenes.reduce((max, scene) => Math.max(max, scene.order), -1);
    const sceneIds: string[] = [];
    for (const plan of planned) {
        const added = await session.execute({ type: "scene.add", input: { afterOrder, ...plan.input } });
        const failed = commandFailure("scene.add", added);
        if (failed) return failed;
        const sceneId = added.createdSceneIds?.[0];
        if (!sceneId) return failure("scene.add returned no scene id.");
        sceneIds.push(sceneId);
        afterOrder += 1;
        if (Object.keys(plan.patch).length > 0) {
            const updated = await session.execute({ type: "scene.update", sceneId, patch: plan.patch });
            const updateFailed = commandFailure("scene.update", updated);
            if (updateFailed) return updateFailed;
        }
    }
    return success(`Created ${sceneIds.length} scenes.`, { sceneIds });
};

const updateScene: ToolHandler = async (args, { session }) => {
    const scene = sceneByOrder(await session.snapshot(), args.scene_order);
    const patch = camelPatch(args, SCENE_FIELD_ARGS) as Partial<SceneData>;
    if (args.shot_breakdown !== undefined) patch.shotBreakdown = shotList(args.shot_breakdown);
    if (Object.keys(patch).length === 0 && args.duration === undefined) return failure("No fields to change.");
    if (Object.keys(patch).length > 0) {
        const failed = commandFailure("scene.update", await session.execute({ type: "scene.update", sceneId: scene.id, patch }));
        if (failed) return failed;
    }
    if (args.duration !== undefined) {
        // scene.trim "duration" re-times shot lists the way the editor's edge drag does.
        const trimmed = await session.execute({ type: "scene.trim", sceneId: scene.id, mode: "duration", duration: Number(args.duration) });
        const failed = commandFailure("scene.trim", trimmed);
        if (failed) return failed;
    }
    const changed = [...Object.keys(patch), ...(args.duration !== undefined ? ["duration"] : [])];
    return success(`Updated scene ${String(args.scene_order)}: ${changed.join(", ")}.`, { sceneId: scene.id });
};

const deleteScenes: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const orders = (args.scene_orders as number[] | undefined) ?? [];
    if (orders.length === 0) return failure("scene_orders must list at least one scene.");
    const targets = [...new Set(orders)].map((order) => sceneByOrder(snap, order));
    const overBudget = await undoBudget(session, targets.length);
    if (overBudget) return overBudget;
    for (const scene of targets) {
        const failed = commandFailure("scene.delete", await session.execute({ type: "scene.delete", sceneId: scene.id }));
        if (failed) return failed;
    }
    return success(`Deleted ${targets.length} scenes.`, { sceneIds: targets.map((scene) => scene.id) });
};

const reorderScenes: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const ordered = scenesInOrder(snap.scenes);
    const order = (args.new_order as number[] | undefined) ?? [];
    const valid = order.length === ordered.length && new Set(order).size === order.length && order.every((n) => Number.isInteger(n) && n >= 1 && n <= ordered.length);
    if (!valid) return failure(`new_order must list each scene order 1-${ordered.length} exactly once.`);
    const sceneIds = order.map((n) => ordered[n - 1].id);
    const failed = commandFailure("scene.reorder", await session.execute({ type: "scene.reorder", sceneIds }));
    return failed ?? success(`Reordered ${sceneIds.length} scenes.`, { sceneIds });
};

const splitScene: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const scene = sceneByOrder(snap, args.scene_order);
    const at = Number(args.at_time);
    // The same command the editor's split builds (timeline-react nle-timeline.tsx), with the optimistic plan.
    const optimistic = planSourceClipSceneSplit(snap.scenes, scene.id, at, {
        tempSceneId: `optimistic-scene-${scene.id}-${Date.now()}`,
        fallbackCaption: "",
    });
    if (!optimistic) {
        const { start, duration } = sceneSpan(snap, scene);
        return failure(
            `Scene ${String(args.scene_order)} cannot be split at ${at}s: it needs a video, and the time must be at least 0.1s inside ${round3(start)}-${round3(start + duration)}s.`,
        );
    }
    const result = await session.execute({ type: "scene.split", sceneId: scene.id, atSeconds: at, optimistic });
    const failed = commandFailure("scene.split", result);
    if (failed) return failed;
    const newSceneId = result.createdSceneIds?.[0] ?? null;
    return success(`Split scene ${String(args.scene_order)} at ${at}s; the new scene is ${newSceneId}.`, { sceneId: scene.id, newSceneId });
};

const addShot: ToolHandler = async (args, { session }) => {
    const scene = sceneByOrder(await session.snapshot(), args.scene_order);
    const shots = parseShots(scene);
    const shot: Record<string, unknown> = { prompt: String(args.prompt), duration: String(args.duration), ...(args.speech ? { speech: String(args.speech) } : {}) };
    const position = Number.isInteger(args.position) && (args.position as number) >= 0 && (args.position as number) <= shots.length
        ? (args.position as number)
        : shots.length;
    shots.splice(position, 0, shot);
    return writeShots(session, scene, shots, `Added shot ${position} to scene ${String(args.scene_order)}.`);
};

const updateShot: ToolHandler = async (args, { session }) => {
    const scene = sceneByOrder(await session.snapshot(), args.scene_order);
    const shots = parseShots(scene);
    const i = shotAt(shots, args.shot_index);
    const shot = { ...shots[i] };
    if (args.prompt !== undefined) shot.prompt = String(args.prompt);
    if (args.duration !== undefined) shot.duration = String(args.duration);
    if (args.transition !== undefined) shot.transition = String(args.transition);
    if (args.speech !== undefined) {
        const speech = String(args.speech).trim();
        if (speech) shot.speech = speech;
        else delete shot.speech;
    }
    shots[i] = shot;
    return writeShots(session, scene, shots, `Updated shot ${i} of scene ${String(args.scene_order)}.`);
};

const deleteShot: ToolHandler = async (args, { session }) => {
    const scene = sceneByOrder(await session.snapshot(), args.scene_order);
    const i = shotAt(parseShots(scene), args.shot_index);
    const result = await session.execute({ type: "shot.delete", sceneId: scene.id, shotIndex: i });
    return commandFailure("shot.delete", result) ?? success(`Deleted shot ${i} of scene ${String(args.scene_order)}.`, { sceneId: scene.id });
};

const mergeShots: ToolHandler = async (args, { session }) => {
    const scene = sceneByOrder(await session.snapshot(), args.scene_order);
    const shots = parseShots(scene);
    const target = shotAt(shots, args.target_shot_index, "target_shot_index");
    const source = shotAt(shots, args.source_shot_index, "source_shot_index");
    if (target === source) return failure("Cannot merge a shot into itself.");
    const join = (a: unknown, b: unknown) => [a, b].filter((v) => typeof v === "string" && v.trim()).join(" ");
    const merged: Record<string, unknown> = {
        ...shots[target],
        duration: String(shotUtils.shotDurationSeconds(shots[target]) + shotUtils.shotDurationSeconds(shots[source])),
        prompt: join(shots[target].prompt, shots[source].prompt),
    };
    const speech = join(shots[target].speech, shots[source].speech);
    if (speech) merged.speech = speech;
    const next = shots.map((shot, i) => (i === target ? merged : shot)).filter((_shot, i) => i !== source);
    return writeShots(session, scene, next, `Merged shot ${source} into shot ${target} of scene ${String(args.scene_order)}.`);
};

const updateProject: ToolHandler = async (args, { session }) => {
    const patch = camelPatch(args, ["name", "aspect_ratio", "music_url", "music_volume"]);
    if (Object.keys(patch).length === 0) return failure("No fields to change.");
    const result = await session.execute({ type: "project.update", patch });
    const failed = commandFailure("project.update", result);
    if (failed) return failed;
    return success(`Updated project: ${Object.keys(patch).join(", ")}.`, { project: (await session.snapshot()).project });
};

export const SCENE_HANDLERS: Record<string, ToolHandler> = {
    create_scenes: createScenes,
    update_scene: updateScene,
    delete_scenes: deleteScenes,
    reorder_scenes: reorderScenes,
    split_scene: splitScene,
    add_shot: addShot,
    update_shot: updateShot,
    delete_shot: deleteShot,
    merge_shots: mergeShots,
    update_project: updateProject,
};
