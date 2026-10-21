// Library actions shared by clicks, keyboard activation, and tests. Every write is one controller
// command (one undo step), the same commands agents run through MCP.
import {
    selectLiveScenes, type EditorStore, type TimelineController,
} from "@opennan/timeline-core";
import { sceneJunctions } from "@opennan/timeline-core/lib/scene-transitions";
import { clipJunction } from "@opennan/timeline-core/looks/windows";
import { DEFAULT_FILTER_INTENSITY } from "@opennan/timeline-core/looks/filters";
import type { SelectionTarget } from "./selection";

export type ActionResult = { ok: true; target: "scene" | "clip" | "layer" } | { ok: false; reason: "no-target" | "failed" };

/**
 * The cut a transition click applies to: the selected transition, the selected scene's cut to the next
 * scene, the selected upper-track video/image clip's cut (its own cut to the next touching clip, else the
 * previous clip's cut into it; phase 10b), else the scene cut nearest the playhead.
 */
export async function applyTransition(controller: TimelineController, store: EditorStore, selection: SelectionTarget, transitionId: string): Promise<ActionResult> {
    const state = store.getState();
    const scenes = selectLiveScenes(state);
    const junctions = sceneJunctions(scenes, state.timelineData?.tracks ?? []).filter((j) => j.editable);
    let command: Parameters<TimelineController["execute"]>[0] | null = null;
    if (selection?.kind === "transition") {
        command = selection.transition.kind === "scene"
            ? { type: "transition.set", sceneId: selection.transition.id, transition: transitionId }
            : { type: "transition.set", clipId: selection.transition.id, transition: transitionId };
    } else if (selection?.kind === "scene") {
        const outgoing = junctions.find((j) => j.sceneId === selection.scene.id);
        const incoming = junctions.find((j) => j.nextSceneId === selection.scene.id);
        const junction = outgoing ?? incoming;
        if (junction) command = { type: "transition.set", sceneId: junction.sceneId, transition: transitionId };
    } else if (selection?.kind === "clip") {
        const junction = clipJunction(state.timelineData?.clips ?? [], selection.clip.id);
        const track = state.timelineData?.tracks.find((t) => t.type === "video" && t.index === selection.clip.trackIndex);
        if (junction && !track?.locked) command = { type: "transition.set", clipId: junction.outgoingId, transition: transitionId };
    } else if (junctions.length > 0) {
        const t = state.currentTime;
        const nearest = junctions.reduce((best, j) => (Math.abs(j.cut - t) < Math.abs(best.cut - t) ? j : best));
        command = { type: "transition.set", sceneId: nearest.sceneId, transition: transitionId };
    }
    if (!command) return { ok: false, reason: "no-target" };
    const result = await controller.execute(command, { toastOnError: false });
    if (!result.ok) return { ok: false, reason: result.error?.includes("no next") ? "no-target" : "failed" };
    const sceneId = "sceneId" in command ? command.sceneId : undefined;
    const clipId = "clipId" in command ? command.clipId : undefined;
    if (sceneId) state.selectTransition({ kind: "scene", id: sceneId });
    else if (clipId) state.selectTransition({ kind: "clip", id: clipId });
    return { ok: true, target: sceneId ? "scene" : "clip" };
}

/** A look target: one scene or clip, or (phase 10c group mode) several through `targets`. */
export type LookTargets = { sceneId: string } | { clipId: string } | { targets: Array<{ clipId?: string; sceneId?: string }> };

export async function applyFilter(controller: TimelineController, target: LookTargets | null, filterId: string, intensity = DEFAULT_FILTER_INTENSITY): Promise<ActionResult> {
    if (!target) return { ok: false, reason: "no-target" };
    const result = await controller.execute({ type: "look.set", ...target, filter: filterId, intensity }, { toastOnError: false });
    return result.ok ? { ok: true, target: "sceneId" in target ? "scene" : "clip" } : { ok: false, reason: "failed" };
}

/** Adds an effect to the selected scene/clip, or as a 3 s effect layer at the playhead. */
export async function addEffect(controller: TimelineController, store: EditorStore, target: LookTargets | null, effectId: string): Promise<ActionResult> {
    if (target) {
        const result = await controller.execute({ type: "clip.effect.add", ...target, effectId }, { toastOnError: false });
        return result.ok ? { ok: true, target: "sceneId" in target ? "scene" : "clip" } : { ok: false, reason: "failed" };
    }
    return addEffectLayer(controller, store, effectId, store.getState().currentTime);
}

export async function addEffectLayer(controller: TimelineController, _store: EditorStore, effectId: string, at: number, seconds = 3): Promise<ActionResult> {
    // Track (when none is free), clip, and effect row as one command: one undo step, no empty layer on failure.
    const start = Math.max(0, at);
    const result = await controller.execute({ type: "effect.layer.add", effectId, startTime: start, endTime: start + seconds }, { toastOnError: false });
    return result.ok ? { ok: true, target: "layer" } : { ok: false, reason: "failed" };
}
