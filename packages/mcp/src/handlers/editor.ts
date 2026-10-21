// Tracks, history, editor state, host UI, export, and the generic command tool.
import type { EditorCommand, TimelineTrack } from "@opennan/timeline-core";
import { commandSchema } from "@opennan/mcp-schema";
import Ajv, { type ValidateFunction } from "ajv";
import { round3, type Args } from "../args";
import type { ExportJobStatus } from "../export";
import { commandFailure, failure, success, unavailable } from "../outcome";
import { undoStepsFor } from "../tool-calls";
import type { ToolHandler } from "./types";

const TRACK_LETTER: Record<string, string> = { video: "V", audio: "A", text: "T", sticker: "S" };

const manageTimelineTracks: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const listing = snap.tracks.map((t) => `${t.type}${t.index}${t.muted ? " muted" : ""}${t.locked ? " locked" : ""}${t.visible ? "" : " hidden"}`).join(", ");
    if (args.action === "list") return success(`Tracks: ${listing || "none"}.`, { tracks: snap.tracks });
    const type = args.track_type as TimelineTrack["type"] | undefined;
    if (!type) return failure("track_type is required to add or update a track.");
    const sameType = snap.tracks.filter((t) => t.type === type);
    if (args.action === "add") {
        const index = (args.track_index as number | undefined) ?? Math.max(0, ...sameType.map((t) => t.index)) + 1;
        if (sameType.some((t) => t.index === index)) return failure(`Track ${type}${index} already exists.`);
        const track: TimelineTrack = {
            type, index, label: `${TRACK_LETTER[type] ?? type}${index}`,
            muted: (args.muted as boolean | undefined) ?? false,
            locked: (args.locked as boolean | undefined) ?? false,
            visible: (args.visible as boolean | undefined) ?? true,
            volume: (args.volume as number | undefined) ?? 1,
        };
        const result = await session.execute({ type: "track.update", tracks: [...snap.tracks, track] });
        return commandFailure("track.update", result) ?? success(`Added track ${type}${index}.`, { track });
    }
    const index = args.track_index as number | undefined;
    const current = sameType.find((t) => t.index === index);
    if (!current) return failure(`Track ${type}${String(index)} does not exist.`);
    const patch: Partial<TimelineTrack> = {};
    for (const key of ["muted", "locked", "visible", "volume"] as const) {
        if (args[key] !== undefined) (patch as Args)[key] = args[key];
    }
    if (Object.keys(patch).length === 0) return failure("Pass muted, locked, visible, or volume to update a track.");
    const next = snap.tracks.map((t) => (t === current ? { ...t, ...patch } : t));
    const result = await session.execute({ type: "track.update", tracks: next });
    return commandFailure("track.update", result) ?? success(`Updated track ${type}${String(index)}: ${Object.keys(patch).join(", ")}.`, { track: { ...current, ...patch } });
};

/** Undoes the last `steps` tool calls, each as a whole (tool-calls.ts keeps the undo entries per call). */
const undoLastEdit: ToolHandler = async (args, { session, history }) => {
    const calls = Math.min(50, Math.max(1, Math.floor(Number(args.steps ?? 1))));
    const depth = await session.historyDepth?.();
    if (depth && depth.undo === 0) return failure("Nothing to undo.");
    // Without historyDepth the host cannot group, so one call is one edit.
    const steps = depth ? undoStepsFor(history, calls, depth.undo) : calls;
    const result = await session.execute({ type: "history.undo", steps });
    if (!result.ok && result.error === "nothing to undo") return failure("Nothing to undo.");
    const failed = commandFailure("history.undo", result);
    if (failed) return failed;
    if (depth) {
        history.groups.splice(Math.max(0, history.groups.length - calls), calls);
        history.undoneByTool = true;
    }
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return success(`Undid ${plural(calls, "tool call")} (${plural(steps, "edit")}).`, { calls, steps, canUndo: (await session.snapshot()).canUndo });
};

const clientPlayback: ToolHandler = async (args, { session }) => {
    const time = args.time as number | undefined;
    if (args.action === "seek" && time === undefined) return failure("time is required to seek.");
    if (time !== undefined) {
        const seek = await session.execute({ type: "playhead.seek", seconds: time });
        const failed = commandFailure("playhead.seek", seek);
        if (failed) return failed;
    }
    if (args.action !== "seek") {
        const play = await session.execute({ type: "playback.set", playing: args.action === "play" });
        const failed = commandFailure("playback.set", play);
        if (failed) return failed;
    }
    const ui = await session.uiState();
    return success(`${ui.isPlaying ? "Playing" : "Paused"} at ${ui.currentTime}s.`, { currentTime: ui.currentTime, isPlaying: ui.isPlaying });
};

