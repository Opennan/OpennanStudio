import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { clipLanePlan, clipWindowsAt, windowStillFrame, type ClipWindowSide, type WindowSnapshots } from "./clip-windows";

const clip = (id: string, start: number, end: number, patch: Record<string, unknown> = {}): TimelineClip =>
    optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: `/m/${id}.mp4`, mediaType: "video", ...patch }, "p", id);

describe("clipLanePlan / clipWindowsAt (compositor clip-cut transitions)", () => {
    const a = clip("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1, fadeOutDuration: 0.5, fadeInDuration: 0.2 });
    const b = clip("b", 2, 4, { fadeInDuration: 0.3 });
    const clips = [a, b, clip("c", 5, 6), clip("t", 0, 3, { trackType: "text", trackIndex: 1, mediaUrl: null })];

    it("finds chain windows and the draw copies of chain clips (the window replaces their junction fades)", () => {
        const plan = clipLanePlan(clips);
        expect(plan.windows).toHaveLength(1);
        expect(plan.renderClip(a)).toMatchObject({ fadeInDuration: 0.2, fadeOutDuration: 0 });
        expect(plan.renderClip(b)).toMatchObject({ fadeInDuration: 0 });
        expect(plan.renderClip(clips[2])).toBe(clips[2]);
        // Memoized per clips array.
        expect(clipLanePlan(clips)).toBe(plan);
    });

    it("keeps the same draw copy of an unchanged chain clip across clip arrays (motion memos keyed by clip hit)", () => {
        const plan = clipLanePlan(clips);
        const edited = [...clips.slice(0, 2), clip("c", 5, 6.5), clips[3]];
        const next = clipLanePlan(edited);
        expect(next).not.toBe(plan);
        expect(next.renderClip(a)).toBe(plan.renderClip(a));
        expect(next.renderClip(b)).toBe(plan.renderClip(b));
        // A changed clip (new object) gets a new copy; so does a change of which fades the windows replace.
        const a2 = { ...a, fadeInDuration: 0.4 };
        expect(clipLanePlan([a2, b]).renderClip(a2)).not.toBe(plan.renderClip(a));
        expect(clipLanePlan([a2, b]).renderClip(a2)).toMatchObject({ fadeInDuration: 0.4, fadeOutDuration: 0 });
    });

    it("before the cut: the outgoing clip is live, the incoming video holds its first frame", () => {
        const [w] = clipWindowsAt(clipLanePlan(clips), 1.75, () => 10);
        expect(w).toMatchObject({ trackIndex: 2, transitionId: "wipe_left", p: 0.25 });
        expect(w.a).toMatchObject({ live: true, local: 1.75 });
        expect(w.b).toMatchObject({ live: false, decoder: false, local: 0, mediaTime: 0 });
        expect(w.a.clip.fadeOutDuration).toBe(0);
        expect(clipWindowsAt(clipLanePlan(clips), 1.4, () => 10)).toEqual([]);
    });

    it("after the cut: the outgoing video plays on from media past its end while the file has it, then holds", () => {
        // a's file is 2.2 s long: 0.2 s (6 frames) after its end.
        const inside = clipWindowsAt(clipLanePlan(clips), 2.1, (url) => (url === "/m/a.mp4" ? 2.2 : null))[0];
        expect(inside.a).toMatchObject({ live: false, decoder: true });
        expect(inside.a.local).toBeCloseTo(2.1, 9);
        expect(inside.a.mediaTime).toBeCloseTo(2.1, 9);
        expect(inside.b).toMatchObject({ live: true });
        expect(inside.b.local).toBeCloseTo(0.1, 9);
        const held = clipWindowsAt(clipLanePlan(clips), 2.3, (url) => (url === "/m/a.mp4" ? 2.2 : null))[0];
        expect(held.a).toMatchObject({ live: false, decoder: false });
        expect(held.a.mediaTime).toBeCloseTo(2.2 - 1 / 30, 9);
        // Unknown length: the 10a held last frame.
        const unknown = clipWindowsAt(clipLanePlan(clips), 2.1, () => null)[0];
        expect(unknown.a).toMatchObject({ decoder: false });
        expect(unknown.a.mediaTime).toBeCloseTo(2 - 1 / 30, 9);
    });

    it("a split pair plays from its trims: the incoming half shows the live media before its trimStart, the outgoing half the media after its end", () => {
        const left = clip("l", 0, 2, { mediaUrl: "/m/v.mp4", trimStart: 1, trimEnd: 3, transitionType: "wipe_left", transitionDuration: 1 });
        const right = clip("r", 2, 4, { mediaUrl: "/m/v.mp4", trimStart: 3, trimEnd: 5 });
        const plan = clipLanePlan([left, right]);
        const [before] = clipWindowsAt(plan, 1.75, () => 10);
        expect(before.b).toMatchObject({ live: false, decoder: true });
        expect(before.b.local).toBeCloseTo(-0.25, 9);
        expect(before.b.mediaTime).toBeCloseTo(2.75, 9);
        expect(before.b.heldMediaTime).toBeCloseTo(2.5, 9);
        const [after] = clipWindowsAt(plan, 2.1, () => 10);
        expect(after.a).toMatchObject({ live: false, decoder: true });
        expect(after.a.mediaTime).toBeCloseTo(3.1, 9);
        expect(after.a.heldMediaTime).toBeCloseTo(3.5 - 1 / 30, 9);
        // Without media after the outgoing half, it holds its own last frame (from its trimStart).
        const [held] = clipWindowsAt(plan, 2.1, () => 3);
        expect(held.a).toMatchObject({ decoder: false });
        expect(held.a.mediaTime).toBeCloseTo(3 - 1 / 30, 9);
    });

    it("images have full handles: their local time simply continues, with no media time", () => {
        const stills = [clip("i", 0, 2, { mediaType: "image", mediaUrl: "/m/i.png", transitionType: "cross_dissolve", transitionDuration: 1 }), clip("j", 2, 4, { mediaType: "image", mediaUrl: "/m/j.png" })];
        const [before] = clipWindowsAt(clipLanePlan(stills), 1.8, () => null);
        expect(before.b).toMatchObject({ live: false, mediaTime: null });
        expect(before.b.local).toBeCloseTo(-0.2, 9);
        const [after] = clipWindowsAt(clipLanePlan(stills), 2.3, () => null);
        expect(after.a.local).toBeCloseTo(2.3, 9);
    });
});

describe("windowStillFrame (the still side of a clip-cut window)", () => {
    const v = clip("v", 0, 2);
    const frame = (time: number, exact: boolean) => ({ source: {} as TexImageSource, width: 4, height: 2, time, exact });
    function snapshots(overrides: Partial<WindowSnapshots> = {}): WindowSnapshots {
        return { live: () => null, video: () => null, failed: () => false, ...overrides };
    }
    const decoderSide: ClipWindowSide = { clip: v, local: 2.1, live: false, decoder: true, mediaTime: 2.1, heldMediaTime: 2.2 };
    const heldSide: ClipWindowSide = { clip: v, local: 1.9, live: false, decoder: false, mediaTime: 1.9, heldMediaTime: 1.9 };

    it("paused, waits for the exact decoder frame or the held snapshot while they load", () => {
        expect(windowStillFrame(decoderSide, snapshots({ live: () => frame(2, false) }), false)).toBe("wait");
        const exact = frame(2.1, true);
        expect(windowStillFrame(decoderSide, snapshots({ live: () => exact }), false)).toBe(exact);
        expect(windowStillFrame(heldSide, snapshots(), false)).toBe("wait");
    });

    it("playing, never waits: a near decoder frame, else the held frame, else nothing", () => {
        const near = frame(2.0, false);
        expect(windowStillFrame(decoderSide, snapshots({ live: () => near }), true)).toBe(near);
        const held = { source: {} as TexImageSource, width: 4, height: 2 };
        expect(windowStillFrame(decoderSide, snapshots({ live: () => frame(1, false), video: () => held }), true)).toBe(held);
        expect(windowStillFrame(heldSide, snapshots(), true)).toBeNull();
    });

    it("paused, stops waiting once the media failed (error or timeout): the held frame if any, else no still", () => {
        const failed = snapshots({ failed: (url) => url === v.mediaUrl });
        expect(windowStillFrame(decoderSide, failed, false)).toBeNull();
        expect(windowStillFrame(heldSide, failed, false)).toBeNull();
        const held = { source: {} as TexImageSource, width: 4, height: 2 };
        expect(windowStillFrame(decoderSide, { ...failed, video: () => held }, false)).toBe(held);
    });
});
