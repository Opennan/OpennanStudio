// Transition markers — the bowtie indicator drawn on the cut between two items
// (clips OR scenes). A transition is stored on a clip's `transitionType` or a
// scene's `visualTransition` (its junction with the next item). The marker is a
// small square centered on the item's END (the cut) and on the track's vertical
// middle, so clip-edge resize still works in the thin strips above/below it.
// Geometry is kept here, pure and tested, and shared by the renderer (draws the
// bowtie) and the hit-detector (selects it).

import type { TimelineClip } from "../../model/timeline";
import type { SceneData, TrackLayoutEntry } from "./types";
import { getSceneStart } from "../scene-timing";

export const TRANSITION_MARKER_SIZE = 16;
export const DEFAULT_TRANSITION_DURATION = 0.5;
// Edge grab zone (px) at each end of a wide transition shape.
export const TRANSITION_EDGE_ZONE = 6;
// A transition needs at least this much media on the shorter neighbor.
export const MIN_TRANSITION_DURATION = 0.1;

// Transitions only live on fade-layer clips (everything except the effect track).
const FADE_LAYER_TYPES = new Set(["video", "audio", "text", "sticker"]);

function isRealTransition(value: string | null | undefined): boolean {
    const v = (value || "none").trim().toLowerCase();
    return v !== "" && v !== "none";
}

export function isTransitionMarkerClip(clip: Pick<TimelineClip, "trackType" | "transitionType">): boolean {
    if (!isRealTransition(clip.transitionType)) return false;
    return FADE_LAYER_TYPES.has(clip.trackType);
}

export interface TransitionMarker {
    id: string;
    kind: "clip" | "scene";
    transitionType: string;
    worldX: number;   // item END in world space (time * zoom)
    centerY: number;  // track vertical middle, canvas-local (below the ruler)
    durationSeconds: number;     // transition duration (fallback DEFAULT_TRANSITION_DURATION)
    widthPx: number;             // drawn span: max(marker size, duration * zoom)
    maxDurationSeconds: number;  // clamp: the shorter neighbor's length
}

// A cut between two adjacent same-track items — a legal (or illegal) landing
// spot for a transition drop, whether or not a transition exists there yet.
export interface TransitionJunction {
    id: string;       // the OUTGOING item (owns the junction transition)
    kind: "clip" | "scene";
    worldX: number;
    centerY: number;
    maxDurationSeconds: number;
    valid: boolean;   // shorter neighbor can host at least minDuration
}

export type SelectedTransitionMarker = Pick<TransitionMarker, "id" | "kind"> | null | undefined;

export function hasTransitionMarker(markers: TransitionMarker[], selected: SelectedTransitionMarker): boolean {
    if (!selected) return false;
    return markers.some((marker) => marker.kind === selected.kind && marker.id === selected.id);
}

type TransitionMarkerClip = Pick<TimelineClip, "id" | "trackType" | "trackIndex" | "startTime" | "endTime" | "transitionType">
    & Partial<Pick<TimelineClip, "transitionDuration">>;

function normalizeDuration(raw: number | null | undefined): number {
    return Number.isFinite(raw as number) && (raw as number) > 0 ? (raw as number) : DEFAULT_TRANSITION_DURATION;
}

function markerWidthPx(durationSeconds: number, zoom: number): number {
    return Math.max(TRANSITION_MARKER_SIZE, durationSeconds * zoom);
}

export function getTransitionMarkers(
    clips: TransitionMarkerClip[],
    tracks: TrackLayoutEntry[],
    zoom: number,
): TransitionMarker[] {
    const markers: TransitionMarker[] = [];
    for (const clip of clips) {
        if (!isTransitionMarkerClip(clip)) continue;
        const track = tracks.find((t) => t.type === clip.trackType && t.index === clip.trackIndex);
        if (!track) continue;
        if (track.visible === false) continue;
        if (track.locked) continue;
        const next = clips.find((other) =>
            other.id !== clip.id &&
            other.trackType === clip.trackType &&
            other.trackIndex === clip.trackIndex &&
            Math.abs(other.startTime - clip.endTime) <= 0.001,
        );
        if (!next) continue;
        const durationSeconds = normalizeDuration(clip.transitionDuration);
        markers.push({
            id: clip.id,
            kind: "clip",
            transitionType: clip.transitionType,
            worldX: clip.endTime * zoom,
            centerY: track.y + track.height / 2,
            durationSeconds,
            widthPx: markerWidthPx(durationSeconds, zoom),
            maxDurationSeconds: Math.min(
                clip.endTime - clip.startTime,
                next.endTime - next.startTime,
            ),
        });
    }
    return markers;
}

