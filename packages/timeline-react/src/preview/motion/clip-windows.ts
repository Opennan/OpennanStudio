// Transitions on upper-track clip cuts in the compositor (phase 10b): the export's clip lanes
// (export/src/compile/clip-lanes.ts) read through the same timeline-core rules — chains of touching V2+
// video/image clips joined by library transitions (looks/windows.ts), centered windows, live handles
// (looks/handles.ts) — so the preview draws the window the export renders. Pure: which clips, sides, local
// times, and media times to draw at a time; preview-panel.tsx draws them.
import { clipHandleMedia, snapHandles, transitionHandles } from "@opennan/timeline-core/looks/handles";
import { chainClipFades, clipTransitionChains, planTransitionWindows, windowProgress } from "@opennan/timeline-core/looks/windows";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { clipMediaStart } from "@opennan/timeline-core/motion/speed";
import { cachedClipSpeedProfile, mediaTimeAt } from "../speed-sync";

/** Seconds of the held frame (the export clones its last frame at 30 fps), and the export's handle frame rate. */
const HELD_FRAME_SECONDS = 1 / 30;
const HANDLE_FPS = 30;

interface PlannedWindow {
    trackIndex: number;
    a: TimelineClip;
    b: TimelineClip;
    type: string;
    half: number;
}

export interface ClipLanePlan {
    windows: PlannedWindow[];
    /** Every clip in a chain (it is drawn by its window inside the window). */
    chained: ReadonlySet<string>;
    /** The copy to draw (motion, fades): chain clips drop the fades their windows replace. */
    renderClip(clip: TimelineClip): TimelineClip;
}

export interface ClipWindowSide {
    /** The draw copy of the clip. */
    clip: TimelineClip;
    /** Item-local seconds to draw at (motion, look). */
    local: number;
    /** The editor's element shows this frame (the clip is on screen); else a still. */
    live: boolean;
    /** A moving frame past the clip's media span (live handle): read through the hidden decoder. */
    decoder: boolean;
    /** Video media second of the still frame (decoder or held snapshot); null for live sides and images. */
    mediaTime: number | null;
    /** Video media second of the side's held frame (what playback shows while the decoder catches up). */
    heldMediaTime: number | null;
}

export interface ClipWindowFrame {
    trackIndex: number;
    transitionId: string;
    p: number;
    a: ClipWindowSide;
    b: ClipWindowSide;
}

const plans = new WeakMap<readonly TimelineClip[], ClipLanePlan>();
/** Draw copies per clip object and dropped sides: an unchanged clip keeps its copy across clip arrays. */
const fadeCopies = new WeakMap<TimelineClip, Map<string, TimelineClip>>();

function fadeCopy(clip: TimelineClip, sides: { incoming: boolean; outgoing: boolean }): TimelineClip {
    const key = `${sides.incoming ? 1 : 0}${sides.outgoing ? 1 : 0}`;
    let copies = fadeCopies.get(clip);
    const cached = copies?.get(key);
    if (cached) return cached;
    const copy = chainClipFades(clip, sides);
    if (!copies) fadeCopies.set(clip, (copies = new Map()));
    copies.set(key, copy);
    return copy;
}

/** The chains among `clips` (memoized per array: the compositor calls this every frame). */
export function clipLanePlan(clips: readonly TimelineClip[]): ClipLanePlan {
    const cached = plans.get(clips);
    if (cached) return cached;
    const windows: PlannedWindow[] = [];
    const chained = new Set<string>();
    const copies = new Map<string, TimelineClip>();
    for (const chain of clipTransitionChains(clips)) {
        const planned = planTransitionWindows(chain.clips.map((c) => c.endTime - c.startTime), chain.joins);
        if (planned.size === 0) continue;
        chain.clips.forEach((clip, i) => {
            chained.add(clip.id);
            const copy = fadeCopy(clip, { incoming: planned.has(i - 1), outgoing: planned.has(i) });
            if (copy !== clip) copies.set(clip.id, copy);
        });
        for (const [i, window] of planned) {
            windows.push({ trackIndex: chain.trackIndex, a: chain.clips[i], b: chain.clips[i + 1], type: window.type, half: window.half });
        }
    }
    const plan: ClipLanePlan = { windows, chained, renderClip: (clip) => copies.get(clip.id) ?? clip };
    plans.set(clips, plan);
    return plan;
}

const isVideo = (clip: TimelineClip) => !clipHandleMedia(clip, null)?.still;

/** Video media second of a held (in-range) frame: the clip's own time map from its trimStart, as its element plays it. */
const heldMediaTime = (clip: TimelineClip, local: number) => mediaTimeAt(cachedClipSpeedProfile(clip), local, Math.max(0, clip.endTime - clip.startTime), clipMediaStart(clip));

