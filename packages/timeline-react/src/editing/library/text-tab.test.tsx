import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { serializeAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import { captionStyleById } from "@opennan/timeline-core/text/captions";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { TextTab } from "./simple-tabs";
import { matchingCaptionStyleId, matchingTemplateId, planTextClipPlacement, templateClipInput } from "./text-library";

const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1, ...patch });
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const captionStyle = JSON.stringify({ captionKind: "caption", textClipKind: "caption", fontSize: 40 });

async function setup(clips: TimelineClip[] = [], tracks: TimelineTrack[] = [track("video", 1), track("audio", 1)]) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks, clips });
    renderWithTimeline(<TextTab />, { runtime });
    const controller = getActiveRuntime()!.controller;
    const execute = vi.spyOn(controller, "execute");
    const commands = () => execute.mock.calls.map((c) => c[0]);
    return { runtime, controller, commands };
}

describe("text library logic", () => {
    it("places new text at the playhead on the first free text track, else on a new track", () => {
        const tracks = [track("video", 1), track("audio", 1), track("text", 1), track("text", 2, { locked: true })];
        const busy = [clip("a", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4 })];
        expect(planTextClipPlacement(tracks, [], 2)).toEqual({ tracks: null, trackIndex: 1, startTime: 2, endTime: 7 });
        const placed = planTextClipPlacement(tracks, busy, 2);
        expect(placed.trackIndex).toBe(3);
        expect(placed.tracks?.map((t) => `${t.type}${t.index}`)).toEqual(["video1", "audio1", "text1", "text2", "text3"]);
        expect(planTextClipPlacement(tracks, busy, 4).trackIndex).toBe(1);
    });

    it("builds one create input with the template's style and animation", () => {
        const input = templateClipInput("neon_pink", { tracks: null, trackIndex: 1, startTime: 1, endTime: 6 })!;
        const tpl = textTemplateById("neon_pink")!;
        expect(input).toMatchObject({ trackType: "text", textContent: tpl.defaultText, textStyle: JSON.stringify(tpl.style), animationJson: serializeAnimationSpec(tpl.animation!) });
        expect(templateClipInput("nope", { tracks: null, trackIndex: 1, startTime: 0, endTime: 1 })).toBeNull();
    });

    it("recognises an applied template or caption style (layout keys ignored, edits break the match)", () => {
        const tpl = textTemplateById("tiktok_bold")!;
        expect(matchingTemplateId(JSON.stringify({ ...tpl.style, captionPosition: "top" }))).toBe("tiktok_bold");
        expect(matchingTemplateId(JSON.stringify({ ...tpl.style, fontSize: 10 }))).toBeNull();
        expect(matchingTemplateId(JSON.stringify({ ...tpl.style, glowSize: 4 }))).toBeNull();
        expect(matchingTemplateId(null)).toBeNull();
        expect(matchingCaptionStyleId(JSON.stringify(captionStyleById("karaoke_box")!.style))).toBe("karaoke_box");
    });
});

