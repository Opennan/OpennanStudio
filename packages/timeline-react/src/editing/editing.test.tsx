import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { selectLiveScenes } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { renderWithTimeline, seedTimeline, createTimelineTestRuntime } from "../test-utils/render-with-timeline";
import { addEffectLayer, applyTransition } from "./actions";
import { Inspector } from "./inspector/inspector";
import { EditorLibrary } from "./library/editor-library";
import { filterLibraryItems } from "./library/library-panel";
import { hasReadOnlyShots } from "./read-only-shots";
import { storyboardOf } from "./storyboard";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: start || 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

async function seeded() {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("audio", 1)],
        scenes: [scene("a", 0, 3), scene("b", 3, 2)],
        clips: [clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video" })],
    });
    return runtime;
}

describe("library search and categories", () => {
    it("filters by name, id, and category", () => {
        const items = [{ id: "wipe_left", name: "Wipe left", category: "wipe" }, { id: "spin", name: "Spin", category: "camera" }];
        expect(filterLibraryItems(items, "wipe", "all").map((i) => i.id)).toEqual(["wipe_left"]);
        expect(filterLibraryItems(items, "", "camera").map((i) => i.id)).toEqual(["spin"]);
        expect(filterLibraryItems(items, "SPI", "all").map((i) => i.id)).toEqual(["spin"]);
        expect(filterLibraryItems(items, "zzz", "all")).toEqual([]);
    });
});

describe("EditorLibrary", () => {
    it("switches tabs with the rail (click and arrow keys) and shows the host's media panel", async () => {
        const runtime = await seeded();
        renderWithTimeline(<EditorLibrary media={<p>host media</p>} audio={<p>host audio</p>} />, { runtime });
        expect(screen.getByText("host media")).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "tabTransitions" }));
        expect(screen.getByTestId("library-transitions")).toBeTruthy();
        expect(screen.getAllByTestId(/^transition-card-/)).toHaveLength(25);
        fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowDown" });
        expect(screen.getByTestId("library-filters")).toBeTruthy();
        expect(screen.getAllByTestId(/^filter-card-/)).toHaveLength(30);
        fireEvent.click(screen.getByRole("tab", { name: "tabEffects" }));
        expect(screen.getAllByTestId(/^effect-card-/)).toHaveLength(20);
    });

    it("searches and narrows by category chips", async () => {
        const runtime = await seeded();
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        fireEvent.click(screen.getByRole("tab", { name: "tabTransitions" }));
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "tr_wipe" } });
        // keyEcho shows keys as names: "tr_wipe_left" etc.
        expect(screen.getAllByTestId(/^transition-card-/).map((el) => el.dataset.testid)).toEqual(
            ["transition-card-wipe_left", "transition-card-wipe_right", "transition-card-wipe_up", "transition-card-wipe_down"],
        );
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "trCat_camera" }));
        expect(screen.getAllByTestId(/^transition-card-/)).toHaveLength(4);
    });

    it("clicking a transition sets it on the selected scene's cut (one command) and selects the transition", async () => {
        const runtime = await seeded();
        runtime.store.getState().selectScene("a");
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        fireEvent.click(screen.getByRole("tab", { name: "tabTransitions" }));
        await act(async () => fireEvent.click(screen.getByTestId("transition-card-spin")));
        await waitFor(() => expect(selectLiveScenes(runtime.store.getState())[0]).toMatchObject({ visualTransition: "spin", visualTransitionDuration: 0.6 }));
        expect(runtime.store.getState().selectedTransition).toEqual({ kind: "scene", id: "a" });
        expect(runtime.recording.callsTo("updateScene")).toHaveLength(1);
    });

    it("clicking a filter applies it to the selected clip; an effect click adds to its stack", async () => {
        const runtime = await seeded();
        runtime.store.getState().setSelectedClipIds(new Set(["v"]));
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        fireEvent.click(screen.getByRole("tab", { name: "tabFilters" }));
        await act(async () => fireEvent.click(screen.getByTestId("filter-card-vivid")));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips[0]).toMatchObject({ visualFilter: "vivid", filterIntensity: 0.8 }));
        expect(screen.getByTestId("filter-intensity")).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "tabEffects" }));
        await act(async () => fireEvent.click(screen.getByTestId("effect-card-fx_vhs")));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips[0].effects?.map((e) => e.effectId)).toEqual(["fx_vhs"]));
    });

    it("adds a text template at the playhead from the Text tab (one clip.create on a new text track)", async () => {
        const runtime = await seeded();
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        fireEvent.click(screen.getByRole("tab", { name: "tabText" }));
        await act(async () => fireEvent.click(screen.getByTestId("text-template-subtitle_clean")));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.filter((c) => c.trackType === "text")).toHaveLength(1));
        expect(runtime.store.getState().timelineData!.tracks.some((t) => t.type === "text")).toBe(true);
    });
});