// All adjacent same-track clip cuts — used as drop guides while a transition
// card is being dragged from the library panel.
export function getTransitionJunctions(
    clips: TransitionMarkerClip[],
    tracks: TrackLayoutEntry[],
    zoom: number,
    minDurationSeconds: number,
): TransitionJunction[] {
    const junctions: TransitionJunction[] = [];
    for (const clip of clips) {
        if (!FADE_LAYER_TYPES.has(clip.trackType)) continue;
        const track = tracks.find((t) => t.type === clip.trackType && t.index === clip.trackIndex);
        if (!track || track.visible === false || track.locked) continue;
        const next = clips.find((other) =>
            other.id !== clip.id &&
            other.trackType === clip.trackType &&
            other.trackIndex === clip.trackIndex &&
            Math.abs(other.startTime - clip.endTime) <= 0.001,
        );
        if (!next) continue;
        const maxDurationSeconds = Math.min(
            clip.endTime - clip.startTime,
            next.endTime - next.startTime,
        );
        junctions.push({
            id: clip.id,
            kind: "clip",
            worldX: clip.endTime * zoom,
            centerY: track.y + track.height / 2,
            maxDurationSeconds,
            valid: maxDurationSeconds >= minDurationSeconds,
        });
    }
    return junctions.sort((a, b) => a.worldX - b.worldX);
}

type TransitionMarkerScene = Pick<SceneData, "id" | "trackIndex" | "visualTransition"> & {
    timelinePositionSeconds?: number;
    duration?: number | null;
    visualTransitionDuration?: number | null;
};

// Scenes live on video tracks. `sceneEndAt(index)` returns the end time (seconds)
// of the scene at that index — the caller supplies the canonical scene-positioning
// (getSceneStart + getSceneDuration), keeping this pure and free of a circular
// import on the renderer.
export function getSceneTransitionMarkers(
    scenes: TransitionMarkerScene[],
    tracks: TrackLayoutEntry[],
    zoom: number,
    sceneEndAt: (index: number) => number,
    sceneStartAt?: (index: number) => number,
): TransitionMarker[] {
    const startAt = sceneStartAt ?? ((index) => getSceneStart(scenes[index] as any, scenes as any, index));
    const markers: TransitionMarker[] = [];
    scenes.forEach((scene, index) => {
        if (!isRealTransition(scene.visualTransition)) return;
        const track = tracks.find((t) => t.type === "video" && t.index === (scene.trackIndex ?? 1));
        if (!track) return;
        if (track.visible === false) return;
        if (track.locked) return;
        const sceneEnd = sceneEndAt(index);
        const nextIndex = scenes.findIndex((next, i) =>
            next.id !== scene.id &&
            (next.trackIndex ?? 1) === (scene.trackIndex ?? 1) &&
            Math.abs(startAt(i) - sceneEnd) <= 0.001,
        );
        if (nextIndex < 0) return;
        const durationSeconds = normalizeDuration(scene.visualTransitionDuration);
        const sceneDuration = Math.max(0, sceneEnd - startAt(index));
        const nextDuration = Math.max(0, sceneEndAt(nextIndex) - startAt(nextIndex));
        markers.push({
            id: scene.id,
            kind: "scene",
            transitionType: scene.visualTransition || "none",
            worldX: sceneEnd * zoom,
            centerY: track.y + track.height / 2,
            durationSeconds,
            widthPx: markerWidthPx(durationSeconds, zoom),
            maxDurationSeconds: Math.min(sceneDuration, nextDuration),
        });
    });
    return markers;
}

