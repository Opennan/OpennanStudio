// Hit testing and cursor affordances for the canvas timeline surface.
import type { CanvasState, HitResult, TrackLayoutEntry, SceneData } from "./types";
import { RULER_HEIGHT, RESIZE_ZONE, getSceneDuration, getSceneStart, isSilencePlaceholderSceneAudio } from "./timeline-renderer";
import { getTransitionMarkers, getSceneTransitionMarkers, hitTransitionMarker, hitTransitionEdge } from "./transition-markers";
import { TIMELINE_TRACK_HEIGHT_COMPACT } from "../nle-timeline-layout";
import { parseCachedShotBreakdown, shotVisualDuration } from "../../lib/shot-utils";
import { getSceneTimelineStart } from "./scene-position";
import { hitKeyframeMarker } from "./keyframe-markers";

const TRANSITION_DROP_TOLERANCE_PX = 24;
const TRANSITION_DROP_MAX_TOLERANCE_PX = 48;
const TRANSITION_DROP_SEGMENT_TOLERANCE_RATIO = 0.33;
const TRANSITION_DROP_VERTICAL_TOLERANCE_PX = 48;
const TRANSITION_CLIP_TRACK_TYPES = new Set(["video"]);

function getTransitionDropTolerancePx(outgoingWidthPx: number, incomingWidthPx: number): number {
  const segmentBasedTolerance = Math.min(outgoingWidthPx, incomingWidthPx) * TRANSITION_DROP_SEGMENT_TOLERANCE_RATIO;
  return Math.min(
    TRANSITION_DROP_MAX_TOLERANCE_PX,
    Math.max(TRANSITION_DROP_TOLERANCE_PX, segmentBasedTolerance),
  );
}

/** Given a click inside a scene at `time`, return the INSERTION gap index
 * 0..shots.length — i.e. "insert BEFORE shot[targetIdx]". If the cursor is in
 * the right half of a shot, the gap is AFTER that shot (targetIdx = i+1).
 * Scaling matches `shotIndexForScene` so the mapping matches the visual shot
 * strip boundaries, not raw scene time. */
export function shotInsertIndexForScene(
  scene: SceneData,
  sceneStartTime: number,
  time: number,
): number {
  if (!scene.shotBreakdown) return 0;
  const shots = parseCachedShotBreakdown(scene.shotBreakdown);
  if (shots.length === 0) return 0;
  const totalShotDur = shots.reduce((a, s) => a + shotVisualDuration(s), 0);
  if (totalShotDur <= 0) return 0;
  const sceneDur = getSceneDuration(scene);
  const visualOffset = Math.max(0, time - sceneStartTime);
  const scale = sceneDur > 0 ? totalShotDur / sceneDur : 1;
  const offset = visualOffset * scale;
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const d = shotVisualDuration(shots[i]);
    if (offset < acc + d) {
      return offset < acc + d / 2 ? i : i + 1;
    }
    acc += d;
  }
  return shots.length;
}

/** Given a click inside a scene at `time` (absolute timeline seconds), return the
 * 0-based shot index within that scene, or -1 if the scene has no shot breakdown.
 *
 * The renderer scales shots proportionally across the scene strip using
 * `sceneDur` (which may be larger than the sum of shot durations when a scene
 * has a video whose length exceeds the shot breakdown). We must apply the SAME
 * scaling here or every click past the sum would resolve to the last shot. */
export function shotIndexForScene(
  scene: SceneData,
  sceneStartTime: number,
  time: number,
): number {
  if (!scene.shotBreakdown) return -1;
  const shots = parseCachedShotBreakdown(scene.shotBreakdown);
  if (shots.length === 0) return -1;
  const totalShotDur = shots.reduce((a, s) => a + shotVisualDuration(s), 0);
  if (totalShotDur <= 0) return 0;
  const sceneDur = getSceneDuration(scene);
  const visualOffset = Math.max(0, time - sceneStartTime);
  const scale = sceneDur > 0 ? totalShotDur / sceneDur : 1;
  const offset = Math.min(totalShotDur - 0.0001, visualOffset * scale);
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const d = shotVisualDuration(shots[i]);
    if (offset < acc + d) return i;
    acc += d;
  }
  return shots.length - 1;
}

/**
 * Given a canvas-local (x, y) coordinate, determine what the user clicked.
 * Coordinates are ALREADY adjusted for scroll (i.e. x = canvasX + scrollLeft).
 */
