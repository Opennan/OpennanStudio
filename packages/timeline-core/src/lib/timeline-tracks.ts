// Build the next timeline track of a given type. Video and audio tracks start
// at index 2 because index 1 is the primary lane; text/sticker/effect/remotion start at 1.

export interface TimelineTrackLike {
    type: "video" | "audio" | "text" | "sticker" | "effect" | "remotion";
    index: number;
    label: string;
    muted: boolean;
    locked: boolean;
    visible: boolean;
    volume: number;
}

const TIMELINE_TRACK_TYPES = new Set(["video", "audio", "text", "sticker", "effect", "remotion"]);

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    return fallback;
}

function normalizeVolume(value: unknown): number {
    const volume = Number(value);
    return Number.isFinite(volume) ? volume : 1.0;
}

export function normalizeTimelineTracks(tracks: TimelineTrackLike[]): TimelineTrackLike[] {
    const order: string[] = [];
    const byKey = new Map<string, TimelineTrackLike>();

    for (const track of tracks) {
        if (!TIMELINE_TRACK_TYPES.has(track.type)) continue;
        const index = Math.trunc(Number(track.index));
        if (!Number.isFinite(index) || index < 1) continue;
        const key = `${track.type}-${index}`;
        if (!byKey.has(key)) order.push(key);
        const label = typeof track.label === "string" && track.label.trim()
            ? track.label.trim()
            : `${track.type[0].toUpperCase()}${index}`;
        byKey.set(key, {
            type: track.type,
            index,
            label,
            muted: normalizeBoolean(track.muted, false),
            locked: normalizeBoolean(track.locked, false),
            visible: normalizeBoolean(track.visible, true),
            volume: normalizeVolume(track.volume),
        });
    }

    return order.map((key) => byKey.get(key)).filter((track): track is TimelineTrackLike => Boolean(track));
}

/** Set one track's fader, clamped to 0–1. Returns the input array untouched
 *  when the track key doesn't exist or the volume is already equal. */
export function setTimelineTrackVolume<T extends { type: string; index: number; volume: number }>(
    tracks: T[],
    trackKey: string,
    volume: number,
): T[] {
    const clamped = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    let changed = false;
    const updated = tracks.map((track) => {
        if (`${track.type}-${track.index}` !== trackKey || track.volume === clamped) return track;
        changed = true;
        return { ...track, volume: clamped };
    });
    return changed ? updated : tracks;
}

/** Pick the first candidate track index whose lane is free over
 *  [startTime, endTime) — a dropped clip must never land on top of an
 *  existing clip. Touching edges (end === start) don't count as overlap.
 *  Returns null when every candidate lane is occupied at the drop range,
 *  meaning the caller should create a new track. */
export function resolveNonOverlappingTrackIndex(
    clips: { trackType: string; trackIndex: number; startTime: number; endTime: number }[],
    type: TimelineTrackLike["type"],
    candidateIndices: number[],
    startTime: number,
    endTime: number,
): number | null {
    for (const index of candidateIndices) {
        const occupied = clips.some((clip) => (
            clip.trackType === type &&
            clip.trackIndex === index &&
            clip.startTime < endTime &&
            clip.endTime > startTime
        ));
        if (!occupied) return index;
    }
    return null;
}

/** Swap the lane positions of two SAME-TYPE tracks (drag-reorder on the track
 *  rail). The primary lanes (video-1 scene strip, audio-1 voiceover/music)
 *  are pinned and never swap. Default labels ("V2"/"A3"-style) follow the new
 *  index; custom labels travel with their track untouched. Returns null when
 *  the swap is not allowed. */
export function swapTimelineTrackOrder<T extends { type: string; index: number; label: string }>(
    tracks: T[],
    keyA: string,
    keyB: string,
): T[] | null {
    if (keyA === keyB) return null;
    const parse = (key: string) => {
        const sep = key.lastIndexOf("-");
        return { type: key.slice(0, sep), index: Number(key.slice(sep + 1)) };
    };
    const a = parse(keyA);
    const b = parse(keyB);
    if (a.type !== b.type) return null;
    if ((a.type === "video" || a.type === "audio") && (a.index === 1 || b.index === 1)) return null;
    const trackA = tracks.find((t) => t.type === a.type && t.index === a.index);
    const trackB = tracks.find((t) => t.type === b.type && t.index === b.index);
    if (!trackA || !trackB) return null;

    const isDefaultLabel = (t: T) => new RegExp(`^${t.type[0].toUpperCase()}${t.index}$`).test(t.label);
    const swapped = tracks.map((t) => {
        if (t === trackA) {
            return { ...t, index: b.index, label: isDefaultLabel(t) ? `${t.type[0].toUpperCase()}${b.index}` : t.label };
        }
        if (t === trackB) {
            return { ...t, index: a.index, label: isDefaultLabel(t) ? `${t.type[0].toUpperCase()}${a.index}` : t.label };
        }
        return t;
    });
    return swapped;
}

export function nextTrackForType(
    tracks: { type: string; index: number }[],
    type: TimelineTrackLike["type"],
): TimelineTrackLike {
    const existing = tracks.filter((t) => t.type === type);
    const maxIndex = existing.length > 0 ? Math.max(...existing.map((t) => t.index)) : 0;
    const newIndex = maxIndex + 1;
    const actualIndex = (type === "video" || type === "audio") && newIndex <= 1 ? 2 : newIndex;
    return {
        type,
        index: actualIndex,
        label: `${type[0].toUpperCase()}${actualIndex}`,
        muted: false,
        locked: false,
        visible: true,
        volume: 1.0,
    };
}
