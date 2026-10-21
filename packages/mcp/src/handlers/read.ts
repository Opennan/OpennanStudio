// Read tools: answers from snapshot(), describeTimeline(), previewFrame(), uiState().
import { timelineDurationSeconds } from "@opennan/timeline-core";
import { overlaps, sceneByOrder } from "../args";
import { failure, success, unavailable } from "../outcome";
import { clipSummary, collectMedia, orderedScenes, sceneSummary } from "./summaries";
import type { ToolHandler } from "./types";

const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const sec = (n: number) => `${Math.round(n * 100) / 100}s`;

const readTimeline: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const max = typeof args.max_items === "number" && args.max_items > 0 ? args.max_items : 200;
    const includeMedia = args.include_media_urls === true;
    let from = optionalNumber(args.start_time);
    let to = optionalNumber(args.end_time);
    let scenes = orderedScenes(snap);
    const detail = args.scene_order !== undefined;
    if (detail) {
        const target = sceneByOrder(snap, args.scene_order);
        scenes = scenes.filter((entry) => entry.scene.id === target.id);
        from = Math.max(from ?? -Infinity, scenes[0].start);
        to = Math.min(to ?? Infinity, scenes[0].start + scenes[0].duration);
    }
    scenes = scenes.filter((entry) => overlaps(entry.start, entry.start + entry.duration, from, to));
    const clips = snap.clips.filter((clip) => overlaps(clip.startTime, clip.endTime, from, to));
    const filtered = detail || from !== undefined || to !== undefined;
    const data = {
        projectId: snap.projectId,
        project: snap.project,
        currentTime: snap.currentTime,
        durationSeconds: timelineDurationSeconds(snap),
        tracks: snap.tracks,
        scenes: scenes.slice(0, max).map((entry) => sceneSummary(entry, { includeMedia, includeShots: detail })),
        clips: clips.slice(0, max).map((clip) => clipSummary(clip, includeMedia)),
        markers: snap.markers,
        canUndo: snap.canUndo,
        canRedo: snap.canRedo,
        truncated: scenes.length > max || clips.length > max,
    };
    const text = filtered
        ? [
            `${scenes.length} scenes and ${clips.length} clips${from !== undefined || to !== undefined ? ` between ${sec(from ?? 0)} and ${to === undefined ? "the end" : sec(to)}` : ""}:`,
            ...scenes.slice(0, max).map((e) => `  scene ${e.sceneOrder} ${e.scene.id} at ${sec(e.start)} for ${sec(e.duration)}${e.scene.caption ? ` "${e.scene.caption}"` : ""}`),
            ...clips.slice(0, max).map((c) => `  clip ${c.id} ${c.trackType}${c.trackIndex} ${sec(c.startTime)}-${sec(c.endTime)}${c.label ? ` "${c.label}"` : ""}`),
        ].join("\n")
        : await session.describeTimeline();
    return success(text, data);
};

const findClip: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const label = typeof args.label === "string" ? args.label.toLowerCase() : null;
    const text = typeof args.text_contains === "string" ? args.text_contains.toLowerCase() : null;
    const found = snap.clips.filter((clip) => (
        (args.track_type === undefined || clip.trackType === args.track_type)
        && (args.track_index === undefined || clip.trackIndex === args.track_index)
        && overlaps(clip.startTime, clip.endTime, optionalNumber(args.start_time), optionalNumber(args.end_time))
        && (label === null || (clip.label ?? "").toLowerCase().includes(label))
        && (text === null || (clip.textContent ?? "").toLowerCase().includes(text))
    ));
    const lines = found.map((c) => `  ${c.id} ${c.trackType}${c.trackIndex} ${sec(c.startTime)}-${sec(c.endTime)}${c.label ? ` "${c.label}"` : ""}`);
    return success(found.length === 0 ? "No clips match." : [`Found ${found.length} clips:`, ...lines].join("\n"), {
        clipIds: found.map((clip) => clip.id),
        clips: found.map((clip) => clipSummary(clip)),
    });
};