describe("transitions on upper-track clip cuts", () => {
    async function withCut() {
        const runtime = createTimelineTestRuntime();
        await seedTimeline(runtime, {
            tracks: [track("video", 1), track("video", 2), track("audio", 1)],
            scenes: [scene("a", 0, 3), scene("b", 3, 2)],
            clips: [
                clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video" }),
                clip("w", { trackType: "video", trackIndex: 2, startTime: 2.03, endTime: 3.5, mediaUrl: "/m/w.png", mediaType: "image" }),
            ],
        });
        return runtime;
    }

    it("clicking any library transition with a V2 clip selected sets it on that clip's cut and selects the transition", async () => {
        const runtime = await withCut();
        runtime.store.getState().setSelectedClipIds(new Set(["w"]));
        renderWithTimeline(<EditorLibrary media={null} audio={null} />, { runtime });
        fireEvent.click(screen.getByRole("tab", { name: "tabTransitions" }));
        await act(async () => fireEvent.click(screen.getByTestId("transition-card-push_left")));
        // The incoming clip's cut belongs to the outgoing clip v.
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.find((c) => c.id === "v")).toMatchObject({ transitionType: "push_left" }));
        expect(runtime.store.getState().selectedTransition).toEqual({ kind: "clip", id: "v" });
        await waitFor(() => expect(screen.getByTestId("transition-card-push_left").dataset.applied).toBe("true"));
    });

    it("the inspector clamps a clip transition to the cut (2 s and both neighbours)", async () => {
        const runtime = await withCut();
        renderWithTimeline(<Inspector />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        await act(async () => {
            await ctrl.execute({ type: "transition.set", clipId: "v", transition: "wipe_left" });
        });
        act(() => runtime.store.getState().selectTransition({ kind: "clip", id: "v" }));
        const slider = within(screen.getByTestId("transition-duration")).getByRole("slider") as HTMLInputElement;
        expect(slider.max).toBe("1.5");
        await act(async () => fireEvent.change(slider, { target: { value: "1.2" } }));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.find((c) => c.id === "v")!.transitionDuration).toBe(1.2));
    });
});

