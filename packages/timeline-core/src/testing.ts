// Test utilities published as "@opennan/timeline-core/testing" (needs vitest).
// describeTimelineBackendContract: the shared TimelineBackend suite (spec §11).
// createRecordingBackend: wraps a backend to record calls, fail, or hold them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimelineBackend } from "./backend/types";

export interface BackendContractHarness {
    backend: TimelineBackend;
    projectId: string;
    cleanup?(): Promise<void> | void;
}

const BAD_ID = /^(temp-|optimistic-)/;

export function describeTimelineBackendContract(name: string, setup: () => Promise<BackendContractHarness>): void {
    describe(`TimelineBackend contract: ${name}`, () => {
        let h: BackendContractHarness;
        const textClip = (overrides: Record<string, unknown> = {}) => ({
            trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "text", textContent: "Hello", ...overrides,
        });
        const videoScene = { afterOrder: -1, cardType: "source_clip", videoUrl: "https://cdn.test/a.mp4", sourceVideoUrl: "https://cdn.test/a.mp4", duration: 6, timelinePositionSeconds: 0.001, trackIndex: 1, caption: "A" };

        beforeEach(async () => {
            h = await setup();
        });
        afterEach(async () => {
            await h.cleanup?.();
        });

        it("loads a fresh project with V1/A1 and nothing else", async () => {
            const timeline = await h.backend.loadTimeline(h.projectId);
            expect(timeline.tracks.some((t) => t.type === "video" && t.index === 1)).toBe(true);
            expect(timeline.tracks.some((t) => t.type === "audio" && t.index === 1)).toBe(true);
            expect(timeline.clips).toEqual([]);
            expect(await h.backend.loadScenes(h.projectId)).toEqual([]);
            expect((await h.backend.loadProject(h.projectId)).id).toBe(h.projectId);
        });

        it("creates clips with server ids that persist", async () => {
            const created = await h.backend.createClips(h.projectId, [textClip(), textClip({ startTime: 4, endTime: 6 })]);
            expect(created).toHaveLength(2);
            for (const clip of created) expect(BAD_ID.test(clip.id)).toBe(false);
            expect((await h.backend.loadTimeline(h.projectId)).clips.map((c) => c.id)).toEqual(created.map((c) => c.id));
        });

        it("updates clip fields without dropping others", async () => {
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            await h.backend.updateClips(h.projectId, [{ clipId: clip.id, positionX: 0.2, startTime: 1, endTime: 5 }]);
            const stored = (await h.backend.loadTimeline(h.projectId)).clips[0];
            expect(stored).toMatchObject({ id: clip.id, positionX: 0.2, startTime: 1, endTime: 5, textContent: "Hello" });
        });

        it("splits clips into the original left half and a new right half", async () => {
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            const result = await h.backend.splitClips(h.projectId, [clip.id], 1.5);
            expect(result.map((c) => [c.startTime, c.endTime])).toEqual([[0, 1.5], [1.5, 4]]);
            expect(result[0].id).toBe(clip.id);
            expect(BAD_ID.test(result[1].id)).toBe(false);
        });

        it("deletes clips", async () => {
            const [a, b] = await h.backend.createClips(h.projectId, [textClip(), textClip({ startTime: 5, endTime: 6 })]);
            await h.backend.deleteClips(h.projectId, [a.id]);
            expect((await h.backend.loadTimeline(h.projectId)).clips.map((c) => c.id)).toEqual([b.id]);
        });

        it("commits a clip command in one call", async () => {
            const [keep, drop] = await h.backend.createClips(h.projectId, [textClip(), textClip({ startTime: 5, endTime: 6 })]);
            const result = await h.backend.commitCommand(h.projectId, {
                creates: [textClip({ startTime: 7, endTime: 8 })],
                updates: [{ clipId: keep.id, startTime: 0, endTime: 2 }],
                deleteIds: [drop.id],
            });
            expect(result.created).toHaveLength(1);
            expect(result.updated.map((c) => c.endTime)).toEqual([2]);
            const ids = (await h.backend.loadTimeline(h.projectId)).clips.map((c) => c.id).sort();
            expect(ids).toEqual([keep.id, result.created[0].id].sort());
        });

        it("cascades clip deletion for explicitly removed tracks", async () => {
            const timeline = await h.backend.loadTimeline(h.projectId);
            const text2 = { type: "text" as const, index: 2, label: "T2", muted: false, locked: false, visible: true, volume: 1 };
            await h.backend.updateTracks(h.projectId, [...timeline.tracks, text2]);
            await h.backend.createClips(h.projectId, [textClip({ trackIndex: 2 })]);
            await h.backend.updateTracks(h.projectId, timeline.tracks, [{ type: "text", index: 2 }]);
            const after = await h.backend.loadTimeline(h.projectId);
            expect(after.clips).toEqual([]);
            expect(after.tracks.some((t) => t.type === "text" && t.index === 2)).toBe(false);
        });

        it("undoes and redoes by steps", async () => {
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            await h.backend.updateClips(h.projectId, [{ clipId: clip.id, positionX: 0.9, startTime: 0, endTime: 4 }]);
            expect((await h.backend.undo(h.projectId, 1)).clips[0].positionX).toBe(0.5);
            expect((await h.backend.undo(h.projectId, 1)).clips).toEqual([]);
            const redone = await h.backend.redo(h.projectId, 2);
            expect(redone.clips[0].positionX).toBe(0.9);
            expect(redone.canUndo).toBe(true);
        });

        it("counts every write call as one undo step, even one that changed nothing", async () => {
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            await h.backend.updateClips(h.projectId, [{ clipId: clip.id, positionX: 0.9, startTime: 0, endTime: 4 }]);
            await h.backend.updateClips(h.projectId, [{ clipId: clip.id, positionX: 0.9, startTime: 0, endTime: 4 }]);
            expect((await h.backend.undo(h.projectId, 2)).clips[0].positionX).toBe(0.5);
        });

        it("keeps withoutHistory() writes out of the undo steps when supported", async () => {
            if (!h.backend.withoutHistory) return;
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            await h.backend.updateClips(h.projectId, [{ clipId: clip.id, positionX: 0.9, startTime: 0, endTime: 4 }]);
            await h.backend.withoutHistory().updateClips(h.projectId, [{ clipId: clip.id, opacity: 0.3, startTime: 0, endTime: 4 }]);
            expect((await h.backend.loadTimeline(h.projectId)).clips[0].opacity).toBe(0.3);
            expect((await h.backend.undo(h.projectId, 1)).clips[0].positionX).toBe(0.5);
        });

        it("adds, moves, updates, trims, and re-times scenes", async () => {
            const scene = await h.backend.addScene(h.projectId, videoScene);
            expect(BAD_ID.test(scene.id)).toBe(false);
            const [moved] = await h.backend.moveScenes(h.projectId, [{ sceneId: scene.id, timelinePositionSeconds: 3, trackIndex: 2 }]);
            expect(moved).toMatchObject({ timelinePositionSeconds: 3, trackIndex: 2 });
            expect(await h.backend.updateScene(h.projectId, scene.id, { caption: "B" })).toMatchObject({ caption: "B" });
            expect(await h.backend.trimScene(h.projectId, { sceneId: scene.id, duration: 2, cardConfig: '{"timelineTrimStart":1,"timelineTrimEnd":3}' }))
                .toMatchObject({ duration: 2, cardConfig: '{"timelineTrimStart":1,"timelineTrimEnd":3}' });
            expect(await h.backend.setSceneDuration(h.projectId, scene.id, 4)).toMatchObject({ duration: 4 });
        });

        it("retimes shots proportionally when a scene's duration changes", async () => {
            // The server retimes generative scenes' shots (nle-timeline.tsx:1498-1500) with the
            // rule the client predicts optimistically (:1425-1444).
            const scene = await h.backend.addScene(h.projectId, videoScene);
            await h.backend.updateScene(h.projectId, scene.id, { shotBreakdown: JSON.stringify([{ duration: 2, d: "a" }, { duration: 4, d: "b" }]) });
            const retimed = await h.backend.setSceneDuration(h.projectId, scene.id, 3);
            expect(retimed.duration).toBe(3);
            expect(JSON.parse(retimed.shotBreakdown as string)).toEqual([{ duration: 1, d: "a" }, { duration: 2, d: "b" }]);
        });

        it("splits a source-clip scene at a time", async () => {
            const scene = await h.backend.addScene(h.projectId, videoScene);
            const [first, second] = await h.backend.splitScene(h.projectId, scene.id, 2);
            expect(first.id).toBe(scene.id);
            expect(second.id).not.toBe(scene.id);
            expect(first.duration).toBeCloseTo(2, 2);
            expect(second.duration).toBeCloseTo(4, 2);
            expect(await h.backend.loadScenes(h.projectId)).toHaveLength(2);
        });

        it("duplicates, reorders, and deletes scenes", async () => {
            const a = await h.backend.addScene(h.projectId, videoScene);
            const copy = await h.backend.duplicateScene(h.projectId, a.id);
            expect(copy.id).not.toBe(a.id);
            expect(copy.caption).toBe(a.caption);
            const reordered = await h.backend.reorderScenes(h.projectId, [copy.id, a.id]);
            expect(reordered.find((s) => s.id === copy.id)?.order).toBe(0);
            await h.backend.deleteScene(h.projectId, a.id);
            expect((await h.backend.loadScenes(h.projectId)).map((s) => s.id)).toEqual([copy.id]);
        });

        it("keeps scene orders unique and lists scenes in their new order after a reorder", async () => {
            // Layout and export walk the scene list in order (scene-position.ts getSceneTimelineStart),
            // and OpenNan's server lists scenes by `order`: a reorder must reach the list.
            const a = await h.backend.addScene(h.projectId, { afterOrder: -1, duration: 4 });
            const b = await h.backend.addScene(h.projectId, { afterOrder: 0, duration: 6 });
            const middle = await h.backend.addScene(h.projectId, { afterOrder: 0, duration: 2 });
            const copy = await h.backend.duplicateScene(h.projectId, b.id);
            const listed = await h.backend.loadScenes(h.projectId);
            expect(new Set(listed.map((s) => s.order)).size).toBe(4);
            const byOrder = [...listed].sort((x, y) => x.order - y.order).map((s) => s.id);
            expect(byOrder).toEqual([a.id, middle.id, b.id, copy.id]);
            const reversed = [...byOrder].reverse();
            await h.backend.reorderScenes(h.projectId, reversed);
            expect((await h.backend.loadScenes(h.projectId)).map((s) => s.id)).toEqual(reversed);
        });

        it("reorders and deletes shots when supported", async () => {
            if (!h.backend.reorderShots || !h.backend.deleteShot) return;
            const scene = await h.backend.addScene(h.projectId, videoScene);
            await h.backend.updateScene(h.projectId, scene.id, { shotBreakdown: JSON.stringify([{ duration: 1, d: "a" }, { duration: 2, d: "b" }]) });
            const reordered = await h.backend.reorderShots(h.projectId, scene.id, [1, 0]);
            expect(JSON.parse(reordered.shotBreakdown as string).map((s: { d: string }) => s.d)).toEqual(["b", "a"]);
            const trimmed = await h.backend.deleteShot(h.projectId, scene.id, 0);
            expect(JSON.parse(trimmed.shotBreakdown as string).map((s: { d: string }) => s.d)).toEqual(["a"]);
        });

        it("attaches clip effects when supported", async () => {
            if (!h.backend.addClipEffect) return;
            const [clip] = await h.backend.createClips(h.projectId, [textClip()]);
            const effects = await h.backend.addClipEffect(h.projectId, { clipId: clip.id }, "glitch");
            expect(effects.map((e) => e.effectId)).toEqual(["glitch"]);
            expect((await h.backend.loadTimeline(h.projectId)).clips[0].effects?.map((e) => e.effectId)).toEqual(["glitch"]);
        });

        it("updates project settings", async () => {
            expect(await h.backend.updateProject(h.projectId, { aspectRatio: "9:16", musicVolume: 0.5 }))
                .toMatchObject({ id: h.projectId, aspectRatio: "9:16", musicVolume: 0.5 });
        });

        it("does not count project settings as an undo step", async () => {
            await h.backend.createClips(h.projectId, [textClip()]);
            await h.backend.updateProject(h.projectId, { name: "Renamed" });
            expect((await h.backend.undo(h.projectId, 1)).clips).toEqual([]);
            expect((await h.backend.loadProject(h.projectId)).name).toBe("Renamed");
        });

        it("uploads files and reports their size and type", async () => {
            const media = await h.backend.uploadFile(h.projectId, new Blob([new Uint8Array(4)], { type: "audio/wav" }), "audio");
            expect(media.url.length).toBeGreaterThan(0);
            expect(media).toMatchObject({ size: 4, mimeType: "audio/wav" });
        });
    });
}

