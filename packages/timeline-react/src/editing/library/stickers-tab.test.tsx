import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { STICKERS, TWEMOJI_ATTRIBUTION, searchStickers } from "@opennan/timeline-core/stickers/catalog";
import { renderWithTimeline, seedTimeline, createTimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { EditorLibrary } from "./editor-library";
import { STICKER_DRAG_MIME, STICKER_SECONDS, StickersTab, planStickerClip, stickerMessageKey } from "./stickers-tab";

const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack => ({
    type, index, label: "", muted: false, locked: false, visible: true, volume: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

async function seeded(data: { tracks?: TimelineTrack[]; clips?: TimelineClip[] } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: data.tracks ?? [track("video", 1), track("audio", 1)], clips: data.clips ?? [] });
    return runtime;
}

const shownIds = () => screen.queryAllByTestId(/^sticker-card-/).map((el) => el.dataset.testid!.slice("sticker-card-".length));

describe("StickersTab", () => {
    it("opens from the library rail after Text and shows every sticker with the Twemoji attribution", async () => {
        const runtime = await seeded();
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        const tabs = screen.getAllByRole("tab").map((tab) => tab.dataset.tab);
        expect(tabs.indexOf("stickers")).toBe(tabs.indexOf("text") + 1);
        fireEvent.click(screen.getByRole("tab", { name: "stk_tab" }));
        expect(screen.getByTestId("library-stickers")).toBeTruthy();
        expect(shownIds()).toHaveLength(STICKERS.length);
        expect(screen.getByText(TWEMOJI_ATTRIBUTION)).toBeTruthy();
    });

    it("renders lazy thumbnails with the sticker's name as alt text", async () => {
        const runtime = await seeded();
        renderWithTimeline(<StickersTab />, { runtime });
        const img = screen.getByTestId("sticker-card-twemoji:1f60d").querySelector("img")!;
        expect(img.getAttribute("alt")).toBe("Heart eyes");
        expect(img.getAttribute("loading")).toBe("lazy");
        expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    });

    it("search narrows live, ignoring case and accents, and shows an empty state", async () => {
        const runtime = await seeded();
        renderWithTimeline(<StickersTab />, { runtime });
        const box = screen.getByRole("searchbox");
        fireEvent.change(box, { target: { value: "heart" } });
        const expected = searchStickers("heart").map((s) => s.id);
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(STICKERS.length);
        expect(shownIds()).toEqual(expected);
        fireEvent.change(box, { target: { value: "HÉART" } });
        expect(shownIds()).toEqual(expected);
        fireEvent.change(box, { target: { value: "HEART" } });
        expect(shownIds()).toEqual(expected);
        fireEvent.change(box, { target: { value: "zzqxw" } });
        expect(shownIds()).toEqual([]);
        expect(screen.getByText("stk_empty")).toBeTruthy();
        fireEvent.keyDown(box, { key: "Escape" });
        expect((box as HTMLInputElement).value).toBe("");
        expect(shownIds()).toHaveLength(STICKERS.length);
    });

    it("category chips narrow the grid and combine with the search", async () => {
        const runtime = await seeded();
        renderWithTimeline(<StickersTab />, { runtime });
        fireEvent.click(screen.getByRole("button", { name: "stk_cat_arrows" }));
        expect(screen.getByRole("button", { name: "stk_cat_arrows" }).getAttribute("aria-pressed")).toBe("true");
        expect(shownIds()).toEqual(STICKERS.filter((s) => s.category === "arrows").map((s) => s.id));
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "curved" } });
        expect(shownIds()).toEqual(searchStickers("curved", "arrows").map((s) => s.id));
        fireEvent.click(screen.getByRole("button", { name: "categoryAll" }));
        expect(shownIds()).toEqual(searchStickers("curved").map((s) => s.id));
    });

    it("a click adds a centred 3 s sticker clip at the playhead on the free sticker track (one command) and selects it", async () => {
        const runtime = await seeded({ tracks: [track("video", 1), track("audio", 1), track("sticker", 1)] });
        runtime.store.getState().setCurrentTime(2);
        renderWithTimeline(<StickersTab />, { runtime });
        await act(async () => fireEvent.click(screen.getByTestId("sticker-card-twemoji:1f60d")));
        await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
        expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
            trackType: "sticker", trackIndex: 1, startTime: 2, endTime: 2 + STICKER_SECONDS, mediaType: "sticker",
            stickerId: "twemoji:1f60d", label: "Heart eyes", positionX: 0.5, positionY: 0.5, scale: 1, opacity: 1,
        });
        expect(runtime.recording.callsTo("updateTracks")).toHaveLength(0);
        await waitFor(() => {
            const created = runtime.store.getState().timelineData!.clips.find((c) => c.stickerId === "twemoji:1f60d")!;
            expect(created.mediaUrl ?? null).toBeNull();
            expect(runtime.store.getState().selectedClipIds.has(created.id)).toBe(true);
        });
    });

    it("creates a sticker track first when none is free at the playhead", async () => {
        const runtime = await seeded({
            tracks: [track("video", 1), track("audio", 1), track("sticker", 1)],
            clips: [clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "sticker", stickerId: "opennan:arrow-right" })],
        });
        runtime.store.getState().setCurrentTime(1);
        renderWithTimeline(<StickersTab />, { runtime });
        await act(async () => fireEvent.click(screen.getByTestId("sticker-card-opennan:arrow-curved")));
        await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
        expect(runtime.recording.callsTo("updateTracks")).toHaveLength(1);
        expect(runtime.store.getState().timelineData!.tracks.filter((t) => t.type === "sticker").map((t) => t.index)).toEqual([1, 2]);
        expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({ trackType: "sticker", trackIndex: 2, startTime: 1, stickerId: "opennan:arrow-curved" });
    });

    it("sets the library drag payload (MIME marker + JSON with kind sticker)", async () => {
        const runtime = await seeded();
        renderWithTimeline(<StickersTab />, { runtime });
        const data: Record<string, string> = {};
        const dataTransfer = { setData: (type: string, value: string) => { data[type] = value; }, effectAllowed: "" };
        const card = screen.getByTestId("sticker-card-opennan:arrow-right");
        expect(card.getAttribute("draggable")).toBe("true");
        fireEvent.dragStart(card, { dataTransfer });
        expect(data[STICKER_DRAG_MIME]).toBe("opennan:arrow-right");
        expect(JSON.parse(data["application/json"])).toEqual({ kind: "sticker", stickerId: "opennan:arrow-right", name: "Arrow" });
        expect(dataTransfer.effectAllowed).toBe("copy");
    });
});