const clientSelectClip: ToolHandler = async (args, { session }) => {
    const ids = (args.clip_ids as string[] | undefined) ?? [];
    const known = new Set((await session.snapshot()).clips.map((clip) => clip.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) return failure(`Unknown clip ids: ${unknown.join(", ")}.`);
    const result = await session.execute({ type: "selection.set", clipIds: ids });
    return commandFailure("selection.set", result) ?? success(ids.length === 0 ? "Cleared the clip selection." : `Selected ${ids.join(", ")}.`, { clipIds: ids });
};

const clientAddMarker: ToolHandler = async (args, { session }) => {
    const before = new Set((await session.uiState()).markers.map((marker) => marker.id));
    const result = await session.execute({ type: "marker.add", time: Number(args.time), label: args.label as string | undefined });
    const failed = commandFailure("marker.add", result);
    if (failed) return failed;
    const marker = (await session.uiState()).markers.find((m) => !before.has(m.id)) ?? null;
    return success(marker ? `Added marker ${marker.id} at ${marker.time}s.` : "Added marker.", { marker });
};

const clientRemoveMarker: ToolHandler = async (args, { session }) => {
    const id = String(args.marker_id);
    if (!(await session.uiState()).markers.some((marker) => marker.id === id)) return failure(`Marker not found: ${id}.`);
    const result = await session.execute({ type: "marker.remove", markerId: id });
    return commandFailure("marker.remove", result) ?? success(`Removed marker ${id}.`, { markerId: id });
};

const clientOpenPanel: ToolHandler = async (args, { session }) => {
    if (!session.host.openPanel) return unavailable("Opening panels needs the editor UI (desktop or web app).");
    await session.host.openPanel(String(args.panel));
    return success(`Opened the ${String(args.panel)} panel.`, { panel: args.panel });
};

const clientSnapshotPage: ToolHandler = async (_args, { session }) => {
    if (!session.host.snapshotPage) return unavailable("Screenshots need the editor UI (desktop or web app).");
    const image = await session.host.snapshotPage();
    return success("Screenshot of the editor.", { width: image.width, height: image.height }, [image]);
};

/** export.start through the host's exporter (Task 12b); without one the controller answers unavailable. */
const assembleVideo: ToolHandler = async (args, { session }) => {
    const options = {
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        ...(args.format !== undefined ? { format: args.format } : {}),
    };
    const result = await session.execute({ type: "export.start", options });
    if (result.unavailable) return unavailable(result.error ?? "This host cannot export.");
    // The exporter's own refusal text: export.start has no UI toast in DEFAULT_COMMAND_ERROR_MESSAGES.
    if (!result.ok) return failure(result.error ?? "The export did not start.");
    return success(`Export ${result.jobId} started. get_export_status reports its progress and output file.`, { jobId: result.jobId ?? null });
};

/** export.cancel through the host's exporter (phase 10d). */
const cancelExport: ToolHandler = async (args, { session }) => {
    const jobId = typeof args.job_id === "string" && args.job_id ? args.job_id : undefined;
    const result = await session.execute({ type: "export.cancel", ...(jobId ? { jobId } : {}) });
    if (result.unavailable) return unavailable(result.error ?? "This host cannot cancel exports.");
    if (!result.ok) return failure(result.error ?? "The export could not be cancelled.");
    const id = result.jobId ?? jobId ?? null;
    return success(`Export ${id ?? ""} cancelled.`.replace("  ", " "), { jobId: id });
};

function describeExportJob(job: ExportJobStatus): string {
    switch (job.status) {
        case "running":
            return `Export ${job.jobId} is running (${job.phase}, ${Math.round(job.ratio * 100)}%).`;
        case "done": {
            const output = job.output.kind === "file" ? job.output.path : `${job.output.size} bytes`;
            const warnings = job.warnings.length > 0 ? `, ${job.warnings.length} warning${job.warnings.length === 1 ? "" : "s"}` : "";
            return `Export ${job.jobId} finished: ${output} (${job.width}x${job.height}, ${round3(job.durationSeconds)}s, ${job.encoder}${warnings}).`;
        }
        case "error":
            return `Export ${job.jobId} failed: ${job.message}`;
        case "cancelled":
            return `Export ${job.jobId} was cancelled.`;
    }
}

const getExportStatus: ToolHandler = async (args, { session }) => {
    if (!session.exportStatus) return unavailable("This host has no exporter. Start `opennan-studio mcp serve` with --ffmpeg, or use the desktop app.");
    const jobId = String(args.job_id);
    const job = await session.exportStatus(jobId);
    if (!job) return failure(`No export job ${jobId} in this session.`);
    return success(describeExportJob(job), { ...job });
};

const commandAjv = new Ajv({ strict: false, allErrors: true });
const commandValidators = new Map<string, ValidateFunction>();

/** Validates against the full generated schema of that command (the tool lists a compact one). */
function validateCommand(command: Args): string | null {
    const type = String(command.type);
    let validate = commandValidators.get(type);
    if (!validate) {
        const schema = commandSchema(type);
        if (!schema) return `Unknown editor command type ${type}.`;
        validate = commandAjv.compile(schema);
        commandValidators.set(type, validate);
    }
    return validate(command) ? null : `Invalid ${type} command: ${commandAjv.errorsText(validate.errors, { dataVar: "command" })}`;
}

const runEditorCommand: ToolHandler = async (args, { session }) => {
    const invalid = validateCommand(args.command as Args);
    if (invalid) return failure(invalid);
    const command = args.command as EditorCommand;
    const result = await session.execute(command);
    return commandFailure(command.type, result) ?? success(`${command.type} done.`, { result });
};

export const EDITOR_HANDLERS: Record<string, ToolHandler> = {
    manage_timeline_tracks: manageTimelineTracks,
    undo_last_edit: undoLastEdit,
    client_playback: clientPlayback,
    client_select_clip: clientSelectClip,
    client_add_marker: clientAddMarker,
    client_remove_marker: clientRemoveMarker,
    client_open_panel: clientOpenPanel,
    client_snapshot_page: clientSnapshotPage,
    assemble_video: assembleVideo,
    get_export_status: getExportStatus,
    cancel_export: cancelExport,
    run_editor_command: runEditorCommand,
};