export function hitDetect(
  canvasX: number,
  canvasY: number,
  state: CanvasState,
): HitResult | null {
  const { zoom } = state;
  const worldX = canvasX + state.scrollLeft;
  const time = worldX / zoom;
  const playheadX = state.currentTime * zoom;

  // 1. Ruler area (top 20px). Marker flags (drawn at the ruler top, ±5px
  // around their time) win over plain ruler scrubbing so they can be
  // grabbed/dragged/right-clicked; anywhere else in the ruler scrubs.
  if (canvasY < RULER_HEIGHT) {
    for (const marker of state.markers || []) {
      if (Math.abs(worldX - marker.time * zoom) <= 6) {
        return { type: "marker", markerId: marker.id, time: marker.time };
      }
    }
    return { type: "ruler", time: Math.max(0, Math.min(state.totalDuration, time)) };
  }

  // Keyframe diamonds of the selected clip or scene (phase 10c) win over the body, trim edges, and
  // transition markers beneath them; select tool only (blade cuts, hand pans).
  if (state.toolMode === "select") {
    const keyframe = hitKeyframeMarker(canvasX, canvasY, state);
    if (keyframe) {
      return keyframe.clipId
        ? { type: "keyframe", clipId: keyframe.clipId, keyframeTime: keyframe.time, time }
        : { type: "keyframe", sceneId: keyframe.sceneId, keyframeTime: keyframe.time, time };
    }
  }

  const contentHit = hitDetectContent(canvasX, canvasY, state);

  // Playhead line drag handle: allow grabbing the current-time line from any
  // track row, not only from the ruler — but only over EMPTY timeline area.
  // Clips, scenes, resize edges, and transition markers under the playhead
  // must stay clickable (selecting/trimming/blading at the playhead is the
  // most common edit spot); the ruler always works for scrubbing.
  if (Math.abs(worldX - playheadX) <= Math.max(5, RESIZE_ZONE)) {
    if (!contentHit || contentHit.type === "track-empty") {
      return {
        type: "ruler",
        time: Math.max(0, Math.min(state.totalDuration, state.currentTime)),
      };
    }
  }

  return contentHit;
}

