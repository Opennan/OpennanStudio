// Core clip tools: create, edit, delete, split, text overlays, and scene audio
// layers. Every write is one EditorCommand and follows placement.ts.
import { textStyle, type CreateClipInput, type TimelineClip, type TimelineTrack } from "@opennan/timeline-core";
import {
    CLIP_CONTENT_FIELDS, CLIP_LOOK_FIELDS, CLIP_PLACEMENT_FIELDS, TEXT_STYLE_ARGUMENTS, toSnakeCase,
} from "@opennan/mcp-schema";
import { camelPatch, clipById, round3, sceneByOrder, sceneSpan, type Args } from "../args";
import { commandFailure, failure, success, type ToolOutcome } from "../outcome";
import type { StudioSession } from "../session";
import { lockReason, placeClip, type PlacementRequest } from "./placement";
import { clipSummary } from "./summaries";
import type { ToolHandler } from "./types";

const CREATE_KEYS = [...CLIP_PLACEMENT_FIELDS, ...CLIP_CONTENT_FIELDS, ...CLIP_LOOK_FIELDS].map(toSnakeCase);
const EDIT_KEYS = CREATE_KEYS;
const PLACEMENT_KEYS = ["trackType", "trackIndex", "startTime", "endTime"] as const;

/** Text placement presets (timeline-core lib/timeline-editing-properties.ts:651-664 uses 0.5/0.82/0.88). */
const TEXT_POSITION_Y: Record<string, number> = { top: 0.12, center: 0.5, lower_third: 0.82, bottom: 0.88 };

const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Places a new clip by the editor's rules, creates it, and reports it. */
export async function createPlacedClip(
    session: StudioSession,
    input: Omit<CreateClipInput, "trackIndex">,
    request: PlacementRequest = {},
): Promise<ToolOutcome> {
    const startTime = Number(input.startTime);
    const endTime = Number(input.endTime);
    if (!(endTime > startTime)) return failure("end_time must be after start_time");
    const snapshot = await session.snapshot();
    const placed = placeClip(snapshot, String(input.trackType), startTime, endTime, request);
    if (!placed.ok) return failure(placed.error);
    // Omit<> over CreateClipInput's index signature drops startTime/endTime, so restate them.
    const clipInput: CreateClipInput = { ...input, startTime, endTime, trackIndex: placed.trackIndex };
    // The renderer draws registered tracks only. Create a missing lane with the clip, as one undo step.
    const type = input.trackType as TimelineTrack["type"];
    const exists = snapshot.tracks.some((track) => track.type === type && track.index === placed.trackIndex);
    const track: TimelineTrack = { type, index: placed.trackIndex, label: `${type[0].toUpperCase()}${placed.trackIndex}`, muted: false, locked: false, visible: true, volume: 1 };
    const result = await session.execute({ type: "clip.create", input: clipInput, ...(!exists ? { tracks: [...snapshot.tracks, track] } : {}) });
    const failed = commandFailure("clip.create", result);
    if (failed) return failed;
    const clipId = result.createdClipIds?.[0] ?? null;
    const clip = (await session.snapshot()).clips.find((c) => c.id === clipId);
    return success(
        `Created clip ${clipId} on ${String(input.trackType)}${placed.trackIndex} from ${startTime}s to ${endTime}s.`,
        { clipId, clip: clip ? clipSummary(clip) : null },
    );
}

export async function updateClip(session: StudioSession, clip: TimelineClip, patch: Record<string, unknown>): Promise<ToolOutcome> {
    if (Object.keys(patch).length === 0) return failure("No fields to change.");
    const result = await session.execute({ type: "clip.update", clipIds: [clip.id], patch });
    const failed = commandFailure("clip.update", result);
    if (failed) return failed;
    const after = (await session.snapshot()).clips.find((c) => c.id === clip.id);
    return success(`Updated clip ${clip.id}: ${Object.keys(patch).join(", ")}.`, { clipId: clip.id, clip: after ? clipSummary(after) : null });
}

const createTimelineClip: ToolHandler = async (args, { session }) => {
    const { trackIndex, ...input } = camelPatch(args, CREATE_KEYS);
    return createPlacedClip(session, input as Omit<CreateClipInput, "trackIndex">, { requested: Number(trackIndex) });
};

/** Font arguments merged into the clip's textStyle JSON. */
function mergeTextStyle(args: Args, base: string | null): string | null {
    const entries = Object.entries(TEXT_STYLE_ARGUMENTS).filter(([arg]) => args[arg] !== undefined);
    if (entries.length === 0) return null;
    const style = textStyle.parseTimelineTextStyle(base);
    for (const [arg, key] of entries) {
        const value = args[arg];
        if (arg === "bold") style[key] = value ? "bold" : "normal";
        else if (arg === "italic") style[key] = value ? "italic" : "normal";
        else style[key] = value;
    }
    return JSON.stringify(style);
}