export interface RecordedCall {
    method: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into recorded arguments
    args: any[];
    /** Set when the call went through backend.withoutHistory(). */
    silent?: true;
}

export interface RecordingBackend {
    backend: TimelineBackend;
    calls: RecordedCall[];
    callsTo(method: string): RecordedCall[];
    failNext(method: string, error?: Error): void;
    /** The next call to `method` waits until the returned function is called. */
    hold(method: string): () => void;
    reset(): void;
}

const SYNC_METHODS = new Set(["subscribe", "resolveLocalUrl"]);

export function createRecordingBackend(inner: TimelineBackend): RecordingBackend {
    const calls: RecordedCall[] = [];
    const failures = new Map<string, Error[]>();
    const holds = new Map<string, Array<Promise<void>>>();
    // The withoutHistory() view is wrapped too, so silent writes are recorded (silent: true).
    const wrap = (wrapped: TimelineBackend, silent: boolean): TimelineBackend => new Proxy(wrapped, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "withoutHistory" && typeof value === "function") {
                return () => wrap((value as () => TimelineBackend).call(target), true);
            }
            if (typeof value !== "function" || typeof prop !== "string" || SYNC_METHODS.has(prop)) {
                return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...args: unknown[]) => {
                calls.push(silent ? { method: prop, args, silent: true } : { method: prop, args });
                const gate = holds.get(prop)?.shift();
                if (gate) await gate;
                const failure = failures.get(prop)?.shift();
                if (failure) throw failure;
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    }) as TimelineBackend;
    const backend = wrap(inner, false);
    return {
        backend,
        calls,
        callsTo: (method) => calls.filter((call) => call.method === method),
        failNext(method, error = new Error(`${method} failed`)) {
            failures.set(method, [...(failures.get(method) ?? []), error]);
        },
        hold(method) {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            holds.set(method, [...(holds.get(method) ?? []), gate]);
            return release;
        },
        reset() {
            calls.length = 0;
            failures.clear();
            holds.clear();
        },
    };
}
