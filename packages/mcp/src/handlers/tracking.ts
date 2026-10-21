// track_motion (phase 10d): local motion tracking for agents. The handler runs the editor's two tracking commands:
// tracking.run (the host's decoder and tracker: the open editor window on desktop and web; headless `mcp serve`
// cannot decode video and answers unavailable) and tracking.apply (follower keyframes, one undo_last_edit group).
import type { TrackingFollower, TrackingReport, TrackingRunOutput } from "@opennan/timeline-core";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core";
import { clipById, round3, sceneByOrder, type Args } from "../args";
import { commandFailureText, failure, success, unavailable } from "../outcome";
import type { ToolHandler } from "./types";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const REASONS: Record<string, string> = {
    "not-found": "not found",
    pending: "still being created",
    locked: "on a locked or hidden track",
    "tracked-item": "is the tracked item",
    "no-position": "an effect layer has no position to move",
    "not-visual": "audio has no picture",
    "no-overlap": "does not overlap the tracked span",
    "no-room": "fills the frame, so its position cannot move",
    "no-mask": "the tracked item has no mask (set_mask adds one)",
    duplicate: "listed twice",
};

const trackMotion: ToolHandler = async (args: Args, { session, signal }) => {
    const snap = await session.snapshot();
    const hasClip = args.clip_id !== undefined;
    const hasScene = args.scene_order !== undefined;
    if (hasClip === hasScene) return failure("track_motion needs clip_id or scene_order (one of them).");
    let owner: { clipId: string } | { sceneId: string };
    let label: string;
    let start: number;
    let duration: number;
    if (hasScene) {
        const scene = sceneByOrder(snap, args.scene_order);
        owner = { sceneId: scene.id };
        label = `scene ${String(args.scene_order)}`;
        start = getSceneStart(scene, snap.scenes, snap.scenes.indexOf(scene));
        duration = getSceneDuration(scene);
    } else {
        const clip = clipById(snap, args.clip_id);
        if (clip.trackType !== "video") return failure(`Clip ${clip.id} is a ${clip.trackType} clip; track_motion follows video clips and main-track clips (scene_order).`);
        owner = { clipId: clip.id };
        label = `clip ${clip.id}`;
        start = clip.startTime;
        duration = clip.endTime - clip.startTime;
    }
    const region = args.region as Record<string, unknown> | undefined;
    if (!region || !["x", "y", "width", "height"].every((key) => isNumber(region[key]))) return failure("region needs numeric x, y, width, and height (fractions of the picture).");
    const followers: TrackingFollower[] = [];
    if (args.follower_clip_ids !== undefined) {
        if (!Array.isArray(args.follower_clip_ids) || args.follower_clip_ids.some((id) => typeof id !== "string")) return failure("follower_clip_ids must be a list of clip ids.");
        for (const id of args.follower_clip_ids as string[]) followers.push({ clipId: id });
    }
    if (args.follow_mask === true) followers.push({ mask: true });
    if (followers.length === 0) return failure("track_motion needs follower_clip_ids or follow_mask: nothing would move with the track.");
    for (const key of ["time", "start", "end"] as const) {
        if (args[key] !== undefined && !isNumber(args[key])) return failure(`${key} must be a number of item-local seconds.`);
    }
    const playhead = snap.currentTime - start;
    const time = isNumber(args.time) ? args.time : playhead >= 0 && playhead <= duration ? round3(playhead) : 0;
    const range = isNumber(args.start) || isNumber(args.end)
        ? { start: isNumber(args.start) ? args.start : 0, end: isNumber(args.end) ? args.end : duration }
        : undefined;

    const run = await session.execute({
        type: "tracking.run", ...owner, time, ...(range ? { range } : {}),
        region: { x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height) },
    }, { signal });
    if (!run.ok) {
        if (run.unavailable) {
            const cause = run.error && !/^tracking\.run needs a motion tracker/.test(run.error) ? ` ${run.error}` : "";
            return unavailable(`track_motion needs an editor window that can decode video (OpenNan Studio desktop or web); this host has no motion tracker.${cause}`);
        }
        if (run.cancelled) return failure("track_motion was cancelled.");
        return failure(commandFailureText("tracking.run", run.error));
    }
    const tracked = run.output as TrackingRunOutput;
    const apply = await session.execute({ type: "tracking.apply", ...owner, samples: tracked.samples, source: tracked.source, followers });
    const summary = { ...owner, frames: tracked.samples.length, lost: tracked.lost, fps: round3(tracked.fps) };
    if (!apply.ok) return failure(`Tracked ${tracked.samples.length} frames of ${label}, but no follower moved: ${apply.error ?? "unknown error"}`, summary);
    const report = apply.output as TrackingReport;
    const name = (entry: { clipId?: string; sceneId?: string; mask?: true }) => (entry.mask ? "the mask" : entry.clipId ? `clip ${entry.clipId}` : `scene ${entry.sceneId}`);
    const applied = report.applied.map((a) => `${name(a)} (${a.keyframes} keyframes${a.approximate ? ", box size estimated" : ""})`).join(", ");
    const skipped = report.skipped.map((s) => `${name(s)}: ${REASONS[s.reason] ?? s.reason}`).join("; ");
    const lost = tracked.lost > 0 ? `, ${tracked.lost} lost and held in place` : "";
    return success(
        `Tracked ${tracked.samples.length} frames of ${label}${lost}. Following: ${applied}.${skipped ? ` Skipped: ${skipped}.` : ""} undo_last_edit removes the keyframes.`,
        { ...summary, applied: report.applied, skipped: report.skipped },
    );
};

export const TRACKING_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    track_motion: trackMotion,
};