const uiStateTool: ToolHandler = async (_args, { session }) => {
    const ui = await session.uiState();
    const selection = ui.selection.clipIds.length > 0
        ? `clips ${ui.selection.clipIds.join(", ")}`
        : ui.selection.sceneId ? `scene ${ui.selection.sceneId}` : "nothing";
    return success(`Playhead ${sec(ui.currentTime)}, ${ui.isPlaying ? "playing" : "paused"}; ${selection} selected; ${ui.markers.length} markers.`, { ...ui });
};

const previewTimelineFrame: ToolHandler = async (args, { session }) => {
    const width = optionalNumber(args.width);
    const height = optionalNumber(args.height);
    const frame = await session.previewFrame(Number(args.time_seconds), { width, height });
    const snap = await session.snapshot();
    const t = frame.seconds;
    const scenes = orderedScenes(snap).filter((e) => e.start <= t && t < e.start + e.duration);
    const clips = snap.clips.filter((clip) => clip.startTime <= t && t < clip.endTime);
    const visible = { scenes: scenes.map((e) => sceneSummary(e)), clips: clips.map((clip) => clipSummary(clip)) };
    const listing = [
        ...scenes.map((e) => `scene ${e.sceneOrder}${e.scene.caption ? ` "${e.scene.caption}"` : ""}`),
        ...clips.map((c) => `${c.trackType}${c.trackIndex} clip ${c.id}${c.label ? ` "${c.label}"` : ""}`),
    ].join(", ") || "nothing";
    if (frame.ok) return success(`Frame at ${sec(t)}: ${listing}.`, { seconds: t, rendered: true, visible }, [frame.frame]);
    if (frame.unavailable) {
        return success(`No frame renderer in this host. At ${sec(t)} the timeline shows: ${listing}.`, { seconds: t, rendered: false, visible, reason: frame.error });
    }
    return failure(`Could not render the frame at ${sec(t)}: ${frame.error}`, { seconds: t, rendered: false, visible });
};

const listMedia: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const type = typeof args.media_type === "string" ? args.media_type : "all";
    const search = typeof args.search === "string" ? args.search.toLowerCase() : null;
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 100;
    const media = collectMedia(snap).filter((ref) => (
        (type === "all" || ref.kind === type)
        && (search === null || ref.url.toLowerCase().includes(search) || ref.usedBy.some((u) => (u.label ?? "").toLowerCase().includes(search)))
    ));
    return success(
        media.length === 0 ? "No media matches." : [`${media.length} media files:`, ...media.slice(0, limit).map((m) => `  ${m.kind} ${m.url}`)].join("\n"),
        { media: media.slice(0, limit), truncated: media.length > limit },
    );
};

const archiveProject: ToolHandler = async (_args, { session }) => {
    const snap = await session.snapshot();
    const media = collectMedia(snap);
    return success(`Archive manifest: ${media.length} media files used by ${snap.scenes.length} scenes and ${snap.clips.length} clips.`, {
        project: snap.project,
        media,
        counts: { scenes: snap.scenes.length, clips: snap.clips.length, media: media.length },
    });
};

const listVisualEffects: ToolHandler = async (_args, { session }) => {
    if (!session.listEffects) return unavailable("This host has no effect catalog.");
    const effects = await session.listEffects("effect");
    return success(
        effects.length === 0 ? "No effects are installed." : `${effects.length} effects: ${effects.map((e) => e.id).join(", ")}.`,
        { effects: effects.map((e) => ({ id: e.id, name: e.name, category: e.category, params: e.params })) },
    );
};

export const READ_HANDLERS: Record<string, ToolHandler> = {
    read_timeline: readTimeline,
    find_clip: findClip,
    client_get_ui_state: uiStateTool,
    preview_timeline_frame: previewTimelineFrame,
    list_media: listMedia,
    archive_project: archiveProject,
    list_visual_effects: listVisualEffects,
};