// All adjacent same-track scene cuts, mirroring getTransitionJunctions.
export function getSceneTransitionJunctions(
    scenes: TransitionMarkerScene[],
    tracks: TrackLayoutEntry[],
    zoom: number,
    minDurationSeconds: number,
    sceneEndAt: (index: number) => number,
    sceneStartAt?: (index: number) => number,
): TransitionJunction[] {
    const startAt = sceneStartAt ?? ((index) => getSceneStart(scenes[index] as any, scenes as any, index));
    const junctions: TransitionJunction[] = [];
    scenes.forEach((scene, index) => {
        const track = tracks.find((t) => t.type === "video" && t.index === (scene.trackIndex ?? 1));
        if (!track || track.visible === false || track.locked) return;
        const sceneEnd = sceneEndAt(index);
        const nextIndex = scenes.findIndex((next, i) =>
            next.id !== scene.id &&
            (next.trackIndex ?? 1) === (scene.trackIndex ?? 1) &&
            Math.abs(startAt(i) - sceneEnd) <= 0.001,
        );
        if (nextIndex < 0) return;
        const sceneDuration = Math.max(0, sceneEnd - startAt(index));
        const nextDuration = Math.max(0, sceneEndAt(nextIndex) - startAt(nextIndex));
        const maxDurationSeconds = Math.min(sceneDuration, nextDuration);
        junctions.push({
            id: scene.id,
            kind: "scene",
            worldX: sceneEnd * zoom,
            centerY: track.y + track.height / 2,
            maxDurationSeconds,
            valid: maxDurationSeconds >= minDurationSeconds,
        });
    });
    return junctions.sort((a, b) => a.worldX - b.worldX);
}

// Returns the marker under (worldX, localY), or null. Coordinates are world-space
// X (canvasX + scrollLeft) and canvas-local Y, matching hitDetect.
export function hitTransitionMarker(
    markers: TransitionMarker[],
    worldX: number,
    localY: number,
    size: number = TRANSITION_MARKER_SIZE,
): TransitionMarker | null {
    for (const m of markers) {
        // Body hit = the visible glyph square ONLY. A duration-wide shape
        // (e.g. a 3s crossfade) must not swallow the clip resize edges under
        // it — the wide shape's duration is adjusted via its edge zones.
        const halfW = size / 2;
        const halfH = size / 2;
        if (Math.abs(worldX - m.worldX) <= halfW && Math.abs(localY - m.centerY) <= halfH) {
            return m;
        }
    }
    return null;
}

// Left/right end zones of a transition shape — grab to change duration.
// Wide shapes expose inner zones at their ends. Narrow (minimum-size) shapes
// would be swallowed by inner zones, so they only expose OUTER zones — just
// outside the shape — and only while selected (selection shows the handles).
export function hitTransitionEdge(
    markers: TransitionMarker[],
    worldX: number,
    localY: number,
    selected?: SelectedTransitionMarker,
): { marker: TransitionMarker; edge: "left" | "right" } | null {
    for (const m of markers) {
        if (Math.abs(localY - m.centerY) > TRANSITION_MARKER_SIZE / 2) continue;
        const left = m.worldX - m.widthPx / 2;
        const right = m.worldX + m.widthPx / 2;
        const wide = m.widthPx > TRANSITION_MARKER_SIZE + 2 * TRANSITION_EDGE_ZONE;
        if (wide) {
            if (worldX >= left && worldX <= left + TRANSITION_EDGE_ZONE) return { marker: m, edge: "left" };
            if (worldX >= right - TRANSITION_EDGE_ZONE && worldX <= right) return { marker: m, edge: "right" };
            continue;
        }
        const isSelected = !!selected && selected.kind === m.kind && selected.id === m.id;
        if (!isSelected) continue;
        if (worldX >= left - TRANSITION_EDGE_ZONE && worldX < left + 3) return { marker: m, edge: "left" };
        if (worldX > right - 3 && worldX <= right + TRANSITION_EDGE_ZONE) return { marker: m, edge: "right" };
    }
    return null;
}