function hitDetectContent(
  canvasX: number,
  canvasY: number,
  state: CanvasState,
): HitResult | null {
  const { zoom, scenes, tracks, clips, musicUrl } = state;
  const worldX = canvasX + state.scrollLeft;
  const time = worldX / zoom;

  const localY = canvasY - RULER_HEIGHT;

  // Find which track layout entry was clicked
  let hitTrack: TrackLayoutEntry | null = null;
  for (const t of tracks) {
    if (localY >= t.y && localY < t.y + t.height) {
      hitTrack = t;
      break;
    }
  }

  if (!hitTrack) return null;

  // Hidden/locked tracks should not expose clip or scene hit targets.
  if (hitTrack.visible === false) return null;
  if (hitTrack.locked) return { type: "track-empty", trackKey: hitTrack.key, time };

  // Transition marker sits on the cut, centered on the track. Its small square
  // takes priority over the clip body / resize edges beneath it so it can be
  // clicked to select (and then deleted); the strips above/below it still resize.
  const allTransitionMarkers = [
    ...getTransitionMarkers(clips, tracks, zoom),
    ...getSceneTransitionMarkers(
      scenes,
      tracks,
      zoom,
      (i) => getSceneStart(scenes[i], scenes, i) + getSceneDuration(scenes[i]),
      (i) => getSceneStart(scenes[i], scenes, i),
    ),
  ];
  // Edge zones (duration drag) take priority over the shape body (select).
  const transitionEdge = hitTransitionEdge(allTransitionMarkers, worldX, localY, state.selectedTransition);
  if (transitionEdge) {
    const type = transitionEdge.edge === "left" ? "transition-resize-left" as const : "transition-resize-right" as const;
    return transitionEdge.marker.kind === "scene"
      ? { type, sceneId: transitionEdge.marker.id, time }
      : { type, clipId: transitionEdge.marker.id, time };
  }
  const transitionMarker = hitTransitionMarker(allTransitionMarkers, worldX, localY);
  if (transitionMarker) {
    return transitionMarker.kind === "scene"
      ? { type: "transition", sceneId: transitionMarker.id, time }
      : { type: "transition", clipId: transitionMarker.id, time };
  }

  // 2. Video tracks — scenes can live on any video track (V1 = default, V2+ overlay).
  //    Legacy TimelineClip overlays can also still exist on V2+ and must be
  //    hit-detectable so they can be selected / right-clicked / deleted.
  if (hitTrack.type === "video") {
    const sceneCandidates = scenes
      .map((scene, i) => {
        const sceneTrackIdx = scene.trackIndex || 1;
        if (sceneTrackIdx !== hitTrack.index) return null;
        const dur = getSceneDuration(scene);
        const startTime = getSceneTimelineStart(scene, scenes, i, getSceneDuration);
        return {
          scene,
          startTime,
          clipLeft: startTime * zoom,
          clipRight: (startTime + dur) * zoom,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => b.startTime - a.startTime);

    for (const { scene, clipLeft, clipRight } of sceneCandidates) {
      if (worldX >= clipLeft && worldX <= clipRight) {
        // Resize zones at the edges (6px from each side). Only resolve to
        // resize when the scene is wide enough to have distinct edges AND is
        // already selected — a fast flick that happens to grab within 6px of
        // an edge on an unselected scene must MOVE it, not stretch it
        // (accidental stretches silently corrupted layouts).
        const isSelected = state.selectedSceneId === scene.id || state.selectedSceneIds?.has(scene.id);
        const canResize = isSelected && (clipRight - clipLeft) > RESIZE_ZONE * 3;
        if (canResize && worldX <= clipLeft + RESIZE_ZONE) {
          return { type: "resize-left", sceneId: scene.id, time };
        }
        if (canResize && worldX >= clipRight - RESIZE_ZONE) {
          return { type: "resize-right", sceneId: scene.id, time };
        }
        return { type: "scene", sceneId: scene.id, time };
      }
    }
    // Narrow scenes have no room for inner edge zones — without an escape
    // hatch the user must zoom in just to re-expand a tiny clip. When the
    // tiny scene is SELECTED, its resize handles live just OUTSIDE the strip
    // (same affordance minimum-size transitions use). Checked AFTER the
    // body loop so the outer zones can never steal a click that lands on a
    // neighboring scene's body.
    for (const { scene, clipLeft, clipRight } of sceneCandidates) {
      if (state.selectedSceneId !== scene.id) continue;
      if ((clipRight - clipLeft) > RESIZE_ZONE * 3) continue;
      if (worldX >= clipLeft - RESIZE_ZONE && worldX < clipLeft) {
        return { type: "resize-left", sceneId: scene.id, time };
      }
      if (worldX > clipRight && worldX <= clipRight + RESIZE_ZONE) {
        return { type: "resize-right", sceneId: scene.id, time };
      }
    }
    // Fall through to TimelineClip hit-testing on this video track — so leftover
    // overlay "Clip" boxes can be selected/deleted via right-click.
    const vClips = clips.filter(
      (c) => c.trackType === "video" && c.trackIndex === hitTrack.index && !c.locked,
    );
    const sortedV = [...vClips].sort((a, b) => b.startTime - a.startTime);
    for (const clip of sortedV) {
      const clipLeft = clip.startTime * zoom;
      const clipRight = clip.endTime * zoom;
      if (worldX < clipLeft || worldX > clipRight) continue;
      if (worldX <= clipLeft + RESIZE_ZONE) return { type: "resize-left", clipId: clip.id, time };
      if (worldX >= clipRight - RESIZE_ZONE) return { type: "resize-right", clipId: clip.id, time };
      return { type: "clip", clipId: clip.id, time };
    }
    return { type: "track-empty", trackKey: hitTrack.key, time };
  }

  // 3. A1 track — clips first (highest priority), then voiceovers, then music
  if (hitTrack.key === "audio-1") {
    // Check timeline clips on A1 first (imported audio, highest priority)
    const a1Clips = clips.filter(c => c.trackType === "audio" && c.trackIndex === 1 && !c.locked);
    const sortedA1 = [...a1Clips].sort((a, b) => b.startTime - a.startTime);
    for (const clip of sortedA1) {
      const clipLeft = clip.startTime * zoom;
      const clipRight = clip.endTime * zoom;
      if (worldX >= clipLeft && worldX <= clipRight) {
        const RESIZE = RESIZE_ZONE;
        if (worldX <= clipLeft + RESIZE) return { type: "resize-left", clipId: clip.id, time };
        if (worldX >= clipRight - RESIZE) return { type: "resize-right", clipId: clip.id, time };
        return { type: "clip", clipId: clip.id, time };
      }
    }

    // Check voiceover blocks
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const dur = getSceneDuration(scene);
      const startTime = getSceneStart(scene, scenes, i);

      if (!scene.audioUrl || isSilencePlaceholderSceneAudio(scene)) continue;
      // Hidden for rendered podcast scenes (audio baked into the video).
      if (scene.cardType === "podcast" && scene.videoUrl) continue;

      const offset = state.voiceoverOffsets.get(scene.id) || 0;
      const voBaseTime = startTime + offset;
      const voLeft = voBaseTime * zoom;
      const voRight = (voBaseTime + dur) * zoom;

      if (worldX >= voLeft && worldX <= voRight) {
        const lockRight = voRight - 2;
        const lockLeft = lockRight - 16;
        if (worldX >= lockLeft && worldX <= lockRight) {
          return { type: "voiceover-lock", sceneId: scene.id, time };
        }
        return { type: "voiceover", sceneId: scene.id, time };
      }
    }

    // Music area (whole track)
    if (musicUrl) {
      return { type: "music", time };
    }

    return { type: "track-empty", trackKey: hitTrack.key, time };
  }

  // 4. Extra tracks
  const trackClips = clips.filter(
    c => `${c.trackType}-${c.trackIndex}` === hitTrack!.key && !c.locked,
  );

  // Sort by startTime descending so overlapping clips pick the later one
  const sorted = [...trackClips].sort((a, b) => b.startTime - a.startTime);

  for (const clip of sorted) {
    const clipLeft = clip.startTime * zoom;
    const clipRight = clip.endTime * zoom;

    if (worldX < clipLeft || worldX > clipRight) continue;

    // Check resize zones (6px from each edge)
    if (worldX <= clipLeft + RESIZE_ZONE) {
      return { type: "resize-left", clipId: clip.id, time };
    }
    if (worldX >= clipRight - RESIZE_ZONE) {
      return { type: "resize-right", clipId: clip.id, time };
    }

    return { type: "clip", clipId: clip.id, time };
  }

  return { type: "track-empty", trackKey: hitTrack.key, time };
}

function getTrackAtCanvasY(canvasY: number, tracks: TrackLayoutEntry[]): TrackLayoutEntry | null {
  const localY = canvasY - RULER_HEIGHT;
  return tracks.find((track) => localY >= track.y && localY < track.y + track.height) ?? null;
}

function getSceneStartForTransitionDrop(scenes: SceneData[], scene: SceneData, index: number): number {
  return getSceneTimelineStart(scene, scenes, index, getSceneDuration);
}

function getTransitionBoundaryOnTrack(
  worldX: number,
  zoom: number,
  scenes: SceneData[],
  clips: CanvasState["clips"],
  hitTrack: TrackLayoutEntry,
): HitResult | null {
  const trackClips = TRANSITION_CLIP_TRACK_TYPES.has(hitTrack.type)
    ? clips.filter((clip) => clip.trackType === hitTrack.type && clip.trackIndex === hitTrack.index && !clip.locked)
    : [];
  const clipBoundary = trackClips
    .map((clip) => {
      const nextClip = trackClips.find((next) => Math.abs(next.startTime - clip.endTime) <= 0.001);
      if (!nextClip) return null;
      const distance = Math.abs(clip.endTime * zoom - worldX);
      const tolerance = getTransitionDropTolerancePx(
        Math.max(0, (clip.endTime - clip.startTime) * zoom),
        Math.max(0, (nextClip.endTime - nextClip.startTime) * zoom),
      );
      return distance <= tolerance ? { clip, distance } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => a.distance - b.distance)[0]?.clip;

  if (clipBoundary) {
    return {
      type: "transition",
      clipId: clipBoundary.id,
      trackKey: hitTrack.key,
      time: clipBoundary.endTime,
    };
  }

  if (hitTrack.type !== "video") return null;

  const sceneSegments = scenes
    .map((scene, index) => {
      if ((scene.trackIndex || 1) !== hitTrack.index) return null;
      const startTime = getSceneStartForTransitionDrop(scenes, scene, index);
      const endTime = startTime + getSceneDuration(scene);
      return { scene, startTime, endTime };
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);

  const sceneBoundary = sceneSegments
    .map((segment) => {
      const nextSegment = sceneSegments.find((next) => Math.abs(next.startTime - segment.endTime) <= 0.001);
      if (!nextSegment) return null;
      const distance = Math.abs(segment.endTime * zoom - worldX);
      const tolerance = getTransitionDropTolerancePx(
        Math.max(0, (segment.endTime - segment.startTime) * zoom),
        Math.max(0, (nextSegment.endTime - nextSegment.startTime) * zoom),
      );
      return distance <= tolerance ? { segment, distance } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => a.distance - b.distance)[0]?.segment;

  if (sceneBoundary) {
    return {
      type: "transition",
      sceneId: sceneBoundary.scene.id,
      trackKey: hitTrack.key,
      time: sceneBoundary.endTime,
    };
  }

  return null;
}

export function getTransitionDropTarget(
  canvasX: number,
  canvasY: number,
  state: CanvasState,
): HitResult | null {
  const { zoom, scenes, tracks, clips } = state;
  const worldX = canvasX + state.scrollLeft;
  const hitTrack = getTrackAtCanvasY(canvasY, tracks);
  const directTarget = hitTrack && !hitTrack.locked && hitTrack.visible !== false
    ? getTransitionBoundaryOnTrack(worldX, zoom, scenes, clips, hitTrack)
    : null;
  if (directTarget) return directTarget;

  const localY = canvasY - RULER_HEIGHT;
  const trackBottom = tracks.reduce((bottom, track) => Math.max(bottom, track.y + track.height), 0);
  const isInsideTrackRows = localY >= 0 && localY <= trackBottom;
  const canProjectToVideoFromHitTrack =
    !hitTrack || (
      hitTrack.type !== "audio" &&
      !hitTrack.locked &&
      hitTrack.visible !== false
    );
  const nearbyVideoTarget = tracks
    .filter((track) => track.type === "video" && !track.locked && track.visible !== false)
    .map((track) => ({
      distance: Math.abs(localY - (track.y + track.height / 2)),
      target: getTransitionBoundaryOnTrack(worldX, zoom, scenes, clips, track),
    }))
    .filter((candidate) => (
      candidate.target
        && canProjectToVideoFromHitTrack
        && (candidate.distance <= TRANSITION_DROP_VERTICAL_TOLERANCE_PX || isInsideTrackRows)
    ))
    .sort((a, b) => a.distance - b.distance)[0]?.target;

  if (nearbyVideoTarget) {
    return nearbyVideoTarget;
  }

  return null;
}

export interface EffectLayerDropPreview {
  x: number;
  y: number;
  w: number;
  h: number;
  trackIndex: number;
  trackMissing: boolean;
  time: number;
}

export function getEffectLayerDropPreview(
  canvasX: number,
  state: CanvasState,
  canvasY?: number,
): EffectLayerDropPreview {
  return getTrackLayerDropPreview("effect", canvasX, state, canvasY);
}

export function getRemotionLayerDropPreview(
  canvasX: number,
  state: CanvasState,
  canvasY?: number,
): EffectLayerDropPreview {
  return getTrackLayerDropPreview("remotion", canvasX, state, canvasY);
}

/**
 * Drop preview for media library drags. Mirrors where the drop handlers will
 * actually place the clip: video → overlay video lanes (V2+, never the V1
 * scene strip), image → sticker track, audio → audio tracks (cursor row wins).
 */
export function getMediaLayerDropPreview(
  mediaKind: "video" | "audio" | "image",
  canvasX: number,
  state: CanvasState,
  canvasY?: number,
  durationSeconds?: number | null,
): EffectLayerDropPreview {
  const rawTime = (canvasX + state.scrollLeft) / state.zoom;
  const time = Math.max(0, rawTime);
  const x = time * state.zoom - state.scrollLeft;
  // Images land on video lanes too — one visual-media track family.
  const trackType = mediaKind === "audio" ? "audio" : "video";
  const editableTracks = state.tracks
    .filter((track) => track.type === trackType && !track.virtual && !track.locked && track.visible !== false)
    // V1 hosts scenes — video/image media lands on overlay lanes only.
    .filter((track) => (trackType === "video" ? track.index >= 2 : true))
    .sort((a, b) => a.index - b.index);
  const localY = typeof canvasY === "number" && Number.isFinite(canvasY)
    ? canvasY - RULER_HEIGHT
    : null;
  const trackUnderCursor = localY === null
    ? null
    : editableTracks.find((track) => localY >= track.y && localY < track.y + track.height) ?? null;
  const targetTrack = trackUnderCursor ?? editableTracks[0];
  const fallbackBottomY = state.tracks.reduce((bottom, track) => Math.max(bottom, track.y + track.height), 0);
  const firstVideoY = state.tracks
    .filter((track) => track.type === "video")
    .reduce<number | null>((top, track) => (top === null ? track.y : Math.min(top, track.y)), null);
  const y = RULER_HEIGHT + (targetTrack?.y ?? (trackType === "video" ? (firstVideoY ?? fallbackBottomY) : fallbackBottomY));
  const h = targetTrack?.height ?? TIMELINE_TRACK_HEIGHT_COMPACT;

  const ghostSeconds = typeof durationSeconds === "number" && durationSeconds > 0 ? durationSeconds : 5;

  return {
    x: Math.max(0, x),
    y,
    w: Math.max(24, ghostSeconds * state.zoom),
    h,
    trackIndex: targetTrack?.index ?? (mediaKind === "audio" ? 1 : 2),
    trackMissing: !targetTrack,
    time,
  };
}

function getTrackLayerDropPreview(
  trackType: "effect" | "remotion",
  canvasX: number,
  state: CanvasState,
  canvasY?: number,
): EffectLayerDropPreview {
  const rawTime = (canvasX + state.scrollLeft) / state.zoom;
  const time = Math.max(0, Math.min(state.totalDuration, rawTime));
  const x = time * state.zoom - state.scrollLeft;
  const allTracks = state.tracks.filter((track) => track.type === trackType && !track.virtual);
  const editableTracks = allTracks
    .filter((track) => !track.locked && track.visible !== false)
    .sort((a, b) => a.index - b.index);
  const localY = typeof canvasY === "number" && Number.isFinite(canvasY)
    ? canvasY - RULER_HEIGHT
    : null;
  const trackUnderCursor = localY === null
    ? null
    : editableTracks.find((track) => localY >= track.y && localY < track.y + track.height) ?? null;
  const targetTrack = trackUnderCursor ?? editableTracks[0];
  const targetTrackIndex = targetTrack?.index ?? (
    allTracks.reduce((maxIndex, track) => Math.max(maxIndex, track.index), 0) + 1
  );
  const virtualTrack = state.tracks.find((track) => track.type === trackType && track.virtual);
  const firstVideoY = state.tracks
    .filter((track) => track.type === "video")
    .reduce<number | null>((top, track) => (top === null ? track.y : Math.min(top, track.y)), null);
  const fallbackBottomY = state.tracks.reduce((bottom, track) => Math.max(bottom, track.y + track.height), 0);
  const fallbackY = virtualTrack?.y ?? firstVideoY ?? fallbackBottomY;
  const y = RULER_HEIGHT + (targetTrack?.y ?? fallbackY);
  const h = targetTrack?.height ?? TIMELINE_TRACK_HEIGHT_COMPACT;

  return {
    x: Math.max(0, x),
    y,
    w: Math.max(24, (trackType === "effect" ? 3 : 4) * state.zoom),
    h,
    trackIndex: targetTrackIndex,
    trackMissing: !targetTrack,
    time,
  };
}

/**
 * Determine the cursor style based on what's being hovered.
 */
export function getCursorForHit(hit: HitResult | null, isDragging: boolean, toolMode?: "select" | "hand" | "blade"): string {
  if (isDragging) return "grabbing";
  if (toolMode === "hand") return "grab";
  if (!hit) return toolMode === "blade" ? "crosshair" : "default";

  if (toolMode === "blade") {
    // In blade mode: crosshair over clips/scenes, default elsewhere
    if (hit.type === "clip" || hit.type === "scene") return "crosshair";
    if (hit.type === "ruler") return "text";
    return "crosshair";
  }

  switch (hit.type) {
    case "ruler": return "text";
    case "marker": return "grab";
    case "resize-left":
    case "resize-right": return "col-resize";
    case "clip": return "pointer";
    case "scene": return "grab";  // scene strips are draggable to new timeline positions
    case "music": return "pointer";
    case "keyframe": return "grab";
    case "transition": return "pointer";
    case "transition-resize-left":
    case "transition-resize-right": return "ew-resize";
    case "voiceover": return "pointer";
    case "voiceover-lock": return "pointer";
    case "track-empty": return "default";
    default: return "default";
  }
}
