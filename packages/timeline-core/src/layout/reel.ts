// Reel layout (story film): a 9:16 canvas, black around a 16:9 film, a short title just above the film, music under it.
// The numbers are the prototype's (1080×1920 frame: film 1080×608 at y = 656, the title bold white 46 px with its
// baseline 34 px above the film, music faded in 0.5 s and out 2.5 s). The film is the clips on V1 as scenes fitted
// "contain" (so any 16:9 source fills the width, centred); the title is a text clip and the music an audio clip, so
// preview and both export paths draw them with the same code as every other scene, text, and audio clip.
// planReelLayout is pure (the commands, in order); applyReelLayout runs them through an executor (a controller's or an
// MCP session's execute) and reports what it created, so a caller can undo the whole layout or replace it later.
import type { CommandResult, EditorCommand } from "../controller/commands";
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { CreateClipInput } from "../backend/types";
import type { SceneData } from "../timeline/canvas/types";
import { DEFAULT_TEXT_LINE_HEIGHT } from "../lib/preview-text-draw";
import { fontStack } from "../text/fonts";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";

/** The reel frame at its reference size (text sizes are reference px of this frame). */
export const REEL_LAYOUT = Object.freeze({
    canvas: { aspectRatio: "9:16", width: 1080, height: 1920 },
    film: { aspectRatio: "16:9", width: 1080, height: 608, y: 656 },
    title: { fontSize: 46, gapAbovePx: 34, maxCharacters: 80 },
    music: { fadeInSeconds: 0.5, fadeOutSeconds: 2.5, volume: 1 },
});

/** A layout preset (the Layout list and agents): what applyReelLayout does with its defaults. */
export interface LayoutPreset {
    id: string;
    /** i18n key of the preset's name. */
    nameKey: string;
    canvas: string;
    film: string;
}

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [{ id: "reel-title-above-film", nameKey: "layoutReelTitleAboveFilm", canvas: "9:16", film: "16:9" }];

/** The film's vertical offset from centre that puts its top at y (reference px), in % of the frame height. */
export function filmOffsetPercent(filmTopPx: number = REEL_LAYOUT.film.y): number {
    const { height } = REEL_LAYOUT.canvas;
    const centred = (height - REEL_LAYOUT.film.height) / 2;
    return Math.round(((filmTopPx - centred) / height) * 100 * 1e6) / 1e6;
}

/**
 * Where the title's box sits (positionY 0..1 of the free space, as overlays are placed): its baseline gapAbovePx above
 * the film top. Text is drawn middle-aligned; a Latin baseline sits about 0.3 em below the box's middle.
 */
export function titlePositionY(filmTopPx: number = REEL_LAYOUT.film.y, fontSize: number = REEL_LAYOUT.title.fontSize, lines = 1): number {
    const { height } = REEL_LAYOUT.canvas;
    const box = fontSize * DEFAULT_TEXT_LINE_HEIGHT * Math.max(1, lines);
    const baseline = filmTopPx - REEL_LAYOUT.title.gapAbovePx;
    // The last line's baseline sits gapAbovePx above the film; the box's middle is half a box minus a line above it.
    const lastLineMiddle = baseline - 0.3 * fontSize;
    const middle = lastLineMiddle - (box - fontSize * DEFAULT_TEXT_LINE_HEIGHT) / 2;
    return Math.round(Math.min(1, Math.max(0, (middle - box / 2) / (height - box))) * 1e6) / 1e6;
}

/** The title's text style: bold white, no animation (the title template's look at the reel's size). */
export function reelTitleStyle(fontSize: number = REEL_LAYOUT.title.fontSize): Record<string, unknown> {
    return { fontFamily: fontStack("Montserrat"), fontWeight: "800", fontSize, color: "#FFFFFF", textAlign: "center", letterSpacing: 0.5 };
}

export interface ReelClip {
    /** Project media URL of the shot's video. */
    mediaUrl: string;
    durationSeconds: number;
    label?: string;
    width?: number;
    height?: number;
}

export interface ReelLayoutInput {
    title: string;
    canvas?: "9:16";
    film?: "16:9";
    clips: ReelClip[];
    music?: { mediaUrl: string; durationSeconds?: number; label?: string; fadeInSeconds?: number; fadeOutSeconds?: number; volume?: number } | null;
    /** A layout placed before (its scenes and clips) that this one replaces: they are removed first. */
    replace?: { sceneIds?: string[]; clipIds?: string[] };
}

/** What the layout needs of the timeline: its scenes, clips and tracks (a ControllerSnapshot has them). */
export interface ReelLayoutState {
    scenes: SceneData[];
    clips: TimelineClip[];
    tracks?: TimelineTrack[];
}

