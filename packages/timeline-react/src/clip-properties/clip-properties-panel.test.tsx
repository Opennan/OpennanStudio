import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ClipProperties } from "./index";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";
import { optimistic } from "@opennan/timeline-core";

it("edits the selected clip label through the controller", async () => {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" }, runtime.projectId, "c1");
    await seedTimeline(runtime, { tracks: [{ type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }], clips: [clip] });
    runtime.store.getState().selectClip("c1");
    renderWithTimeline(<ClipProperties />, { runtime });
    expect(screen.queryByText(/seedance/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "deleteClip" }));
    await waitFor(() => expect(runtime.recording.callsTo("deleteClips")[0].args).toEqual(["project-1", ["c1"]]));
});

it("speed presets and ramps run speed.set: the length follows the speed and a ramp becomes its curve", async () => {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" }, runtime.projectId, "v1");
    await seedTimeline(runtime, {
        tracks: [{ type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 }],
        clips: [
            { ...clip, keyframesJson: JSON.stringify({ keyframes: [{ time: 2, scale: 2 }] }) },
            optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 4, endTime: 6, mediaType: "video", mediaUrl: "b.mp4" }, runtime.projectId, "v2"),
        ],
    });
    runtime.store.getState().selectClip("v1");
    renderWithTimeline(<ClipProperties />, { runtime });
    const stored = () => runtime.store.getState().timelineData!.clips[0];
    fireEvent.click(screen.getByRole("button", { name: /^speed/ }));
    fireEvent.click(screen.getByRole("button", { name: "0.5×" }));
    // The longer clip pushes the next clip on the track, as speed.set does.
    await waitFor(() => expect(stored()).toMatchObject({ endTime: 8, playbackSpeed: 0.5 }));
    expect(runtime.store.getState().timelineData!.clips[1]).toMatchObject({ startTime: 8, endTime: 10 });
    fireEvent.click(screen.getByRole("button", { name: "2×" }));
    await waitFor(() => expect(stored()).toMatchObject({ endTime: 2, playbackSpeed: 2 }));
    expect(JSON.parse(stored().keyframesJson!).keyframes[0].time).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "rampHero" }));
    await waitFor(() => expect(JSON.parse(stored().speedCurveJson ?? "{}").id).toBe("hero"));
    expect(stored().playbackSpeed).toBe(1);
    expect(runtime.recording.callsTo("updateClips").length).toBe(3);
});
