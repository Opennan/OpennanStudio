// Transitions on upper-track clip cuts (phase 10b). Touching V2+ video/image clips joined by library
// transitions (timeline-core looks/windows.ts clipTransitionChains, the preview's rule too) compile as one
// transparent full-frame lane: each clip is drawn on a clear frame with its usual overlay placement, motion,
// look, and fades (compile/overlays.ts in range mode), cut into head / body / tail pieces like a scene lane,
// and every cut is a centered window mixed by the shared transition expression on gbrap (compile/lanes.ts
// transitionWindow) with live handles where the media continues (looks/handles.ts). The lane is overlaid on
// the composite once, in track order; clips outside such chains keep the per-clip overlay path unchanged.
//
// Lane timing: the first clip starts on the first frame at or after its start (the per-clip path's first
// visible frame), each cut sits on the outgoing clip's end snapped to frames, and a clip's item-local frames
// count from its own start, so every lane frame shows the clip frame the per-clip path would show.
import type { TimelineClip } from "@opennan/timeline-core";
import { clipHandleMedia, snapHandles, transitionHandles, type TransitionHandles } from "@opennan/timeline-core/looks/handles";
import { chainClipFades, clipTransitionChains, planTransitionWindows, type TransitionWindow } from "@opennan/timeline-core/looks/windows";
import { fmt } from "../format";
import type { CompileContext } from "./context";
import { gapSegment, transitionWindow } from "./lanes";
import { compileOverlay, type OverlaySource } from "./overlays";

interface LaneClip {
    source: OverlaySource;
    /** Lane seconds (timeline, frame-snapped) the clip occupies. */
    start: number;
    end: number;
    /** Item-local seconds of the clip at its lane start (whole frames). */
    shift: number;
}

export interface ClipLane {
    trackIndex: number;
    clips: LaneClip[];
    windows: Map<number, TransitionWindow>;
    handles: Map<number, TransitionHandles>;
}

/**
 * The chains among `clips` (playable V2+ overlay clips) that compile as lanes: every clip readable (`sourceOf`
 * warns and returns null otherwise) and at least one window that holds a frame at the export rate.
 */
export function planClipLanes(ctx: CompileContext, clips: readonly TimelineClip[], sourceOf: (clip: TimelineClip) => OverlaySource | null): ClipLane[] {
    const { fps } = ctx.format;
    const frame = (seconds: number) => Math.round(seconds * fps) / fps;
    const frameUp = (seconds: number) => Math.ceil(seconds * fps - 1e-6) / fps;
    const lanes: ClipLane[] = [];
    for (const chain of clipTransitionChains(clips)) {
        const sources = chain.clips.map((clip) => sourceOf(clip));
        if (sources.some((source) => !source)) continue;
        const placed: LaneClip[] = [];
        let cursor = frameUp(chain.clips[0].startTime);
        chain.clips.forEach((clip, i) => {
            const start = cursor;
            const end = Math.max(start, frame(clip.endTime));
            placed.push({ source: sources[i]!, start, end, shift: Math.floor((start - clip.startTime) * fps + 1e-6) / fps });
            cursor = end;
        });
        if (placed.some((p) => p.end - p.start < 1 / fps / 2)) continue;
        const windows = planTransitionWindows(placed.map((p) => p.end - p.start), chain.joins, fps);
        if (windows.size === 0) continue;
        const handles = new Map<number, TransitionHandles>();
        const probed = (clip: TimelineClip) => {
            const info = clip.mediaUrl ? ctx.media.get(clip.mediaUrl) : undefined;
            return clipHandleMedia(clip, info && info.durationSeconds > 0 ? info.durationSeconds : null);
        };
        for (const [i, window] of windows) {
            handles.set(i, snapHandles(transitionHandles(probed(chain.clips[i]), probed(chain.clips[i + 1]), window.half), fps));
        }
        // The window replaces the fades at its cuts (looks/windows.ts chainClipFades, as the preview draws them).
        for (let i = 0; i < placed.length; i += 1) {
            const clip = chainClipFades(placed[i].source.clip, { incoming: windows.has(i - 1), outgoing: windows.has(i) });
            if (clip !== placed[i].source.clip) placed[i].source = { ...placed[i].source, clip };
        }
        lanes.push({ trackIndex: chain.trackIndex, clips: placed, windows, handles });
    }
    return lanes;
}

/** Overlays one clip lane on `below` and returns the new composite pad. */
export function compileClipLane(ctx: CompileContext, below: string, lane: ClipLane): string {
    const { graph } = ctx;
    const { fps } = ctx.format;
    const pieces: string[] = [];
    let pendingTail: { pad: string; live: number } | null = null;
    lane.clips.forEach((item, i) => {
        const duration = item.end - item.start;
        const incoming = lane.windows.get(i - 1);
        const outgoing = lane.windows.get(i);
        const headHalf = incoming?.half ?? 0;
        const tailHalf = outgoing?.half ?? 0;
        const before = lane.handles.get(i - 1)?.incomingBefore ?? 0;
        const after = lane.handles.get(i)?.outgoingAfter ?? 0;
        // Lane-relative seconds [from, to) of the clip as its own clear full-frame stream.
        const piece = (from: number, to: number) => {
            const canvas = gapSegment(ctx, to - from, false).label;
            const drawn = compileOverlay(ctx, canvas, item.source, { from: item.shift + from, to: item.shift + to, after, before });
            return graph.chain([drawn], ["format=yuva420p", `settb=1/${fps}`], graph.label("cp"));
        };
        if (incoming && pendingTail) {
            pieces.push(transitionWindow(ctx, pendingTail.pad, piece(-before, headHalf), incoming.type, incoming.half, false, { tail: pendingTail.live, head: before }));
        }
        if (duration - headHalf - tailHalf >= 1 / fps / 2) pieces.push(piece(headHalf, duration - tailHalf));
        pendingTail = outgoing ? { pad: piece(duration - tailHalf, duration + after), live: after } : null;
    });
    const start = lane.clips[0].start;
    const end = lane.clips[lane.clips.length - 1].end;
    const joined = pieces.length === 1 ? [] : [`concat=n=${pieces.length}:v=1:a=0`, `settb=1/${fps}`];
    const layer = graph.chain(pieces, [...joined, `setpts=PTS-STARTPTS+${fmt(start)}/TB`], graph.label("cl"));
    return graph.chain([below, layer], [`overlay=0:0:eof_action=pass:format=auto:enable='between(t,${fmt(start)},${fmt(end)})'`], graph.label("ov"));
}
