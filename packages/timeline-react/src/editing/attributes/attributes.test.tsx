import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { AttributePasteReport, EditorCommand, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { selectLiveScenes, snapshotAttributes } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { createTimelineTestRuntime, keyOnly, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { Inspector } from "../inspector/inspector";
import { AttributePastePicker } from "./attribute-paste-picker";
import { PASTE_ATTRIBUTES_STORAGE_KEY, selectionAttributeItem, selectionAttributeTargets } from "./use-attribute-actions";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: start || 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const STYLED = { visualFilter: "warm", filterIntensity: 0.5, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.5 } }), label: "Hero shot" };

async function setup(options: { select?: { clips?: string[]; scene?: string } } = {}) {
    const runtime = createTimelineTestRuntime();
    runtime.store.getState().resetForProject();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("text", 1), track("audio", 1)],
        scenes: [scene("a", 0, 3)],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video", ...STYLED }),
            clip("w", { trackType: "video", trackIndex: 2, startTime: 3, endTime: 5, mediaUrl: "/m/w.mp4", mediaType: "video" }),
            clip("x", { trackType: "video", trackIndex: 2, startTime: 6, endTime: 8, mediaUrl: "/m/x.mp4", mediaType: "video" }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", mediaType: "text" }),
            clip("au", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: "/m/a.mp3", mediaType: "audio" }),
        ],
    });
    const state = runtime.store.getState();
    if (options.select?.clips) state.setSelectedClipIds(new Set(options.select.clips));
    if (options.select?.scene) state.selectScene(options.select.scene);
    renderWithTimeline(<><Inspector /><AttributePastePicker /></>, { runtime, translate: keyOnly });
    const execute = vi.spyOn(getActiveRuntime()!.controller, "execute");
    return { runtime, execute };
}

const clipOf = (runtime: TimelineTestRuntime, id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!;
const pastes = (execute: { mock: { calls: unknown[][] } }) => execute.mock.calls.map((call) => call[0] as EditorCommand).filter((c) => c.type === "attributes.paste");
const checkbox = (kind: string) => screen.getByTestId(`paste-attr-${kind}`) as HTMLInputElement;

beforeEach(() => {
    window.localStorage.removeItem(PASTE_ATTRIBUTES_STORAGE_KEY);
});

describe("copy and paste attributes", () => {
    it("copies the inspected clip from the inspector header and announces what was copied", async () => {
        const { runtime } = await setup({ select: { clips: ["v"] } });
        fireEvent.click(screen.getByRole("button", { name: "attrCopy" }));
        const snapshot = runtime.store.getState().attributeClipboard!;
        expect(snapshot.kinds).toEqual(["filter", "animation"]);
        expect(snapshot.source).toMatchObject({ id: "v", label: "Hero shot" });
        expect(runtime.onToast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "success", message: "attrCopied" }));
    });

    it("says so instead of copying an item with nothing to copy", async () => {
        const { runtime } = await setup({ select: { clips: ["w"] } });
        fireEvent.click(screen.getByRole("button", { name: "attrCopy" }));
        expect(runtime.store.getState().attributeClipboard).toBeNull();
        expect(runtime.onToast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "info", message: "attrNothingToCopy" }));
    });

    it("pastes the ticked kinds onto every selected clip with one command and remembers unticked kinds", async () => {
        const { runtime, execute } = await setup({ select: { clips: ["w", "x"] } });
        expect((screen.getByRole("button", { name: "attrPaste" }) as HTMLButtonElement).disabled).toBe(true);
        act(() => runtime.store.getState().setAttributeClipboard(snapshotAttributes({ kind: "clip", clip: clipOf(runtime, "v") })));
        fireEvent.click(screen.getByRole("button", { name: "attrPaste" }));
        expect(runtime.store.getState().attributePastePicker).toEqual({ targets: [{ clipId: "w" }, { clipId: "x" }] });
        expect(screen.getByRole("dialog")).toBeTruthy();
        // Copied kinds start ticked; the rest are disabled and say why.
        expect(checkbox("filter").checked).toBe(true);
        expect(checkbox("animation").checked).toBe(true);
        for (const kind of ["adjust", "effects", "speed", "mask", "transform"]) {
            expect(checkbox(kind).disabled).toBe(true);
            expect(checkbox(kind).getAttribute("aria-describedby")).toBe(`paste-attr-${kind}-hint`);
        }
        fireEvent.click(checkbox("animation"));
        await act(async () => fireEvent.click(screen.getByTestId("paste-attributes-confirm")));
        expect(pastes(execute)).toEqual([{
            type: "attributes.paste", source: runtime.store.getState().attributeClipboard, targets: [{ clipId: "w" }, { clipId: "x" }], attributes: ["filter"],
        }]);
        await waitFor(() => expect(clipOf(runtime, "x").visualFilter).toBe("warm"));
        expect(clipOf(runtime, "w")).toMatchObject({ visualFilter: "warm", filterIntensity: 0.5 });
        expect(clipOf(runtime, "w").animationJson ?? null).toBeNull();
        expect(runtime.store.getState().attributePastePicker).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(runtime.onToast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "success", message: "attrPasted" }));
        expect(JSON.parse(window.localStorage.getItem(PASTE_ATTRIBUTES_STORAGE_KEY)!)).toEqual({ excluded: ["animation"] });

        // Next time animation starts unticked; filter stays ticked.
        act(() => runtime.store.getState().setAttributePastePicker({ targets: [{ sceneId: "a" }] }));
        expect(checkbox("filter").checked).toBe(true);
        expect(checkbox("animation").checked).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "attrCancel" }));
        expect(runtime.store.getState().attributePastePicker).toBeNull();
        expect(pastes(execute)).toHaveLength(1);
    });

    it("disables kinds no target takes and reports a paste where nothing applies", async () => {
        const { runtime, execute } = await setup({ select: { clips: ["txt"] } });
        act(() => runtime.store.getState().setAttributeClipboard(snapshotAttributes({ kind: "clip", clip: clipOf(runtime, "v") })));
        act(() => runtime.store.getState().setAttributePastePicker({ targets: [{ clipId: "au" }] }));
        expect(checkbox("filter").disabled).toBe(true);
        expect(checkbox("animation").disabled).toBe(true);
        expect((screen.getByTestId("paste-attributes-confirm") as HTMLButtonElement).disabled).toBe(true);
        act(() => runtime.store.getState().setAttributePastePicker({ targets: [{ clipId: "txt" }] }));
        // fade_in is a clip animation (text has its own), but the text clip takes animations: the row is enabled.
        expect(checkbox("animation").disabled).toBe(false);
        await act(async () => fireEvent.click(screen.getByTestId("paste-attributes-confirm")));
        const result = await execute.mock.results.at(-1)!.value as { ok: boolean; output: AttributePasteReport };
        expect(result.ok).toBe(false);
        expect(runtime.onToast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "info", message: "attrNothingPasted" }));
    });

    it("pastes a scene's look onto a clip from the scene inspector's clipboard", async () => {
        const { runtime } = await setup({ select: { scene: "a" } });
        await act(async () => getActiveRuntime()!.controller.execute({ type: "look.set", sceneId: "a", filter: "warm", adjustments: { exposure: 0.3 } }));
        fireEvent.click(screen.getByRole("button", { name: "attrCopy" }));
        expect(runtime.store.getState().attributeClipboard!.kinds).toEqual(["filter", "adjust"]);
        act(() => runtime.store.getState().setAttributePastePicker({ targets: [{ clipId: "w" }] }));
        await act(async () => fireEvent.click(screen.getByTestId("paste-attributes-confirm")));
        await waitFor(() => expect(clipOf(runtime, "w").visualFilter).toBe("warm"));
        expect(JSON.parse(clipOf(runtime, "w").adjustmentsJson!)).toEqual({ exposure: 0.3 });
        expect(selectLiveScenes(runtime.store.getState())[0].visualFilter).toBe("warm");
    });
});

