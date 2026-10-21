// Shared canvas timeline data structures for rendering, hit detection, and editing.
import type { ClipEffect, TimelineTrack, TimelineClip } from "../../model/timeline";
import type { AudioTarget } from "../../model/editor";

/** One drawn storyboard sheet of a scene (phase 9c, OpenNan cloud projects): the whole sheet and its panels, one per shot. Read only. */
export interface StoryboardSheet {
  imageUrl: string | null;
  panels: Array<{ index: number; shotIndex: number; imageUrl: string }>;
}

// ── Scene data passed from editor ──────────────────────────
export interface SceneData {
  id: string;
  order: number;
  caption: string;
  startTime: string;
  endTime: string;
  /** Absolute V1 timeline position in seconds. When >0, overrides end-to-end layout. */
  timelinePositionSeconds?: number;
  /** Video track the scene sits on (1 = V1, 2+ = overlay tracks). */
  trackIndex?: number;
  startImageUrl: string | null;
  startImageThumbUrl?: string | null;
  endImageUrl: string | null;
  endImageThumbUrl?: string | null;
  videoUrl: string | null;
  sourceVideoUrl?: string | null;
  videoPosterUrl?: string | null;
  videoStoryboardUrl?: string | null;
  videoStoryboardRawUrl?: string | null;
  status: string;
  transition: string;
  /** Visual transition (crossfade/dissolve/fade) rendered at this scene's cut to the next. */
  visualTransition?: string | null;
  visualTransitionDuration?: number | null;
  /** Look (phase 10a): filter preset id, its strength 0..1, the 13 Adjust controls as JSON, and the effect stack. */
  visualFilter?: string | null;
  filterIntensity?: number | null;
  adjustmentsJson?: string | null;
  effects?: ClipEffect[] | null;
  cardType?: string | null;
  duration?: number | null;
  overlayText?: string | null;
  frameConsistencyScore: number | null;
  audioUrl: string | null;
  audioText: string | null;
  cardConfig: string | null;
  shotBreakdown?: string | null;
  /** The scene's drawn storyboard on OpenNan (phase 9c): its sheets and their panels; read only, absent when none is drawn. */
  storyboardSheets?: StoryboardSheet[] | null;
  /** Preview/render transform — CapCut-style fit controls. */
  fitMode?: "contain" | "cover" | "fill" | null;
  transformScale?: number | null;
  transformOffsetX?: number | null;
  transformOffsetY?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  /** Motion (phase 10b): keyframes (scale = transformScale, position_x/y = transformOffsetX/Y), animation, rotation, opacity. */
  keyframesJson?: string | null;
  animationJson?: string | null;
  rotationDegrees?: number | null;
  opacity?: number | null;
  /** Speed (phase 10b, motion/speed.ts): constant speed 0.1..100, curve, keep pitch. */
  playbackSpeed?: number | null;
  speedCurveJson?: string | null;
  preservePitch?: boolean | null;
  /** Mask (phase 10c, looks/masks.ts MaskSpec as JSON); absent or null = no mask. */
  maskJson?: string | null;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label?: string;
}

// ── Layout computed per-frame ──────────────────────────────
export interface TrackLayoutEntry {
  key: string;               // e.g. "video-1", "text-2"
  type: string;
  index: number;
  y: number;                 // top pixel offset (below ruler)
  height: number;            // px (default 64)
  track: TimelineTrack | null; // null for built-in V1/A1 without track data
  /** Temporary layout row used for drag/drop previews before a DB track exists. */
  virtual?: boolean;
  locked: boolean;
  muted: boolean;
  visible: boolean;
}

