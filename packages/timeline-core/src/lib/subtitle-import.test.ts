// Tests for SRT/VTT subtitle parsing and timeline clip-plan generation.
import { describe, expect, it } from "vitest";

import { getTimelineSubtitleImportInputs, parseSubtitleFile, splitSubtitleCuesIntoWords } from "./subtitle-import";

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line
continues here

`;

const VTT = `WEBVTT

NOTE this is a comment

00:01.000 --> 00:03.500 align:middle line:90%
<v Speaker>Hello <b>world</b></v>

00:00:04.000 --> 00:00:06.000
Second cue
`;

describe("parseSubtitleFile", () => {
  it("parses SRT cues with comma timestamps and multi-line text", () => {
    const cues = parseSubtitleFile(SRT);
    expect(cues).toEqual([
      { startTime: 1, endTime: 3.5, text: "Hello world" },
      { startTime: 4, endTime: 6, text: "Second line\ncontinues here" },
    ]);
  });

  it("parses VTT with header, notes, MM:SS timestamps, cue settings, and tags", () => {
    const cues = parseSubtitleFile(VTT);
    expect(cues).toEqual([
      { startTime: 1, endTime: 3.5, text: "Hello world" },
      { startTime: 4, endTime: 6, text: "Second cue" },
    ]);
  });

  it("handles CRLF and BOM", () => {
    const cues = parseSubtitleFile("﻿" + SRT.replace(/\n/g, "\r\n"));
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Hello world");
  });

  it("drops invalid, reversed, and empty cues and sorts by start time", () => {
    const cues = parseSubtitleFile(`1
00:00:10,000 --> 00:00:12,000
Later

2
00:00:05,000 --> 00:00:04,000
Reversed

3
bogus --> 00:00:02,000
Bad timing

4
00:00:01,000 --> 00:00:02,000
Earlier
`);
    expect(cues.map((cue) => cue.text)).toEqual(["Earlier", "Later"]);
  });

  it("strips SRT styling braces like {\\an8}", () => {
    const cues = parseSubtitleFile(`1