const editTimelineClip: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const clip = clipById(snap, args.clip_id);
    // Unlocking is the one edit a locked clip allows, like the editor's lock toggle.
    const unlockOnly = args.locked === false && Object.keys(args).every((key) => key === "clip_id" || key === "locked");
    const locked = unlockOnly ? null : lockReason(snap, clip);
    if (locked) return failure(locked);
    const patch = camelPatch(args, EDIT_KEYS);
    const style = mergeTextStyle(args, (patch.textStyle as string | null | undefined) ?? clip.textStyle);
    if (style !== null) patch.textStyle = style;
    // A trim edit without new times also moves the clip's end, as an edge drag does.
    // trimEnd is the source out-point (timeline-core lib/timeline-optimistic.ts:355-364).
    const trims = patch.trimStart !== undefined || patch.trimEnd !== undefined;
    if (trims && patch.startTime === undefined && patch.endTime === undefined) {
        const speed = clip.playbackSpeed > 0 ? clip.playbackSpeed : 1;
        const inPoint = Number(patch.trimStart ?? clip.trimStart ?? 0);
        const outPoint = patch.trimEnd !== undefined ? (patch.trimEnd as number | null) : clip.trimEnd;
        const span = outPoint !== null && outPoint !== undefined
            ? (outPoint - inPoint) / speed
            : (clip.endTime - clip.startTime) - (inPoint - (clip.trimStart ?? 0)) / speed;
        if (span < 0.1) {
            return failure(`That trim leaves less than 0.1s of the clip (${round3(clip.endTime - clip.startTime)}s long). Nothing was changed.`);
        }
        patch.endTime = round3(clip.startTime + span);
    }
    // A new track or time range must be editable and free, as when a person drags the clip.
    if (PLACEMENT_KEYS.some((key) => patch[key] !== undefined)) {
        const start = Number(patch.startTime ?? clip.startTime);
        const end = Number(patch.endTime ?? clip.endTime);
        if (!(end > start)) return failure("end_time must be after start_time");
        const placed = placeClip(snap, String(patch.trackType ?? clip.trackType), start, end, {
            requested: Number(patch.trackIndex ?? clip.trackIndex),
            ignoreClipId: clip.id,
        });
        if (!placed.ok) return failure(placed.error);
    }
    return updateClip(session, clip, patch);
};

const deleteTimelineClip: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const clip = clipById(snap, args.clip_id);
    const locked = lockReason(snap, clip);
    if (locked) return failure(locked);
    const result = await session.execute({ type: "clip.delete", clipIds: [clip.id] });
    return commandFailure("clip.delete", result) ?? success(`Deleted clip ${clip.id}.`, { clipId: clip.id });
};

const splitTimelineClip: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const clip = clipById(snap, args.clip_id);
    const locked = lockReason(snap, clip);
    if (locked) return failure(locked);
    const at = Number(args.at_time);
    if (!(at > clip.startTime && at < clip.endTime)) {
        return failure(`at_time must be inside the clip (${round3(clip.startTime)}s to ${round3(clip.endTime)}s).`);
    }
    const result = await session.execute({ type: "clip.split", clipIds: [clip.id], atSeconds: at });
    const failed = commandFailure("clip.split", result);
    if (failed) return failed;
    const newClipId = result.createdClipIds?.[0] ?? null;
    return success(`Split clip ${clip.id} at ${at}s; the right part is ${newClipId}.`, { clipId: clip.id, newClipId });
};

const addTextOverlay: ToolHandler = async (args, { session }) => {
    const style: Record<string, unknown> = {};
    if (args.font_size !== undefined) style.fontSize = args.font_size;
    if (args.font_color !== undefined) style.color = args.font_color;
    return createPlacedClip(session, {
        trackType: "text",
        startTime: Number(args.start_time),
        endTime: Number(args.end_time),
        textContent: String(args.text),
        positionX: optionalNumber(args.position_x) ?? 0.5,
        positionY: optionalNumber(args.position_y) ?? TEXT_POSITION_Y[(args.position as string | undefined) ?? "center"],
        scale: optionalNumber(args.scale) ?? 1,
        opacity: optionalNumber(args.opacity) ?? 1,
        ...camelPatch(args, ["fade_in_duration", "fade_out_duration", "transition_type", "transition_duration", "rotation_degrees"]),
        ...(Object.keys(style).length > 0 ? { textStyle: JSON.stringify(style) } : {}),
    }, { requested: optionalNumber(args.track_index) });
};

const addAudioLayer: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const scene = sceneByOrder(snap, args.scene_order);
    const { start, duration } = sceneSpan(snap, scene);
    const offset = Number(args.offset ?? 0);
    if (!(offset >= 0 && offset < duration)) return failure(`offset must be between 0 and the scene length (${round3(duration)}s).`);
    return createPlacedClip(session, {
        trackType: "audio",
        startTime: round3(start + offset),
        endTime: round3(start + duration),
        mediaUrl: String(args.url),
        sceneId: scene.id,
        label: String(args.type),
        volume: optionalNumber(args.volume) ?? 1,
    });
};

export const CLIP_HANDLERS: Record<string, ToolHandler> = {
    create_timeline_clip: createTimelineClip,
    edit_timeline_clip: editTimelineClip,
    delete_timeline_clip: deleteTimelineClip,
    split_timeline_clip: splitTimelineClip,
    add_text_overlay: addTextOverlay,
    add_audio_layer: addAudioLayer,
};