// ── Canvas-level snapshot for render ───────────────────────
export interface CanvasState {
  scenes: SceneData[];
  tracks: TrackLayoutEntry[];
  clips: TimelineClip[];
  markers?: TimelineMarker[];
  selectedMarkerId?: string | null;
  selectedClipIds: Set<string>;
  selectedSceneIds: Set<string>;
  selectedSceneId: string | null;
  selectedAudioTarget: AudioTarget | null;
  /** Selected junction-transition marker (clip or scene) for highlight + delete. */
  selectedTransition?: { kind: "clip" | "scene"; id: string } | null;
  zoom: number;              // px per second
  scrollLeft: number;
  currentTime: number;
  totalDuration: number;
  musicUrl: string | null;
  musicVolume: number;
  snapEnabled: boolean;
  hoveredClipId: string | null;
  containerWidth: number;
  containerHeight: number;
  toolMode: "select" | "hand" | "blade";
  bladeX: number | null;            // world-space X for blade preview line
  unlockedVoiceovers: Set<string>;          // scene IDs with unlocked voiceover blocks
  voiceoverOffsets: Map<string, number>;     // scene ID → manual time offset (seconds)
  /** clip/scene id → maximum end time (seconds) it may be resized to, based on the
   * real source footage length. resize-right is clamped to this so a clip can't be
   * dragged longer than its source video. Absent/unset = no known limit. */
  maxEndById?: Map<string, number> | null;
  /** Live scene-timeline drag — the dragged scene follows the cursor in X (time)
   * and Y (vertical lift) for CapCut-style pick-up feedback. On drop, only the
   * X component is committed (scenes live on V1); Y is purely visual. */
  sceneTimelineDrag?: { sceneId: string; deltaX: number; deltaY: number } | null;
  /** Clips linked to a scene drag, such as selected subtitles/audio moving with
   * the video scene. Values are live preview positions in absolute seconds. */
  linkedClipDragPositions?: Map<string, { startTime: number; endTime: number }> | null;
  linkedSceneDragPositions?: Map<string, { startTime: number }> | null;
  /** Live shot drag — the selected shot inside a scene is being moved. The
   * renderer draws a highlight around the source shot and a ghost at the
   * cursor so the user sees it picked up. */
  shotDrag?: {
    sceneId: string;
    shotIndex: number;
    cursorWorldX: number;
    cursorY: number;
  } | null;
  /** Persistent shot selection — set by a double-click on a shot. The renderer
   * paints a yellow outline on the selected shot so the user knows which shot
   * will be moved when they drag it next. */
  selectedShot?: { sceneId: string; shotIndex: number } | null;
  /** Live scene-edge resize — when the user is dragging the start or end
   * edge of a scene strip, this carries the new start/duration so the
   * renderer can draw the scene at its proposed size in real time. */
  sceneEdgeResize?: {
    sceneId: string;
    edge: "left" | "right";
    newStart: number;
    newDuration: number;
    /** True when only holding the committed size for the server round-trip —
     * the renderer keeps the strip size but hides the duration badge. */
    pending?: boolean;
    /** Set when the dragged edge is magnetized onto another boundary —
     * the renderer draws a vertical snap guide at this time. */
    snapTime?: number | null;
  } | null;
  /** Live transition duration drag — grabbing the end of a transition shape.
   * The renderer draws the shape at the proposed duration plus a time badge. */
  transitionResize?: {
    id: string;
    kind: "clip" | "scene";
    durationSeconds: number;
  } | null;
  /** Junction drop guides while a transition card is dragged from the library:
   * every same-track cut, marked valid/invalid for the dragged duration. */
  transitionDropGuides?: import("./transition-markers").TransitionJunction[] | null;
  /** The keyframe picked on the timeline (item-local seconds), drawn white with a ring (phase 10c). */
  selectedKeyframe?: { clipId?: string; sceneId?: string; time: number } | null;
  /** A keyframe being retimed: the ghost diamond and its new time are drawn at `to` (item-local seconds). */
  keyframeDrag?: { clipId?: string; sceneId?: string; from: number; to: number } | null;
  /** The keyframe whose (visually hidden) keyboard button has focus: drawn with the focus ring (phase 10d). */
  focusedKeyframe?: { clipId?: string; sceneId?: string; time: number } | null;
  /** Snap to beats (phase 11): beat times join the snap points. */
  snapToBeats?: boolean;
  /** Beat times on the timeline (beatTimesOnTimeline), precomputed by the host; computed from the clips when absent. */
  beatTimes?: number[];
  /** AI jobs by clip or scene id (phase 11): a progress line along the bottom of the item. */
  aiActivity?: Record<string, { progress?: number; changed?: boolean }> | null;
  /** Ranges a silences / fillers preview would cut (timeline seconds), drawn as ghost regions (phase 11). */
  cutPreview?: { ranges: Array<{ start: number; end: number }>; kind: "silences" | "fillers" } | null;
}

