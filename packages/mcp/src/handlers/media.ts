// Local media, graphics clips, and clip effects. Same placement rules as clips.ts.
import type { MediaKind } from "@opennan/timeline-core";
import { GRAPHICS_TEMPLATES } from "@opennan/timeline-core/graphics/templates";
import { camelPatch, clipById, round3, type Args } from "../args";
import { commandFailure, failure, success, unavailable } from "../outcome";
import { createPlacedClip, updateClip } from "./clips";
import { commandTarget, lookTarget } from "./looks";
import { lockReason, placeClip } from "./placement";
import type { ToolHandler } from "./types";

const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function publishLocal(kind: Extract<MediaKind, "audio" | "video">, firstIndex: number): ToolHandler {
    return async (args, { session }) => {
        const readFile = session.host.readFile;
        if (!readFile) return unavailable("This host cannot read local files. Use the desktop app or `opennan-studio mcp serve`.");
        if (!session.uploadFile) return unavailable("This host cannot import media.");
        const duration = Number(args.duration);
        if (!(duration > 0)) return failure("duration must be greater than 0.");
        const startTime = Number(args.start_time ?? 0);
        const endTime = round3(startTime + duration);
        // Placement first: a refused call imports nothing.
        const placed = placeClip(await session.snapshot(), kind, startTime, endTime, { requested: optionalNumber(args.track_index), firstIndex });
        if (!placed.ok) return failure(placed.error);
        const file = await readFile(String(args.local_path), kind);
        const media = await session.uploadFile(file, kind);
        return createPlacedClip(session, {
            trackType: kind,
            startTime,
            endTime,
            mediaUrl: media.url,
            mediaType: "uploaded",
            label: (args.label as string | undefined) ?? media.name,
        }, { requested: placed.trackIndex });
    };
}

const addGraphicsClip: ToolHandler = async (args, { session }) => {
    const templateId = String(args.template_id);
    // A host with a Remotion add-on lists its own templates; every other host draws the built-in ones.
    const installed = (await session.host.graphicsTemplateIds?.()) ?? GRAPHICS_TEMPLATES.map((template) => template.id);
    if (!installed.includes(templateId)) {
        return failure(`Unknown graphics template ${templateId}. Available templates: ${installed.join(", ") || "none"}.`);
    }
    const template = GRAPHICS_TEMPLATES.find((entry) => entry.id === templateId);
    const defaults = Object.fromEntries((template?.params ?? []).map((param) => [param.key, param.default]));
    const props = args.props && typeof args.props === "object" ? (args.props as Record<string, unknown>) : {};
    // Same clip shape as the editor's template drop and the Graphics library (defaults merged with the given props).
    return createPlacedClip(session, {
        trackType: "remotion",
        startTime: Number(args.start_time),
        endTime: Number(args.end_time),
        label: template?.name ?? templateId,
        remotionTemplateId: templateId,
        remotionPropsJson: JSON.stringify({ ...defaults, ...props }),
    }, { requested: optionalNumber(args.track_index) });
};

const listGraphicsTemplates: ToolHandler = async (args) => {
    const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : null;
    const templates = GRAPHICS_TEMPLATES.filter((template) => !category || template.category === category).map((template) => ({
        id: template.id, name: template.name, category: template.category, description: template.description,
        props: template.params.map(({ key, label, type, default: value, min, max, step, options }) => ({ key, label, type, default: value, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}), ...(options ? { options } : {}) })),
    }));
    if (category && templates.length === 0) return failure(`Unknown graphics category ${category}. Categories: ${[...new Set(GRAPHICS_TEMPLATES.map((t) => t.category))].join(", ")}.`);
    return success(`${templates.length} graphics templates: ${templates.map((t) => t.id).join(", ")}.`, { templates });
};

const updateGraphicsClip: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const clip = clipById(snap, args.clip_id);
    if (clip.trackType !== "remotion") return failure(`Clip ${clip.id} is not a graphics clip.`);
    const locked = lockReason(snap, clip);
    if (locked) return failure(locked);
    const patch = camelPatch(args, ["start_time", "end_time", "track_index"]);
    if (Object.keys(patch).length > 0) {
        const start = Number(patch.startTime ?? clip.startTime);
        const end = Number(patch.endTime ?? clip.endTime);
        if (!(end > start)) return failure("end_time must be after start_time");
        const placed = placeClip(snap, "remotion", start, end, { requested: Number(patch.trackIndex ?? clip.trackIndex), ignoreClipId: clip.id });
        if (!placed.ok) return failure(placed.error);
    }
    if (args.props !== undefined) {
        let current: Record<string, unknown> = {};
        try {
            current = JSON.parse(clip.remotionPropsJson || "{}");
        } catch {
            current = {};
        }
        patch.remotionPropsJson = JSON.stringify({ ...current, ...(args.props as Record<string, unknown>) });
    }
    return updateClip(session, clip, patch);
};