describe("library actions", () => {
    it("applies a transition at the cut nearest the playhead when nothing is selected", async () => {
        const runtime = await seeded();
        renderWithTimeline(<div />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        runtime.store.getState().setCurrentTime(2.9);
        expect(await applyTransition(ctrl, runtime.store, null, "wipe_left")).toEqual({ ok: true, target: "scene" });
        expect(selectLiveScenes(runtime.store.getState())[0].visualTransition).toBe("wipe_left");
    });

    it("adds an effect layer on a new effect track at the playhead", async () => {
        const runtime = await seeded();
        renderWithTimeline(<div />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        expect(await addEffectLayer(ctrl, runtime.store, "fx_glitch", 1)).toEqual({ ok: true, target: "layer" });
        const state = runtime.store.getState().timelineData!;
        expect(state.tracks.some((t) => t.type === "effect")).toBe(true);
        const layer = state.clips.find((c) => c.trackType === "effect")!;
        expect([layer.startTime, layer.endTime]).toEqual([1, 4]);
        expect(layer.effects?.map((e) => e.effectId)).toEqual(["fx_glitch"]);
    });

    it("leaves no empty effect layer behind when the effect cannot be added", async () => {
        const runtime = await seeded();
        renderWithTimeline(<div />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        runtime.recording.failNext("addClipEffect");
        expect(await addEffectLayer(ctrl, runtime.store, "fx_glitch", 1)).toEqual({ ok: false, reason: "failed" });
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.some((c) => c.trackType === "effect")).toBe(false));
    });
});

describe("Inspector", () => {
    it("shows project settings with nothing selected and renames the project", async () => {
        const runtime = await seeded();
        runtime.store.getState().setProjectMeta({ id: "project-1", name: "Trip", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" });
        runtime.store.getState().setSelectedSceneId(null);
        renderWithTimeline(<Inspector />, { runtime });
        const panel = screen.getByTestId("inspector-project");
        const name = within(panel).getByDisplayValue("Trip");
        fireEvent.change(name, { target: { value: "Road trip" } });
        await act(async () => fireEvent.blur(name));
        await waitFor(() => expect(runtime.store.getState().projectMeta?.name).toBe("Road trip"));
        fireEvent.click(within(panel).getByRole("button", { name: "9:16" }));
        await waitFor(() => expect(runtime.store.getState().projectMeta?.aspectRatio).toBe("9:16"));
    });

    it("shows scene tabs, adjusts a control, and resets all in one command", async () => {
        const runtime = await seeded();
        runtime.store.getState().selectScene("a");
        renderWithTimeline(<Inspector />, { runtime });
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["tabVideo", "anim_tab", "tabMask", "tabTrack", "tabAdjust", "tabFilter", "tabEffects", "tabSpeed", "tabAi"]);
        fireEvent.click(screen.getByTestId("inspector-tab-adjust"));
        const exposure = within(screen.getByTestId("adjust-exposure")).getByRole("slider");
        await act(async () => fireEvent.change(exposure, { target: { value: "40" } }));
        await waitFor(() => expect(JSON.parse(selectLiveScenes(runtime.store.getState())[0].adjustmentsJson ?? "{}")).toEqual({ exposure: 0.4 }));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "resetAll" })));
        // The reset waits for the exposure slider's debounced save, then saves; allow for a loaded host.
        await waitFor(() => expect(selectLiveScenes(runtime.store.getState())[0].adjustmentsJson ?? null).toBeNull(), { timeout: 5000 });
    });

    it("lists a clip's effect stack with reorder, toggle, and remove", async () => {
        const runtime = await seeded();
        runtime.store.getState().setSelectedClipIds(new Set(["v"]));
        renderWithTimeline(<Inspector />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        await act(async () => {
            await ctrl.execute({ type: "clip.effect.add", clipId: "v", effectId: "fx_blur" });
            await ctrl.execute({ type: "clip.effect.add", clipId: "v", effectId: "fx_sepia" });
        });
        fireEvent.click(screen.getByTestId("inspector-tab-effects"));
        expect(screen.getAllByTestId("effects-stack-item")).toHaveLength(2);
        await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "moveUp" })[1]));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips[0].effects!.slice().sort((a, b) => a.order - b.order).map((e) => e.effectId)).toEqual(["fx_sepia", "fx_blur"]));
        await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "removeEffect" })[0]));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips[0].effects!.map((e) => e.effectId)).toEqual(["fx_blur"]));
    });

    it("edits a selected transition's duration within the cut and applies it to every cut", async () => {
        const runtime = await seeded();
        renderWithTimeline(<Inspector />, { runtime });
        const ctrl = (await import("../provider/registry")).getActiveRuntime()!.controller;
        await act(async () => {
            await ctrl.execute({ type: "transition.set", sceneId: "a", transition: "cross_dissolve" });
        });
        act(() => runtime.store.getState().selectTransition({ kind: "scene", id: "a" }));
        const slider = within(screen.getByTestId("transition-duration")).getByRole("slider") as HTMLInputElement;
        expect(slider.max).toBe("2");
        await act(async () => fireEvent.change(slider, { target: { value: "1.2" } }));
        await waitFor(() => expect(selectLiveScenes(runtime.store.getState())[0].visualTransitionDuration).toBe(1.2));
        await act(async () => fireEvent.click(screen.getByTestId("transition-apply-all")));
        // Apply to all is one write (one undo step) covering every cut.
        await waitFor(() => expect(runtime.recording.callsTo("updateScenes")).toHaveLength(1));
        expect((runtime.recording.callsTo("updateScenes")[0].args[1] as unknown[]).length).toBeGreaterThanOrEqual(1);
        await waitFor(() => expect(selectLiveScenes(runtime.store.getState()).filter((s) => s.visualTransition === "cross_dissolve").every((s) => s.visualTransitionDuration === 1.2)).toBe(true));
    });
});