export interface ReelLayoutPlan {
    start: number;
    end: number;
    /** project.update, the removals, then one scene.add per clip; scene.update fits follow each add (see applyReelLayout). */
    commands: EditorCommand[];
    title: CreateClipInput | null;
    music: CreateClipInput | null;
    titleTrackIndex: number;
    musicTrackIndex: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The first editable track of a type whose clips leave [start, end) free (at least `first`), else a new one above the rest. */
function freeTrack(clips: TimelineClip[], tracks: TimelineTrack[], type: string, start: number, end: number, first = 1): number {
    const used = clips.filter((c) => c.trackType === type);
    const rows = tracks.filter((t) => t.type === type);
    const highest = Math.max(first - 1, ...used.map((c) => c.trackIndex), ...rows.map((t) => t.index));
    for (let index = first; index <= highest; index += 1) {
        const row = rows.find((t) => t.index === index);
        if (row && (row.locked || row.visible === false)) continue;
        if (!used.some((c) => c.trackIndex === index && c.startTime < end - 0.001 && c.endTime > start + 0.001)) return index;
    }
    return highest + 1;
}

/** The track list with a row for each new track the layout puts a clip on (V1 and A1 are built in). */
function withTracks(tracks: TimelineTrack[], wanted: Array<{ type: "text" | "audio"; index: number; label: string }>): TimelineTrack[] | null {
    const added = wanted.filter((w) => !(w.type === "audio" && w.index === 1) && !tracks.some((t) => t.type === w.type && t.index === w.index));
    if (added.length === 0) return null;
    return [...tracks, ...added.map((w) => ({ type: w.type, index: w.index, label: w.label, muted: false, locked: false, visible: true, volume: 1 }))];
}

export type ReelPlanResult = { ok: true; plan: ReelLayoutPlan } | { ok: false; error: string };

/** The layout's commands (pure). The film starts where V1 ends (after the scenes it keeps). */
export function planReelLayout(state: ReelLayoutState, input: ReelLayoutInput): ReelPlanResult {
    const title = input.title.trim();
    if (!title) return { ok: false, error: "the reel layout needs a title" };
    if ([...title].length > REEL_LAYOUT.title.maxCharacters) return { ok: false, error: `the title is longer than ${REEL_LAYOUT.title.maxCharacters} characters` };
    if ((input.canvas ?? "9:16") !== "9:16" || (input.film ?? "16:9") !== "16:9") return { ok: false, error: "the reel layout is a 9:16 canvas with a 16:9 film" };
    if (input.clips.length === 0) return { ok: false, error: "the reel layout needs at least one clip" };
    for (const [i, clip] of input.clips.entries()) {
        if (!clip.mediaUrl) return { ok: false, error: `clip ${i + 1} has no media` };
        if (!(Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0)) return { ok: false, error: `clip ${i + 1} has no length` };
    }
    const removedScenes = new Set(input.replace?.sceneIds ?? []);
    const removedClips = new Set(input.replace?.clipIds ?? []);
    const scenes = state.scenes.filter((s) => !removedScenes.has(s.id));
    const clips = state.clips.filter((c) => !removedClips.has(c.id));
    const v1 = scenes.map((s, i) => ({ s, i })).filter(({ s }) => Number(s.trackIndex || 1) === 1);
    const start = round3(v1.reduce((end, { s }) => Math.max(end, getSceneStart(s, scenes, scenes.indexOf(s)) + getSceneDuration(s)), 0));
    const total = input.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
    const end = round3(start + total);

    const commands: EditorCommand[] = [{ type: "project.update", patch: { aspectRatio: REEL_LAYOUT.canvas.aspectRatio } }];
    if (removedClips.size > 0) commands.push({ type: "clip.delete", clipIds: [...removedClips].filter((id) => state.clips.some((c) => c.id === id)) });
    for (const sceneId of removedScenes) if (state.scenes.some((s) => s.id === sceneId)) commands.push({ type: "scene.delete", sceneId });
    let afterOrder = scenes.reduce((max, s) => Math.max(max, s.order), -1);
    let at = start;
    for (const [i, clip] of input.clips.entries()) {
        commands.push({
            type: "scene.add",
            input: { afterOrder, videoUrl: clip.mediaUrl, duration: round3(clip.durationSeconds), trackIndex: 1, timelinePositionSeconds: round3(Math.max(0.001, at)), caption: clip.label ?? `Shot ${i + 1}` },
        });
        afterOrder += 1;
        at += clip.durationSeconds;
    }
    const tracks = state.tracks ?? [];
    const titleTrackIndex = freeTrack(clips, tracks, "text", start, end);
    const titleClip: CreateClipInput = {
        trackType: "text", trackIndex: titleTrackIndex, startTime: start, endTime: end, label: "Title", textContent: title,
        textStyle: JSON.stringify(reelTitleStyle()), positionX: 0.5, positionY: titlePositionY(), scale: 1, opacity: 1,
    };
    let musicClip: CreateClipInput | null = null;
    let musicTrackIndex = 0;
    if (input.music?.mediaUrl) {
        const music = input.music;
        const length = music.durationSeconds && music.durationSeconds > 0 ? Math.min(total, music.durationSeconds) : total;
        musicTrackIndex = freeTrack(clips, tracks, "audio", start, round3(start + length));
        musicClip = {
            trackType: "audio", trackIndex: musicTrackIndex, startTime: start, endTime: round3(start + length), mediaUrl: music.mediaUrl, mediaType: "audio",
            label: music.label ?? "Music", volume: music.volume ?? REEL_LAYOUT.music.volume, trimStart: 0, trimEnd: round3(length),
            fadeInDuration: music.fadeInSeconds ?? REEL_LAYOUT.music.fadeInSeconds, fadeOutDuration: Math.min(length / 2, music.fadeOutSeconds ?? REEL_LAYOUT.music.fadeOutSeconds),
        };
    }
    const newTracks = withTracks(tracks, [{ type: "text", index: titleTrackIndex, label: "Title" }, ...(musicClip ? [{ type: "audio" as const, index: musicTrackIndex, label: "Music" }] : [])]);
    commands.push({ type: "clip.create", input: musicClip ? [titleClip, musicClip] : [titleClip], ...(newTracks ? { tracks: newTracks } : {}) });
    return { ok: true, plan: { start, end, commands, title: titleClip, music: musicClip, titleTrackIndex, musicTrackIndex } };
}

/** The scene patch that fits a film clip into the reel: contain, the film offset, and its source size when known. */
export function reelScenePatch(clip: ReelClip): Partial<SceneData> {
    return {
        fitMode: "contain", transformScale: 1, transformOffsetX: 0, transformOffsetY: filmOffsetPercent(),
        ...(clip.width && clip.height ? { sourceWidth: clip.width, sourceHeight: clip.height } : {}),
    };
}

export interface ReelLayoutOutcome {
    ok: boolean;
    error?: string;
    sceneIds: string[];
    titleClipId: string | null;
    musicClipId: string | null;
    /** Commands that changed the timeline (what history.undo takes back, the aspect ratio aside). */
    steps: number;
    start: number;
    end: number;
}

export type ReelExecutor = (command: EditorCommand) => Promise<CommandResult>;

/**
 * Applies the reel layout: the canvas, the film scenes on V1 (each added, then fitted), the title and the music. Stops
 * at the first command that fails and reports how far it got (its steps can be undone).
 */
export async function applyReelLayout(execute: ReelExecutor, state: ReelLayoutState, input: ReelLayoutInput): Promise<ReelLayoutOutcome> {
    const planned = planReelLayout(state, input);
    if (!planned.ok) return { ok: false, error: planned.error, sceneIds: [], titleClipId: null, musicClipId: null, steps: 0, start: 0, end: 0 };
    const { plan } = planned;
    const outcome: ReelLayoutOutcome = { ok: true, sceneIds: [], titleClipId: null, musicClipId: null, steps: 0, start: plan.start, end: plan.end };
    const fail = (command: EditorCommand, result: CommandResult): ReelLayoutOutcome => ({ ...outcome, ok: false, error: `${command.type} failed: ${result.error ?? "unknown error"}` });
    let clipIndex = 0;
    for (const command of plan.commands) {
        const result = await execute(command);
        if (!result.ok) return fail(command, result);
        if (command.type !== "project.update") outcome.steps += 1;
        if (command.type === "scene.add") {
            const sceneId = result.createdSceneIds?.[0];
            if (!sceneId) return { ...outcome, ok: false, error: "scene.add returned no scene" };
            outcome.sceneIds.push(sceneId);
            const fit: EditorCommand = { type: "scene.update", sceneId, patch: reelScenePatch(input.clips[clipIndex]!) };
            clipIndex += 1;
            const fitted = await execute(fit);
            if (!fitted.ok) return fail(fit, fitted);
            outcome.steps += 1;
        }
        if (command.type === "clip.create") {
            const ids = result.createdClipIds ?? [];
            outcome.titleClipId = ids[0] ?? null;
            outcome.musicClipId = plan.music ? (ids[1] ?? null) : null;
        }
    }
    return outcome;
}