// ── Hit detection ──────────────────────────────────────────
export type HitType =
  | "ruler"
  | "marker"
  | "clip"
  | "resize-left"
  | "resize-right"
  | "scene"
  | "shot"
  | "voiceover"
  | "voiceover-lock"
  | "music"
  | "transition"
  | "transition-resize-left"
  | "transition-resize-right"
  | "track-empty"
  /** A keyframe diamond of the selected clip or scene (phase 10c); `keyframeTime` is item-local. */
  | "keyframe";

export interface HitResult {
  type: HitType;
  clipId?: string;
  sceneId?: string;
  shotIndex?: number;
  trackKey?: string;
  markerId?: string;
  /** Item-local time of the keyframe under the pointer (type "keyframe"). */
  keyframeTime?: number;
  time: number;
}

// ── Drag state machine ─────────────────────────────────────
export type DragMode = "idle" | "move" | "resize-left" | "resize-right" | "ruler-scrub" | "marquee";

export interface DragState {
  mode: DragMode;
  clipId: string | null;
  // Original positions + track when drag started
  originals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  snapTime: number | null;      // active snap target
  snapSource: SnapPoint["source"] | null; // active snap target kind
  snapEdge: SnapEdge | null;    // dragged edge currently aligned to the target
  snapDeltaTime: number | null; // move delta after snapping, shared by all dragged clips
  moveDeltaTime: number | null; // final move delta after snap and same-track collision clamp
  resizeTime: number | null;    // final resize edge time after snap and same-track collision clamp
  targetTrackKey: string | null; // track the primary clip is currently hovering over
  committed: boolean;           // whether we've exceeded drag threshold
  // Snap targets collected once at drag start (they can't change mid-drag);
  // null = collect lazily from state (manual DragState constructions).
  snapPoints: SnapPoint[] | null;
}

// ── Snap ───────────────────────────────────────────────────
export interface SnapPoint {
  time: number;
  source: "clip-start" | "clip-end" | "clip-keyframe" | "scene-boundary" | "playhead" | "marker" | "beat";
}

export type SnapEdge = "start" | "end" | "resize";

export interface SnapGuide {
  time: number;
  source: SnapPoint["source"];
  distanceSeconds: number;
  edge?: SnapEdge;
}

// ── Thumbnails ─────────────────────────────────────────────
export interface ThumbnailEntry {
  time: number;
  bitmap: ImageBitmap;
}

export interface ThumbnailCache {
  get(url: string, time: number): ImageBitmap | undefined;
  request(url: string, times: number[]): void;
  cancelUnused(keepUrls: Set<string>): void;
  onUpdate: (() => void) | null;
}

// ── Waveforms ──────────────────────────────────────────────
export interface WaveformData {
  peaks: Float32Array;         // normalized 0-1
  sampleRate: number;          // peaks per second
  duration: number;
}

export interface WaveformCache {
  get(url: string): WaveformData | undefined;
  request(url: string): void;
  cancelUnused(keepUrls: Set<string>): void;
  onUpdate: (() => void) | null;
}

// ── Clip position commit (batched on mouseup) ──────────────
export interface ClipCommit {
  clipId: string;
  startTime: number;
  endTime: number;
  trackType?: string;   // set when clip moved to a different track
  trackIndex?: number;
}
