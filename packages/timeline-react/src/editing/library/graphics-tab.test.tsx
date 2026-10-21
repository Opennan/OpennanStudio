import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { GRAPHICS_TEMPLATES } from "@opennan/timeline-core/graphics/templates";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { renderWithTimeline, seedTimeline, createTimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { EditorLibrary } from "./editor-library";
import { GRAPHIC_SECONDS, GraphicsTab, planGraphicsClip } from "./graphics-tab";

const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack => ({
    type, index, label: "", muted: false, locked: false, visible: true, volume: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

async function seeded(data: { tracks?: TimelineTrack[]; clips?: TimelineClip[] } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: data.tracks ?? [track("video", 1), track("audio", 1)], clips: data.clips ?? [] });
    return runtime;
}

const shownIds = () => screen.queryAllByTestId(/^graphic-card-/).map((el) => el.dataset.testid!.slice("graphic-card-".length));

describe("GraphicsTab", () => {
    beforeEach(() => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    });
    afterEach(() => vi.restoreAllMocks());

    it("opens from the library rail after Stickers and shows every built-in template", async () => {
        const runtime = await seeded();
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        const tabs = screen.getAllByRole("tab").map((tab) => tab.dataset.tab);
        expect(tabs.indexOf("graphics")).toBe(tabs.indexOf("stickers") + 1);
        fireEvent.click(screen.getByRole("tab", { name: "gfx_tab" }));
        expect(screen.getByTestId("library-graphics")).toBeTruthy();
        expect(shownIds()).toEqual(GRAPHICS_TEMPLATES.map((template) => template.id));
    });

    it("search and category chips narrow the grid", async () => {
        const runtime = await seeded();
        renderWithTimeline(<GraphicsTab />, { runtime });
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "LOWER" } });
        expect(shownIds()).toEqual(["lower-third"]);
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "gfx_cat_data" }));
        expect(shownIds()).toEqual(GRAPHICS_TEMPLATES.filter((template) => template.category === "data").map((template) => template.id));
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzqx" } });
        expect(screen.getByText("gfx_empty")).toBeTruthy();
    });

    it("a click adds a 4 s graphic with the template's defaults at the playhead (one command) and selects it", async () => {
        const runtime = await seeded({ tracks: [track("video", 1), track("audio", 1), track("remotion", 1)] });
        runtime.store.getState().setCurrentTime(2);
        renderWithTimeline(<GraphicsTab />, { runtime });
        await act(async () => fireEvent.click(screen.getByTestId("graphic-card-lower-third")));
        await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
        const input = runtime.recording.callsTo("createClips")[0].args[1][0];
        expect(input).toMatchObject({ trackType: "remotion", trackIndex: 1, startTime: 2, endTime: 2 + GRAPHIC_SECONDS, remotionTemplateId: "lower-third", label: "Lower Third" });
        expect(JSON.parse(input.remotionPropsJson)).toMatchObject({ name: "Name Surname" });
        await waitFor(() => {
            const created = runtime.store.getState().timelineData!.clips.find((c) => c.remotionTemplateId === "lower-third")!;
            expect(runtime.store.getState().selectedClipIds.has(created.id)).toBe(true);
        });
    });

    it("drags carry the graphics drop payload the timeline already accepts", async () => {
        const runtime = await seeded();
        renderWithTimeline(<GraphicsTab />, { runtime });
        const data: Record<string, string> = {};
        fireEvent.dragStart(screen.getByTestId("graphic-card-countdown"), { dataTransfer: { setData: (type: string, value: string) => { data[type] = value; }, effectAllowed: "" } });
        expect(JSON.parse(data["application/json"])).toEqual({ kind: "remotion", templateId: "countdown", name: "Countdown" });
    });
});

describe("planGraphicsClip", () => {
    const lower = GRAPHICS_TEMPLATES.find((template) => template.id === "lower-third")!;
    it("adds a graphics track when none is free, skipping locked ones", () => {
        const tracks = [track("video", 1), track("remotion", 1, { locked: true })];
        const plan = planGraphicsClip(tracks, [], lower, 1);
        expect(plan.tracks?.filter((t) => t.type === "remotion").map((t) => t.index)).toEqual([1, 2]);
        expect(plan.input).toMatchObject({ trackIndex: 2, startTime: 1 });
        const busy = [clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 10 })];
        expect(planGraphicsClip([track("video", 1), track("remotion", 1)], busy, lower, 1).input.trackIndex).toBe(2);
    });
});
