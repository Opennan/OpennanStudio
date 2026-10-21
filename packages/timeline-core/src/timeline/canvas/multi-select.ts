// Selection helpers for canvas timeline click, marquee, and context actions.
import type { TimelineClip } from "../../model/timeline";

export type MarqueeSelectionMode = "replace" | "add" | "subtract";

type MarqueeClip = Pick<TimelineClip, "id" | "trackType" | "trackIndex" | "startTime" | "endTime">;

type MarqueeTrack = {
  type: string;
  index: number;
  y: number;
  height: number;
  visible?: boolean;
  locked?: boolean;
};

type SelectableTrack = {
  type: string;
  index: number;
  visible?: boolean | null;
  locked?: boolean | null;
};

type SelectionClip = Pick<TimelineClip, "id" | "trackType" | "trackIndex" | "startTime" | "endTime"> & {
  locked?: boolean | null;
};

function isSelectableClip(clip: SelectionClip, tracks?: SelectableTrack[]): boolean {
  if (clip.locked) return false;
  if (!tracks) return true;
  const track = tracks.find((item) => item.type === clip.trackType && item.index === clip.trackIndex);
  return !track?.locked && track?.visible !== false;
}

export function computeMarqueeHitClipIds({
  clips,
  tracks,
  rect,
  scrollLeft,
  zoom,
  rulerHeight,
}: {
  clips: MarqueeClip[];
  tracks: MarqueeTrack[];
  rect: { x0: number; x1: number; y0: number; y1: number };
  scrollLeft: number;
  zoom: number;
  rulerHeight: number;
}): Set<string> {
  const t0 = (rect.x0 + scrollLeft) / zoom;
  const t1 = (rect.x1 + scrollLeft) / zoom;
  const hitIds = new Set<string>();

  for (const clip of clips) {
    const trackEntry = tracks.find((track) => track.type === clip.trackType && track.index === clip.trackIndex);
    if (!trackEntry || trackEntry.locked || trackEntry.visible === false) continue;

    const cy0 = trackEntry.y + rulerHeight;
    const cy1 = cy0 + trackEntry.height;
    const xOverlap = clip.startTime < t1 && clip.endTime > t0;
    const yOverlap = cy0 < rect.y1 && cy1 > rect.y0;
    if (xOverlap && yOverlap) hitIds.add(clip.id);
  }

  return hitIds;
}

/** Scene strips (main and upper video tracks) a marquee box touches; locked or hidden tracks are skipped. */
export function computeMarqueeHitSceneIds({
  scenes,
  tracks,
  rect,
  scrollLeft,
  zoom,
  rulerHeight,
}: {
  scenes: Array<{ id: string; trackIndex: number; start: number; end: number }>;
  tracks: MarqueeTrack[];
  rect: { x0: number; x1: number; y0: number; y1: number };
  scrollLeft: number;
  zoom: number;
  rulerHeight: number;
}): Set<string> {
  const t0 = (rect.x0 + scrollLeft) / zoom;
  const t1 = (rect.x1 + scrollLeft) / zoom;
  const hitIds = new Set<string>();
  for (const scene of scenes) {
    const track = tracks.find((item) => item.type === "video" && item.index === scene.trackIndex);
    if (!track || track.locked || track.visible === false) continue;
    const y0 = track.y + rulerHeight;
    const y1 = y0 + track.height;
    if (scene.start < t1 && scene.end > t0 && y0 < rect.y1 && y1 > rect.y0) hitIds.add(scene.id);
  }
  return hitIds;
}

export function computeMarqueeSelection({
  baseSelection,
  hitClipIds,
  mode,
}: {
  baseSelection: Set<string>;
  hitClipIds: Set<string>;
  mode: MarqueeSelectionMode;
}): Set<string> {
  if (mode === "replace") return new Set(hitClipIds);

  const next = new Set(baseSelection);
  for (const id of hitClipIds) {
    if (mode === "subtract") {
      next.delete(id);
    } else {
      next.add(id);
    }
  }
  return next;
}

export function computeContextActionClipIds(
  clickedId: string,
  currentSelection: Set<string>,
): Set<string> {
  if (currentSelection.has(clickedId)) return new Set(currentSelection);
  return new Set([clickedId]);
}

/**
 * Compute the new selection set based on a click event.
 */
export function computeSelection(
  clickedId: string,
  currentSelection: Set<string>,
  clips: SelectionClip[],
  modifiers: { ctrl: boolean; shift: boolean },
  tracks?: SelectableTrack[],
): Set<string> {
  const clickedClipForEditability = clips.find((clip) => clip.id === clickedId);
  if (clickedClipForEditability && !isSelectableClip(clickedClipForEditability, tracks)) return new Set(currentSelection);

  // Ctrl/Cmd+Click: toggle in selection
  if (modifiers.ctrl) {
    const next = new Set(currentSelection);
    if (next.has(clickedId)) {
      next.delete(clickedId);
    } else {
      next.add(clickedId);
    }
    return next;
  }

  // Shift+Click: range select within same track
  if (modifiers.shift && currentSelection.size > 0) {
    const clickedClip = clips.find(c => c.id === clickedId);
    if (!clickedClip) return new Set([clickedId]);

    // Find the track of the first selected clip
    const firstSelectedId = currentSelection.values().next().value;
    const firstClip = clips.find(c => c.id === firstSelectedId);
    if (!firstClip) return new Set([clickedId]);

    // Only range-select within the same track
    const sameTrackKey = `${clickedClip.trackType}-${clickedClip.trackIndex}`;
    const firstTrackKey = `${firstClip.trackType}-${firstClip.trackIndex}`;
    if (sameTrackKey !== firstTrackKey) {
      return new Set([clickedId]);
    }

    // Get all clips in this track, sorted by startTime
    const trackClips = clips
      .filter(c => `${c.trackType}-${c.trackIndex}` === sameTrackKey)
      .filter((clip) => isSelectableClip(clip, tracks))
      .sort((a, b) => a.startTime - b.startTime);

    const clickIdx = trackClips.findIndex(c => c.id === clickedId);
    const firstIdx = trackClips.findIndex(c => c.id === firstSelectedId);
    if (clickIdx === -1 || firstIdx === -1) return new Set([clickedId]);

    const lo = Math.min(clickIdx, firstIdx);
    const hi = Math.max(clickIdx, firstIdx);
    const rangeIds = trackClips.slice(lo, hi + 1).map(c => c.id);
    return new Set(rangeIds);
  }

  // Plain click: replace selection
  return new Set([clickedId]);
}

/**
 * Select all clips in the timeline.
 */
export function selectAll(clips: TimelineClip[]): Set<string> {
  return new Set(clips.map(c => c.id));
}
