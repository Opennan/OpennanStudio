import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { TimelineController, createEditorStore } from "@opennan/timeline-core";
import { TimelineProvider } from "../provider/timeline-provider";
import { createTimelineTestRuntime, seedTimeline } from "../test-utils/render-with-timeline";
import {
  createTimelineCommandAdapters, useSceneFeatureAdapters, useSceneOverrideAdapters, useTimelineCommandAdapters, useTimelineDataProps,
} from "./adapters";

const track = { type: "video" as const, index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };

async function setup() {
  const runtime = createTimelineTestRuntime({ store: createEditorStore() });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(TimelineProvider, {
    backend: runtime.backend, projectId: runtime.projectId, media: { resolveMediaUrl: (u: string) => u }, store: runtime.store,
    onToast: runtime.onToast, autoLoad: false, children,
  });
  await seedTimeline(runtime, { tracks: [track], scenes: [] });
  const { result } = renderHook(() => ({
    data: useTimelineDataProps(),
    clips: useTimelineCommandAdapters(),
    overrides: useSceneOverrideAdapters(),
    features: useSceneFeatureAdapters(),
  }), { wrapper });
  return { runtime, result };
}

describe("timeline adapters", () => {
  it("create/update/delete adapters keep the NleTimelineProps signatures", async () => {
    const { runtime, result } = await setup();
    let created: Awaited<ReturnType<typeof result.current.clips.onCreateClip>> = null;
    await act(async () => {
      created = await result.current.clips.onCreateClip({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 });
    });
    expect(created!.id).toBe("srv-1");
    await act(async () => {
      expect(await result.current.clips.onUpdateClip("srv-1", { opacity: 0.5 })).toMatchObject({ id: "srv-1", opacity: 0.5 });
      expect(await result.current.clips.onDeleteClip("srv-1")).toBe(true);
    });
    expect(runtime.recording.callsTo("updateClips")[0].args[1]).toEqual([{ clipId: "srv-1", opacity: 0.5, startTime: 0, endTime: 2 }]);
    expect(runtime.onToast).not.toHaveBeenCalled();
  });

  it("onStartCreateClip returns the temp id synchronously", async () => {
    const { result } = await setup();
    let started: ReturnType<typeof result.current.clips.onStartCreateClip> | null = null;
    act(() => {
      started = result.current.clips.onStartCreateClip({ trackType: "effect", trackIndex: 1, startTime: 0, endTime: 3 });
    });
    expect(started!.tempId).toMatch(/^temp-/);
    await act(async () => {
      expect((await started!.settled)?.id).toBe("srv-1");
    });
  });

  it("onUpdateTracks sends removed tracks explicitly", async () => {
    const { runtime, result } = await setup();
    await act(async () => {
      await result.current.clips.onUpdateTracks([]);
    });
    expect(runtime.recording.callsTo("updateTracks")[0].args).toEqual(["project-1", [], [{ type: "video", index: 1 }]]);
  });

  it("data props read the store and onSelectScene seeks to the scene start", async () => {
    const { runtime, result } = await setup();
    await act(async () => {
      await seedTimeline(runtime, { tracks: [track], scenes: [{
        id: "s1", order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:05", startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, duration: 5, timelinePositionSeconds: 7, trackIndex: 1,
      }] });
    });
    await waitFor(() => expect(result.current.data.scenes.map((s) => s.id)).toEqual(["s1"]));
    act(() => result.current.data.onSelectScene("s1"));
    expect(runtime.store.getState().selectedSceneId).toBe("s1");
    expect(runtime.store.getState().seekRequest).toBe(7);
  });

  it("scene override adapters write the store", async () => {
    const { runtime, result } = await setup();
    act(() => result.current.overrides.onSceneOverridesUpdate(new Map([["s1", 3]]), "s1", 2));
    expect(runtime.store.getState().scenePositionOverrides.get("s1")).toBe(3);
    expect(runtime.store.getState().sceneTrackOverrides.get("s1")).toBe(2);
  });

  it("onSetSceneTransition clamps to half the scene and needs an adjacent cut", async () => {
    const { runtime, result } = await setup();
    const base = { order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:04", startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, duration: 4, trackIndex: 1 };
    await act(async () => {
      await seedTimeline(runtime, { tracks: [track], scenes: [{ ...base, id: "a", timelinePositionSeconds: 0.001 }, { ...base, id: "b", order: 1, timelinePositionSeconds: 4.001 }] });
    });
    await act(async () => {
      await result.current.features.onSetSceneTransition("a", "crossfade", 9);
      await result.current.features.onSetSceneTransition("b", "crossfade", 1);
    });
    const calls = runtime.recording.callsTo("updateScene");
    expect(calls).toHaveLength(1);
    // "crossfade" normalizes to "cross_dissolve" (core lib/timeline-editing-navigation.ts:584).
    expect(calls[0].args).toEqual(["project-1", "a", { visualTransition: "cross_dissolve", visualTransitionDuration: 2 }]);
  });

  it("createTimelineCommandAdapters drives the controller without React", async () => {
    const runtime = createTimelineTestRuntime({ store: createEditorStore() });
    await seedTimeline(runtime, { tracks: [track], scenes: [] });
    const controller = new TimelineController({ backend: runtime.backend, store: runtime.store, projectId: runtime.projectId });
    const adapters = createTimelineCommandAdapters(controller, runtime.store);
    const [created] = await adapters.onCreateClips([{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 }]);
    expect(created?.id).toBe("srv-1");
    expect((await adapters.onSplitClips(["srv-1"], 1)).map((clip) => clip?.id)).toEqual(["srv-2"]);
    await adapters.onUndo();
    expect(runtime.store.getState().timelineData?.clips.map((clip) => [clip.id, clip.endTime])).toEqual([["srv-1", 2]]);
  });
});