00:00:01,000 --> 00:00:02,000
{\\an8}Top text
`);
    expect(cues[0].text).toBe("Top text");
  });
});

describe("splitSubtitleCuesIntoWords", () => {
  it("splits a cue into per-word cues covering the exact cue window", () => {
    const words = splitSubtitleCuesIntoWords([{ startTime: 1, endTime: 3, text: "go far away" }]);
    expect(words.map((cue) => cue.text)).toEqual(["go", "far", "away"]);
    expect(words[0].startTime).toBe(1);
    expect(words[words.length - 1].endTime).toBe(3);
    // Contiguous: each word starts where the previous ends.
    expect(words[1].startTime).toBe(words[0].endTime);
    expect(words[2].startTime).toBe(words[1].endTime);
    // Longer words get proportionally more time.
    expect(words[2].endTime - words[2].startTime).toBeGreaterThan(words[0].endTime - words[0].startTime);
  });

  it("passes through single-word and zero-duration cues unchanged", () => {
    const cues = [
      { startTime: 0, endTime: 1, text: "Hello" },
      { startTime: 2, endTime: 2, text: "a b" },
    ];
    expect(splitSubtitleCuesIntoWords(cues)).toEqual(cues);
  });
});

describe("getTimelineSubtitleImportInputs", () => {
  const tracks = [
    { type: "text", index: 2, locked: true },
    { type: "text", index: 3 },
    { type: "video", index: 1 },
  ];
  const cues = [
    { startTime: 1, endTime: 5, text: "One" },
    { startTime: 4, endTime: 6, text: "Two" },
    { startTime: 6, endTime: 6.05, text: "Too short" },
  ];

  it("targets the first editable text track and applies the subtitle preset", () => {
    const inputs = getTimelineSubtitleImportInputs(cues, tracks, "subtitle");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].trackIndex).toBe(3);
    expect(inputs[0].trackType).toBe("text");
    expect(inputs[0].positionY).toBe(0.88);
    expect(String(inputs[0].textStyle)).toContain("\"captionKind\":\"subtitle\"");
  });

  it("clamps overlapping cues so consecutive clips never overlap", () => {
    const inputs = getTimelineSubtitleImportInputs(cues, tracks);
    expect(inputs[0].endTime).toBe(4); // clamped to next cue's start
    expect(inputs[1].startTime).toBe(4);
    expect(inputs[1].endTime).toBe(6);
  });

  it("drops cues shorter than the minimum clip duration", () => {
    const inputs = getTimelineSubtitleImportInputs(cues, tracks);
    expect(inputs.some((input) => input.textContent === "Too short")).toBe(false);
  });

  it("merges style overrides onto the preset for karaoke-style imports", () => {
    const inputs = getTimelineSubtitleImportInputs(
      [{ startTime: 0, endTime: 2, text: "Hi" }],
      [],
      "subtitle",
      { bgColor: "#FF5700", fontWeight: "800" },
    );
    const style = JSON.parse(String(inputs[0].textStyle));
    expect(style.bgColor).toBe("#FF5700");
    expect(style.fontWeight).toBe("800");
    expect(style.captionKind).toBe("subtitle");
  });

  it("falls back to track index 1 when no text track exists and supports caption kind", () => {
    const inputs = getTimelineSubtitleImportInputs([{ startTime: 0, endTime: 2, text: "Hi" }], [], "caption");
    expect(inputs[0].trackIndex).toBe(1);
    expect(inputs[0].positionY).toBe(0.82);
    expect(String(inputs[0].textStyle)).toContain("\"captionKind\":\"caption\"");
  });

  it("trims cues around clips already on the target track instead of overlapping", () => {
    const existing = [
      { trackType: "text", trackIndex: 3, startTime: 2, endTime: 3 },
      { trackType: "text", trackIndex: 5, startTime: 0, endTime: 100 }, // other track — ignored
    ];
    const inputs = getTimelineSubtitleImportInputs(
      [{ startTime: 1, endTime: 5, text: "Split me" }, { startTime: 5, endTime: 6, text: "Free" }],
      tracks,
      "subtitle",
      null,
      existing,
    );
    // The 1–5 cue is carved around the 2–3 clip into two synced spans.
    expect(inputs.map((i) => [i.startTime, i.endTime])).toEqual([[1, 2], [3, 5], [5, 6]]);
    expect(inputs[0].textContent).toBe("Split me");
    expect(inputs[1].textContent).toBe("Split me");
  });

  it("drops cues fully covered by existing clips", () => {
    const inputs = getTimelineSubtitleImportInputs(
      [{ startTime: 1, endTime: 2, text: "Covered" }],
      tracks,
      "subtitle",
      null,
      [{ trackType: "text", trackIndex: 3, startTime: 0, endTime: 4 }],
    );
    expect(inputs).toHaveLength(0);
  });

  it("writes word timings only on clips that keep their whole cue", () => {
    const words = [{ start: 1.1, end: 1.5, text: "Split" }, { start: 3.5, end: 4, text: "me" }];
    const inputs = getTimelineSubtitleImportInputs(
      [{ startTime: 1, endTime: 5, text: "Split me", words }, { startTime: 5, endTime: 6, text: "Whole", words: [{ start: 5.25, end: 5.75, text: "Whole" }] }],
      tracks,
      "subtitle",
      null,
      [{ trackType: "text", trackIndex: 3, startTime: 2, endTime: 3 }],
    );
    // A carved cue's halves both hold the whole text: karaoke estimates their timings instead.
    expect(inputs.map((i) => i.captionWordsJson)).toEqual([undefined, undefined, JSON.stringify([{ start: 0.25, end: 0.75, text: "Whole" }])]);
    expect(Object.keys(inputs[0])).not.toContain("captionWordsJson");
  });

  it("never writes word timings for SRT/VTT imports", () => {
    const cues = parseSubtitleFile("1\n00:00:01,000 --> 00:00:02,000\nHello world\n");
    for (const input of getTimelineSubtitleImportInputs(cues, tracks)) expect(input).not.toHaveProperty("captionWordsJson");
  });
});

