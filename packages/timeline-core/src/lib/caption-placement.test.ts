import type { TimelineTrack } from "../model/timeline";
import { planCaptionPlacement } from "./caption-placement";
import { getTimelineTextStylePreset } from "./timeline-text-style";

const track = (type: TimelineTrack["type"], index: number, label = `${type}${index}`): TimelineTrack => ({ type, index, label, muted: false, locked: false, visible: true, volume: 1 });
const CUES = [
    { startTime: 0, endTime: 2, text: "Hello there" },
    { startTime: 2, endTime: 4.5, text: "general Kenobi" },
];

describe("planCaptionPlacement", () => {
    it("adds text track 1 labeled Captions when there is none", () => {
        const plan = planCaptionPlacement(CUES, [track("video", 1), track("audio", 1)]);
        expect(plan.track).toEqual({ type: "text", index: 1, label: "Captions", muted: false, locked: false, visible: true, volume: 1 });
        expect(plan.tracks.map((t) => `${t.type}${t.index}`)).toEqual(["video1", "audio1", "text1"]);
        expect(plan.inputs).toHaveLength(2);
        expect(plan.inputs[0]).toMatchObject({
            trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hello there",
            positionX: 0.5, positionY: 0.82, textStyle: getTimelineTextStylePreset("caption"),
        });
    });

    it("goes above existing text tracks and never reuses them", () => {
        const plan = planCaptionPlacement(CUES, [track("video", 1), track("text", 1), track("text", 3, "Captions")]);
        expect(plan.track).toMatchObject({ index: 4, label: "Captions 2" });
        expect(plan.inputs.every((input) => input.trackIndex === 4)).toBe(true);
    });

    it("uses the subtitle preset when asked", () => {
        const plan = planCaptionPlacement(CUES, [], { style: "subtitle" });
        expect(plan.inputs[0]).toMatchObject({ positionY: 0.88, textStyle: getTimelineTextStylePreset("subtitle") });
    });

    it("clamps overlapping cues and drops tiny ones", () => {
        const plan = planCaptionPlacement([
            { startTime: 0, endTime: 3, text: "a" },
            { startTime: 2, endTime: 4, text: "b" },
            { startTime: 4, endTime: 4.05, text: "c" },
        ], []);
        expect(plan.inputs.map((i) => [i.startTime, i.endTime, i.textContent])).toEqual([[0, 2, "a"], [2, 4, "b"]]);
        expect(planCaptionPlacement([], []).inputs).toEqual([]);
    });

    it("writes clip-local word timings (ms, inside the clip) on cues that have them", () => {
        const plan = planCaptionPlacement([
            { startTime: 1.2, endTime: 3, text: "Hello there", words: [{ start: 1.3, end: 1.9, text: "Hello" }, { start: 2.0004, end: 3.4, text: "there" }] },
            { startTime: 3, endTime: 4, text: "no words" },
            // Clamped by the next cue: the words stay inside the shorter clip.
            { startTime: 5, endTime: 7, text: "a b", words: [{ start: 4.9, end: 5.5, text: "a" }, { start: 5.6, end: 6.8, text: "b" }] },
            { startTime: 6, endTime: 6.5, text: "next", words: [] },
        ], []);
        expect(plan.inputs.map((i) => i.endTime)).toEqual([3, 4, 6, 6.5]);
        expect(JSON.parse(plan.inputs[0].captionWordsJson as string)).toEqual([{ start: 0.1, end: 0.7, text: "Hello" }, { start: 0.8, end: 1.8, text: "there" }]);
        expect(plan.inputs[1]).not.toHaveProperty("captionWordsJson");
        expect(JSON.parse(plan.inputs[2].captionWordsJson as string)).toEqual([{ start: 0, end: 0.5, text: "a" }, { start: 0.6, end: 1, text: "b" }]);
        expect(plan.inputs[3]).not.toHaveProperty("captionWordsJson");
    });
});

describe("caption style ids", () => {
    it("styles placed captions with a caption style in the same plan", async () => {
        const { planCaptionPlacement } = await import("./caption-placement");
        const plan = planCaptionPlacement([{ startTime: 0, endTime: 1, text: "Hi there" }], [], { style: "karaoke_highlight" });
        expect(JSON.parse(plan.inputs[0].textStyle as string).karaoke).toBe("highlight");
        const fallback = planCaptionPlacement([{ startTime: 0, endTime: 1, text: "Hi" }], [], { style: "nope" });
        expect(JSON.parse(fallback.inputs[0].textStyle as string).captionKind).toBe("caption");
    });
});