describe("planStickerClip", () => {
    const base = [track("video", 1), track("audio", 1)];

    it("adds a sticker track when the project has none", () => {
        const plan = planStickerClip(base, [], "opennan:arrow-right", "Arrow", 4)!;
        expect(plan.tracks?.filter((t) => t.type === "sticker").map((t) => t.index)).toEqual([1]);
        expect(plan.input).toMatchObject({ trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7, stickerId: "opennan:arrow-right", label: "Arrow" });
    });

    it("keeps a dropped sticker on the requested track, shifted to the nearest free spot", () => {
        const tracks = [...base, track("sticker", 1), track("sticker", 2)];
        const clips = [clip("s", { trackType: "sticker", trackIndex: 2, startTime: 0, endTime: 5 })];
        const plan = planStickerClip(tracks, clips, "opennan:arrow-right", "Arrow", 1, 2)!;
        expect(plan.tracks).toBeNull();
        expect(plan.input).toMatchObject({ trackIndex: 2, startTime: 5, endTime: 8 });
    });

    it("skips locked or hidden sticker tracks and refuses a locked drop target", () => {
        const tracks = [...base, track("sticker", 1, { locked: true }), track("sticker", 2, { visible: false }), track("sticker", 3)];
        expect(planStickerClip(tracks, [], "opennan:arrow-right", "Arrow", 0)!.input.trackIndex).toBe(3);
        expect(planStickerClip(tracks, [], "opennan:arrow-right", "Arrow", 0, 1)).toBeNull();
    });

    it("falls back to the default tracks when the timeline has none yet", () => {
        const plan = planStickerClip([], [], "opennan:arrow-right", "Arrow", 0)!;
        expect(plan.tracks?.map((t) => `${t.type}-${t.index}`)).toEqual(["video-1", "audio-1", "sticker-1"]);
    });

    it("maps catalog ids to message keys", () => {
        expect(stickerMessageKey("twemoji:1f60d")).toBe("stk_n_twemoji_1f60d");
        expect(stickerMessageKey("opennan:arrow-hand-drawn")).toBe("stk_n_opennan_arrow_hand_drawn");
    });
});