describe("scenes whose shots were made on opennan.com (9a.1)", () => {
    const webShots = JSON.stringify([{ duration: 2, prompt: "wide", readOnly: true }, { duration: 1, prompt: "close", readOnly: true }]);

    async function seededWeb() {
        const runtime = createTimelineTestRuntime();
        await seedTimeline(runtime, {
            tracks: [track("video", 1)],
            scenes: [scene("web", 0, 3, { shotBreakdown: webShots }), scene("studio", 3, 2, { shotBreakdown: JSON.stringify([{ duration: 2, prompt: "mine" }]) })],
            clips: [],
        });
        return runtime;
    }

    it("says where to edit their shots, with a link to the project on opennan.com", async () => {
        const runtime = await seededWeb();
        runtime.store.getState().selectScene("web");
        renderWithTimeline(<Inspector shotsEditUrl="https://opennan.com/video/p_1" />, { runtime });
        const badge = await screen.findByTestId("inspector-web-shots");
        expect(badge.textContent).toContain("shotsMadeOnWeb");
        const link = within(badge).getByRole("link", { name: "shotsOpenOnWeb" });
        expect(link.getAttribute("href")).toBe("https://opennan.com/video/p_1");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("shows no badge on a Studio scene, and no link without the host's address", async () => {
        const runtime = await seededWeb();
        runtime.store.getState().selectScene("studio");
        const view = renderWithTimeline(<Inspector shotsEditUrl="https://opennan.com/video/p_1" />, { runtime });
        await screen.findByTestId("inspector-tab-video");
        expect(screen.queryByTestId("inspector-web-shots")).toBeNull();
        view.unmount();
        act(() => runtime.store.getState().selectScene("web"));
        renderWithTimeline(<Inspector />, { runtime });
        const badge = await screen.findByTestId("inspector-web-shots");
        expect(within(badge).queryByRole("link")).toBeNull();
    });

    it("hasReadOnlyShots reads the shot list (anything unreadable is a Studio scene)", () => {
        expect(hasReadOnlyShots({ shotBreakdown: webShots })).toBe(true);
        expect(hasReadOnlyShots({ shotBreakdown: JSON.stringify([{ duration: 1 }]) })).toBe(false);
        expect(hasReadOnlyShots({ shotBreakdown: "{not json" })).toBe(false);
        expect(hasReadOnlyShots({ shotBreakdown: JSON.stringify({ speakers: [] }) })).toBe(false);
        expect(hasReadOnlyShots({ shotBreakdown: null })).toBe(false);
        expect(hasReadOnlyShots({})).toBe(false);
    });
});

describe("Storyboard section (phase 9c)", () => {
    const sheets = [
        { imageUrl: "/m/sheet-1.png", panels: [{ index: 0, shotIndex: 0, imageUrl: "/m/p0.png" }, { index: 1, shotIndex: 1, imageUrl: "/m/p1.png" }] },
        { imageUrl: null, panels: [{ index: 0, shotIndex: 2, imageUrl: "/m/p2.png" }] },
    ];
    const panelsOnly = JSON.stringify([{ duration: 2, prompt: "wide", keyframe_url: "/m/k0.png", readOnly: true }, { duration: 2, prompt: "close", readOnly: true }]);

    async function seededBoards() {
        const runtime = createTimelineTestRuntime();
        await seedTimeline(runtime, {
            tracks: [track("video", 1)],
            scenes: [scene("drawn", 0, 3, { storyboardSheets: sheets }), scene("panels", 3, 2, { shotBreakdown: panelsOnly }), scene("plain", 5, 2)],
            clips: [],
        });
        return runtime;
    }

    it("storyboardOf reads the sheets, else the shots' panels (9b), else nothing", () => {
        expect(storyboardOf({ storyboardSheets: sheets })).toEqual([
            { imageUrl: "/m/sheet-1.png", panels: ["/m/p0.png", "/m/p1.png"] },
            { imageUrl: null, panels: ["/m/p2.png"] },
        ]);
        expect(storyboardOf({ shotBreakdown: panelsOnly })).toEqual([{ imageUrl: null, panels: ["/m/k0.png"] }]);
        expect(storyboardOf({ shotBreakdown: "{bad" })).toEqual([]);
        expect(storyboardOf({ storyboardSheets: [], shotBreakdown: null })).toEqual([]);
    });

    it("shows a scene's sheets and their panels, read only; a panel opens large with back, next and close", async () => {
        const runtime = await seededBoards();
        runtime.store.getState().selectScene("drawn");
        renderWithTimeline(<Inspector />, { runtime });
        const section = await screen.findByTestId("inspector-storyboard");
        expect(within(section).getByText("storyboardTitle")).toBeTruthy();
        const images = [...section.querySelectorAll(".on-storyboard-thumb img")].map((img) => img.getAttribute("src"));
        expect(images).toEqual(["/m/sheet-1.png", "/m/p0.png", "/m/p1.png", "/m/p2.png"]);
        fireEvent.click(within(section).getAllByRole("button", { name: /storyboardPanelAlt/ })[1]!);
        const large = screen.getByTestId("inspector-storyboard-large");
        expect(within(large).getByRole("img").getAttribute("src")).toBe("/m/p1.png");
        fireEvent.click(within(large).getByRole("button", { name: "storyboardNext" }));
        expect(within(large).getByRole("img").getAttribute("src")).toBe("/m/p2.png");
        expect((within(large).getByRole("button", { name: "storyboardNext" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(within(large).getByRole("button", { name: "storyboardBack" }));
        expect(within(large).getByRole("img").getAttribute("src")).toBe("/m/p1.png");
        fireEvent.click(within(large).getByRole("button", { name: "storyboardClose" }));
        expect(screen.queryByTestId("inspector-storyboard-large")).toBeNull();
        // Escape closes it too.
        fireEvent.click(within(section).getAllByRole("button", { name: /storyboardPanelAlt/ })[0]!);
        fireEvent.keyDown(screen.getByTestId("inspector-storyboard-large"), { key: "Escape" });
        expect(screen.queryByTestId("inspector-storyboard-large")).toBeNull();
        // The sheet itself opens large too.
        fireEvent.click(within(section).getByRole("button", { name: /storyboardSheetAlt/ }));
        expect(within(screen.getByTestId("inspector-storyboard-large")).getByRole("img").getAttribute("src")).toBe("/m/sheet-1.png");
    });

    it("shows a 9b scene's panels without a sheet, and nothing for a scene without a storyboard", async () => {
        const runtime = await seededBoards();
        runtime.store.getState().selectScene("panels");
        const view = renderWithTimeline(<Inspector />, { runtime });
        const section = await screen.findByTestId("inspector-storyboard");
        expect([...section.querySelectorAll(".on-storyboard-thumb img")].map((img) => img.getAttribute("src"))).toEqual(["/m/k0.png"]);
        view.unmount();
        act(() => runtime.store.getState().selectScene("plain"));
        renderWithTimeline(<Inspector />, { runtime });
        await screen.findByTestId("inspector-tab-video");
        expect(screen.queryByTestId("inspector-storyboard")).toBeNull();
    });
});