describe("TextTab", () => {
    it("shows 20 templates, 8 caption styles, and 12 fonts; search and chips filter them", async () => {
        await setup();
        expect(screen.getAllByTestId(/^text-template-/)).toHaveLength(20);
        expect(screen.getAllByTestId(/^caption-style-/)).toHaveLength(8);
        expect(screen.getAllByTestId(/^text-font-/)).toHaveLength(12);
        // Karaoke styles are marked word by word.
        expect(screen.getByTestId("caption-style-karaoke_box").textContent).toContain("cap_wordByWord");
        fireEvent.click(screen.getByRole("button", { name: "txt_cat_neon" }));
        expect(screen.getAllByTestId(/^text-template-/).map((el) => el.dataset.testid)).toEqual(["text-template-neon_pink", "text-template-neon_cyan", "text-template-soft_glow"]);
        expect(screen.queryAllByTestId(/^caption-style-/)).toHaveLength(0);
        expect(screen.queryAllByTestId(/^text-font-/)).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "txt_cat_captions" }));
        expect(screen.queryAllByTestId(/^text-template-/)).toHaveLength(0);
        expect(screen.getAllByTestId(/^caption-style-/)).toHaveLength(8);
        fireEvent.click(screen.getByRole("button", { name: "categoryAll" }));
        // keyEcho names cards by key: "txt_tpl_gradient_sunset" …
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "gradient" } });
        expect(screen.getAllByTestId(/^text-template-/).map((el) => el.dataset.testid)).toEqual(["text-template-gradient_sunset", "text-template-gradient_ocean"]);
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bebas" } });
        expect(screen.getAllByTestId(/^text-template-/).map((el) => el.dataset.testid)).toEqual(["text-template-poster_bebas"]);
        expect(screen.getAllByTestId(/^text-font-/).map((el) => el.dataset.testid)).toEqual(["text-font-bebas_neue"]);
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
        expect(screen.getByText("noResults")).toBeTruthy();
    });

    it("clicking a template adds its text clip at the playhead in one clip.create (style + animation, new track) and selects it", async () => {
        const { runtime, commands } = await setup();
        act(() => runtime.store.getState().setCurrentTime(1.5));
        await act(async () => fireEvent.click(screen.getByTestId("text-template-neon_pink")));
        const tpl = textTemplateById("neon_pink")!;
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.filter((c) => c.trackType === "text")).toHaveLength(1));
        expect(commands().map((c) => c.type)).toEqual(["clip.create"]);
        const create = commands()[0] as Extract<ReturnType<typeof commands>[number], { type: "clip.create" }>;
        expect(create.input).toMatchObject({ trackType: "text", trackIndex: 1, startTime: 1.5, endTime: 6.5, textContent: tpl.defaultText, textStyle: JSON.stringify(tpl.style), animationJson: serializeAnimationSpec(tpl.animation!) });
        expect(create.tracks?.some((t) => t.type === "text" && t.index === 1)).toBe(true);
        const created = runtime.store.getState().timelineData!.clips.find((c) => c.trackType === "text")!;
        expect(created.animationJson).toBe(serializeAnimationSpec(tpl.animation!));
        expect(runtime.store.getState().timelineData!.tracks.some((t) => t.type === "text")).toBe(true);
        await waitFor(() => expect(runtime.store.getState().selectedClipIds.has(created.id)).toBe(true));
        expect(runtime.recording.callsTo("createClips")).toHaveLength(1);
    });

    it("Add text adds the plain template on the existing free text track", async () => {
        const { runtime, commands } = await setup([], [track("video", 1), track("audio", 1), track("text", 1)]);
        await act(async () => fireEvent.click(screen.getByTestId("text-add")));
        await waitFor(() => expect(commands().map((c) => c.type)).toEqual(["clip.create"]));
        const create = commands()[0] as Extract<ReturnType<typeof commands>[number], { type: "clip.create" }>;
        expect(create.tracks).toBeUndefined();
        expect(create.input).toMatchObject({ trackIndex: 1, textStyle: JSON.stringify(textTemplateById("plain")!.style) });
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips).toHaveLength(1));
    });

    it("with a text clip selected, a template click applies it (text.template.apply) and the card shows applied", async () => {
        const { runtime, commands } = await setup(
            [clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hi" })],
            [track("video", 1), track("text", 1)],
        );
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["t1"])));
        await act(async () => fireEvent.click(screen.getByTestId("text-template-comic_bangers")));
        await waitFor(() => expect(commands()).toEqual([{ type: "text.template.apply", clipIds: ["t1"], templateId: "comic_bangers" }]));
        await waitFor(() => expect(screen.getByTestId("text-template-comic_bangers").dataset.applied).toBe("true"));
        const updated = runtime.store.getState().timelineData!.clips[0];
        expect(updated.animationJson).toBe(serializeAnimationSpec(textTemplateById("comic_bangers")!.animation!));
        expect(runtime.store.getState().timelineData!.clips).toHaveLength(1);
    });

    it("a caption style applies to every caption, or only to the selected captions", async () => {
        const { runtime, commands } = await setup(
            [
                clip("c1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "one", textStyle: captionStyle }),
                clip("c2", { trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "two", textStyle: captionStyle }),
                clip("t", { trackType: "text", trackIndex: 2, startTime: 0, endTime: 4, textContent: "title" }),
            ],
            [track("video", 1), track("text", 1), track("text", 2)],
        );
        await act(async () => fireEvent.click(screen.getByTestId("caption-style-neon")));
        await waitFor(() => expect(commands()).toEqual([{ type: "caption.style.apply", styleId: "neon" }]));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.filter((c) => matchingCaptionStyleId(c.textStyle) === "neon").map((c) => c.id).sort()).toEqual(["c1", "c2"]));
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["c2"])));
        await waitFor(() => expect(screen.getByTestId("caption-style-neon").dataset.applied).toBe("true"));
        await act(async () => fireEvent.click(screen.getByTestId("caption-style-karaoke_highlight")));
        await waitFor(() => expect(commands()[1]).toEqual({ type: "caption.style.apply", clipIds: ["c2"], styleId: "karaoke_highlight" }));
    });

    it("explains when there are no captions to style", async () => {
        const { runtime, commands } = await setup();
        await act(async () => fireEvent.click(screen.getByTestId("caption-style-pill")));
        await waitFor(() => expect(runtime.onToast).toHaveBeenCalledWith(expect.objectContaining({ message: "cap_none" })));
        expect(commands()).toEqual([]);
    });

    it("a font sets the selected text's family with the nearest bundled weight", async () => {
        const { commands } = await setup(
            [clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hi", textStyle: JSON.stringify({ fontWeight: "900" }) })],
            [track("video", 1), track("text", 1)],
        );
        const runtime = getActiveRuntime()!;
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["t1"])));
        await act(async () => fireEvent.click(screen.getByTestId("text-font-oswald")));
        await waitFor(() => expect(commands()[0]).toMatchObject({ type: "text.style.set", clipIds: ["t1"], patch: { fontWeight: "700" } }));
        expect((commands()[0] as unknown as { patch: { fontFamily: string } }).patch.fontFamily).toMatch(/^Oswald, /);
    });
});