/**
 * The clip-cut windows at timeline time `t`. `mediaDuration(url)` is the file length the preview knows (its
 * elements or decoders), null when unknown (then no media after the clip is assumed, as without a probe).
 */
export function clipWindowsAt(plan: ClipLanePlan, t: number, mediaDuration: (url: string) => number | null): ClipWindowFrame[] {
    const out: ClipWindowFrame[] = [];
    for (const window of plan.windows) {
        const cut = window.a.endTime;
        const p = windowProgress(t, cut, window.half);
        if (p === null) continue;
        const a = plan.renderClip(window.a);
        const b = plan.renderClip(window.b);
        const lengthA = a.endTime - a.startTime;
        const media = (clip: TimelineClip) => clipHandleMedia(clip, clip.mediaUrl ? mediaDuration(clip.mediaUrl) : null);
        const { outgoingAfter: after, incomingBefore: before } = snapHandles(transitionHandles(media(a), media(b), window.half), HANDLE_FPS);
        let sideA: ClipWindowSide;
        let sideB: ClipWindowSide;
        if (t < cut) {
            sideA = { clip: a, local: t - a.startTime, live: true, decoder: false, mediaTime: null, heldMediaTime: null };
            const local = before > 0 && b.startTime - t <= before ? t - b.startTime : before > 0 ? -before : 0;
            if (isVideo(b) && before > 0 && t - b.startTime > -before + 1e-9) {
                // Live incoming handle (a 1× clip trimmed into its media): the media before its trimStart, from the decoder.
                const start = clipMediaStart(b);
                sideB = { clip: b, local, live: false, decoder: true, mediaTime: start + local, heldMediaTime: start - before };
            } else {
                const media = isVideo(b) ? (local < 0 ? clipMediaStart(b) + local : heldMediaTime(b, local)) : null;
                sideB = { clip: b, local, live: false, decoder: false, mediaTime: media, heldMediaTime: media };
            }
        } else {
            sideB = { clip: b, local: t - b.startTime, live: true, decoder: false, mediaTime: null, heldMediaTime: null };
            const heldLocal = after > 0 ? lengthA + after - HELD_FRAME_SECONDS : Math.max(0, lengthA - HELD_FRAME_SECONDS);
            // Live after-handles only exist at 1×: media = trimStart + local past the clip's end too.
            const held = after > 0 ? clipMediaStart(a) + heldLocal : heldMediaTime(a, heldLocal);
            if (!isVideo(a)) {
                sideA = { clip: a, local: t - a.startTime, live: false, decoder: false, mediaTime: null, heldMediaTime: null };
            } else if (after > 0 && t - cut < after - 1e-9) {
                sideA = { clip: a, local: t - a.startTime, live: false, decoder: true, mediaTime: clipMediaStart(a) + (t - a.startTime), heldMediaTime: held };
            } else {
                sideA = { clip: a, local: heldLocal, live: false, decoder: false, mediaTime: held, heldMediaTime: held };
            }
        }
        out.push({ trackIndex: window.trackIndex, transitionId: window.type, p, a: sideA, b: sideB });
    }
    return out;
}

/** A decoded frame to draw (a snapshot canvas, an image). */
export interface StillFrame {
    source: TexImageSource;
    width: number;
    height: number;
}

/** What windowStillFrame reads (FrameSnapshots in the compositor). */
export interface WindowSnapshots {
    live(url: string, time: number): (StillFrame & { time: number; exact: boolean }) | null;
    video(url: string, time: number): StillFrame | null;
    /** The media errored or timed out: waiting for it would never end. */
    failed(url: string): boolean;
}

/** While playing, a decoder frame this close to the wanted time stands in for it. */
const LIVE_NEAR_SECONDS = 0.25;

/**
 * The frame of a window's still VIDEO side: "wait" (paused, keep the canvas until the exact frame is ready),
 * a frame, or null (draw the live side alone). Paused waits for the exact frame; playing never waits (a near
 * decoder frame, else the held frame). Media that failed is never waited for: the held frame if ready, else null.
 */
export function windowStillFrame(side: ClipWindowSide, snapshots: WindowSnapshots, playing: boolean): StillFrame | "wait" | null {
    const url = side.clip.mediaUrl;
    if (!url || side.mediaTime === null) return null;
    const settle = (frame: StillFrame | null): StillFrame | "wait" | null => frame ?? (playing || snapshots.failed(url) ? null : "wait");
    if (!side.decoder) return settle(snapshots.video(url, side.mediaTime));
    const frame = snapshots.live(url, side.mediaTime);
    if (frame?.exact) return frame;
    if (!playing && !snapshots.failed(url)) return "wait";
    if (playing && frame && Math.abs(frame.time - side.mediaTime) <= LIVE_NEAR_SECONDS) return frame;
    return side.heldMediaTime !== null ? settle(snapshots.video(url, side.heldMediaTime)) : null;
}