describe("selection helpers", () => {
    it("copy reads the selected scene or the primary clip; paste targets every selected clip, else the scene", async () => {
        const { runtime } = await setup({ select: { clips: ["w", "x"] } });
        const s = runtime.store.getState;
        expect(selectionAttributeItem(s())).toMatchObject({ kind: "clip", clip: { id: "w" } });
        expect(selectionAttributeTargets(s())).toEqual([{ clipId: "w" }, { clipId: "x" }]);
        act(() => s().selectScene("a"));
        expect(selectionAttributeItem(s())).toMatchObject({ kind: "scene", scene: { id: "a" } });
        expect(selectionAttributeTargets(s())).toEqual([{ sceneId: "a" }]);
        act(() => s().setSelection({ clipIds: ["w"], sceneIds: ["a"] }));
        expect(selectionAttributeTargets(s())).toEqual([{ clipId: "w" }, { sceneId: "a" }]);
        act(() => s().clearSelection());
        expect(selectionAttributeItem(s())).toBeNull();
        expect(selectionAttributeTargets(s())).toEqual([]);
    });

    it("ignores the scene synced to the playhead: only a scene the user selected is copied or pasted onto", async () => {
        const { runtime } = await setup();
        const s = runtime.store.getState;
        act(() => s().syncActiveScene("a"));
        expect(s().selectedSceneId).toBe("a");
        expect(s().sceneSelectedByUser).toBe(false);
        expect(selectionAttributeItem(s())).toBeNull();
        expect(selectionAttributeTargets(s())).toEqual([]);
        act(() => s().selectScene("a"));
        expect(selectionAttributeItem(s())).toMatchObject({ kind: "scene", scene: { id: "a" } });
        expect(selectionAttributeTargets(s())).toEqual([{ sceneId: "a" }]);
    });
});