const applyVisualEffect: ToolHandler = async (args, { session, tool }) => {
    const snap = await session.snapshot();
    const effectId = String(args.effect_id);
    if (session.listEffects) {
        const catalog = await session.listEffects("effect");
        if (!catalog.some((effect) => effect.id === effectId)) return failure(`Unknown effect ${effectId}. list_visual_effects lists the installed ones.`);
    }
    const params = args.params && typeof args.params === "object" ? args.params as Record<string, unknown> : null;
    if (args.clip_id === undefined && args.scene_order === undefined) {
        // A time range without a target: an effect layer over the composite (the editor's effect track).
        const start = Number(args.start_time);
        const end = Number(args.end_time);
        if (!(end > start) || !(start >= 0)) return failure(`${tool.name} needs clip_id, scene_order, or start_time and end_time for an effect layer.`);
        const tracks = snap.tracks;
        const lanes = tracks.filter((t) => t.type === "effect" && !t.locked).map((t) => t.index).sort((a, b) => a - b);
        let index = lanes.find((lane) => !snap.clips.some((c) => c.trackType === "effect" && c.trackIndex === lane && c.startTime < end && c.endTime > start));
        if (index === undefined) {
            index = Math.max(0, ...tracks.filter((t) => t.type === "effect").map((t) => t.index)) + 1;
            const added = await session.execute({ type: "track.update", tracks: [...tracks, { type: "effect", index, label: `FX${index}`, muted: false, locked: false, visible: true, volume: 1 }] });
            const trackFailed = commandFailure("track.update", added);
            if (trackFailed) return trackFailed;
        }
        const created = await session.execute({ type: "clip.create", input: { trackType: "effect", trackIndex: index, startTime: start, endTime: end, label: effectId } });
        const createFailed = commandFailure("clip.create", created);
        if (createFailed) return createFailed;
        const clipId = created.createdClipIds?.[0];
        if (!clipId) return failure("The effect layer was not created.");
        const added = await session.execute({ type: "clip.effect.add", clipId, effectId, params });
        return commandFailure("clip.effect.add", added) ?? success(`Added ${effectId} as an effect layer from ${start} s to ${end} s.`, { clipId, effectId });
    }
    const target = lookTarget(snap, args, tool.name);
    if (typeof target === "string") return failure(target);
    const added = await session.execute({ type: "clip.effect.add", ...commandTarget(target), effectId, params });
    const addFailed = commandFailure("clip.effect.add", added);
    if (addFailed) return addFailed;
    const after = await session.snapshot();
    const rows = "sceneId" in target ? after.scenes.find((s) => s.id === target.sceneId)?.effects : after.clips.find((c) => c.id === target.clipId)?.effects;
    const row = [...(rows ?? [])].sort((a, b) => b.order - a.order).find((effect) => effect.effectId === effectId);
    return success(`Applied ${effectId} to ${target.label}.`, { ...commandTarget(target), effectRowId: row?.id ?? null });
};

const removeVisualEffect: ToolHandler = async (args, { session, tool }) => {
    const snap = await session.snapshot();
    const target = lookTarget(snap, args, tool.name);
    if (typeof target === "string") return failure(target);
    const rows = "sceneId" in target ? snap.scenes.find((s) => s.id === target.sceneId)?.effects : snap.clips.find((c) => c.id === target.clipId)?.effects;
    const remove = args.delete === true;
    const row = (rows ?? []).find((effect) => (remove || effect.enabled) && (effect.id === args.effect_id || effect.effectId === args.effect_id));
    if (!row) return failure(`${target.label} has no ${remove ? "" : "active "}effect ${String(args.effect_id)}.`);
    if (remove) {
        const result = await session.execute({ type: "clip.effect.remove", effectRowId: row.id });
        return commandFailure("clip.effect.remove", result) ?? success(`Removed ${row.effectId} from ${target.label}.`, { ...commandTarget(target), effectRowId: row.id });
    }
    const result = await session.execute({ type: "clip.effect.update", effectRowId: row.id, patch: { enabled: false } });
    return commandFailure("clip.effect.update", result) ?? success(`Turned off ${row.effectId} on ${target.label}.`, { ...commandTarget(target), effectRowId: row.id });
};

export const MEDIA_HANDLERS: Record<string, ToolHandler> = {
    publish_audio_to_timeline: publishLocal("audio", 1),
    publish_video_to_timeline: publishLocal("video", 2),
    add_graphics_clip: addGraphicsClip,
    list_graphics_templates: listGraphicsTemplates,
    update_graphics_clip: updateGraphicsClip,
    apply_visual_effect: applyVisualEffect,
    remove_visual_effect: removeVisualEffect,
};
