// Phase 10c multi-select end to end: a marquee on the timeline selects two clips and a scene, Delete removes all three
// in one undo step; Shift-click in the preview builds a group of two stickers whose box drags both (one undo step);
// the inspector's group mode applies a filter to two scenes at once; a graphics clip takes an animation and a rotation.
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, blurFocus, createProject, execute, snapshot, timelineCanvasBox, timelineZoom, waitForSaves } from "./helpers";
import { deselect, openLibraryTab } from "./motion-helpers";

interface Box { cx: number; cy: number; w: number; h: number; rotation: number }
interface AnyClip { id: string; trackType: string; positionX: number; positionY: number; rotationDegrees: number; animationJson?: string | null; visualFilter?: string | null }
interface AnyScene { id: string; visualFilter?: string | null }

type StudioWindow = { __studio: { store: { getState(): { selectedClipIds: Set<string>; selectedSceneIds: Set<string>; timelineData: { tracks: unknown[] } } } } };

const clips = async (page: Page) => (await snapshot(page)).clips as unknown as AnyClip[];
const scenes = async (page: Page) => (await snapshot(page)).scenes as unknown as AnyScene[];
const selection = (page: Page) => page.evaluate(() => {
    const s = (window as unknown as StudioWindow).__studio.store.getState();
    return { clipIds: [...s.selectedClipIds].sort(), sceneIds: [...s.selectedSceneIds].sort() };
});
const previewBoxes = (page: Page) => page.evaluate(() => (
    (window as unknown as { __opennanPreviewBoxes?: () => { items: Record<string, Box>; group: Box | null } | null }).__opennanPreviewBoxes?.() ?? null
));

async function twoScenes(page: Page): Promise<[string, string]> {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    for (let i = 0; i < 2; i += 1) {
        await tile.hover();
        await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(i + 1);
    }
    await expect.poll(async () => (await snapshot(page)).scenes.every((s) => !/^(temp-|optimistic-)/.test(s.id))).toBe(true);
    const [a, b] = (await snapshot(page)).scenes;
    return [a.id, b.id];
}

/** Text clips on a new text track (one command), returning their ids. */
async function textClips(page: Page, spans: Array<[number, number]>): Promise<string[]> {
    const tracks = await page.evaluate(() => (window as unknown as StudioWindow).__studio.store.getState().timelineData.tracks);
    const withText = [...tracks, { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }];
    const before = new Set((await clips(page)).map((c) => c.id));
    expect((await execute(page, {
        type: "clip.create",
        tracks: withText,
        input: spans.map(([startTime, endTime], i) => ({ trackType: "text", trackIndex: 1, startTime, endTime, mediaType: "text", textContent: `T${i}` })),
    })).ok).toBe(true);
    await expect.poll(async () => (await clips(page)).filter((c) => !before.has(c.id) && !c.id.startsWith("temp-")).length).toBe(spans.length);
    return (await clips(page)).filter((c) => !before.has(c.id)).map((c) => c.id);
}

test("a timeline marquee selects two clips and a scene; Delete removes them in one step; undo restores them", async ({ page }) => {
    await createProject(page, "Marquee");
    const [a, b] = await twoScenes(page);
    const [t0, t1] = await textClips(page, [[0.5, 2], [3, 5]]);
    await waitForSaves(page);
    await deselect(page);

    // From empty space on the text track (5.6 s, after the second text clip) to 0.2 s on V1: both text clips and the
    // first scene (0-6 s) are inside; the second scene (6-12 s) is not.
    const canvas = await timelineCanvasBox(page);
    const zoom = await timelineZoom(page);
    const tracks = await page.evaluate(() => (window as unknown as { __timelineDebugTracks: () => Array<{ type: string; index: number; y: number; height: number }> }).__timelineDebugTracks());
    const textRow = tracks.find((t) => t.type === "text" && t.index === 1)!;
    const videoRow = tracks.find((t) => t.type === "video" && t.index === 1)!;
    const scrollLeft = await page.evaluate(() => (window as unknown as { __timelineDebugMarkers: () => { scrollLeft: number } }).__timelineDebugMarkers().scrollLeft);
    const at = (seconds: number, row: { y: number; height: number }) => ({ x: canvas.x + seconds * zoom - scrollLeft, y: canvas.y + row.y + row.height / 2 });
    const from = at(5.6, textRow);
    const to = at(0.2, videoRow);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => selection(page)).toEqual({ clipIds: [t0, t1].sort(), sceneIds: [a] });

    // One Delete removes all three; one undo brings them all back.
    await blurFocus(page);
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await clips(page)).filter((c) => c.trackType === "text").length).toBe(0);
    await expect.poll(async () => (await scenes(page)).map((s) => s.id)).toEqual([b]);
    await waitForSaves(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await clips(page)).filter((c) => c.trackType === "text").map((c) => c.id).sort()).toEqual([t0, t1].sort());
    await expect.poll(async () => (await scenes(page)).map((s) => s.id).sort()).toEqual([a, b].sort());
    await waitForSaves(page);

    // Dragging one selected item moves the whole selection (a text clip with the second scene): one undo step.
    await execute(page, { type: "selection.set", clipIds: [t1], sceneIds: [b] });
    const clipStart = async () => ((await snapshot(page)).clips.find((c) => c.id === t1)!).startTime;
    const sceneStart = async () => ((await snapshot(page)).scenes.find((s) => s.id === b) as unknown as { timelinePositionSeconds: number }).timelinePositionSeconds;
    const [clip0, scene0] = [await clipStart(), await sceneStart()];
    const grab = at(9, videoRow);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + zoom, grab.y, { steps: 6 });
    await page.mouse.move(grab.x + 2 * zoom, grab.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(sceneStart).toBeGreaterThan(scene0 + 1.5);
    expect(await clipStart()).toBeCloseTo(clip0 + ((await sceneStart()) - scene0), 2);
    await waitForSaves(page);
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(sceneStart).toBeCloseTo(scene0, 2);
    expect(await clipStart()).toBeCloseTo(clip0, 2);
});

test("Shift-click two stickers in the preview, drag the group box: both move, one undo restores both", async ({ page }) => {
    await createProject(page, "Preview group");
    await openLibraryTab(page, "Stickers");
    await page.getByTestId("sticker-card-twemoji:1f525").click();
    await expect.poll(async () => (await clips(page)).filter((c) => c.trackType === "sticker" && !c.id.startsWith("temp-")).length).toBe(1);
    await page.getByTestId("sticker-card-twemoji:1f525").click();
    await expect.poll(async () => (await clips(page)).filter((c) => c.trackType === "sticker" && !c.id.startsWith("temp-")).length).toBe(2);
    const [s1, s2] = (await clips(page)).filter((c) => c.trackType === "sticker");
    await execute(page, { type: "clip.update", clipIds: [s1.id], patch: { positionX: 0.25, positionY: 0.4 } });
    await execute(page, { type: "clip.update", clipIds: [s2.id], patch: { positionX: 0.75, positionY: 0.6 } });
    await execute(page, { type: "playhead.seek", seconds: 1 });
    await waitForSaves(page);
    await deselect(page);

    await expect.poll(async () => Object.keys((await previewBoxes(page))?.items ?? {}).sort()).toEqual([s1.id, s2.id].sort());
    const items = (await previewBoxes(page))!.items;
    await page.mouse.click(items[s1.id].cx, items[s1.id].cy);
    await page.keyboard.down("Shift");
    await page.mouse.click(items[s2.id].cx, items[s2.id].cy);
    await page.keyboard.up("Shift");
    await expect.poll(() => selection(page)).toEqual({ clipIds: [s1.id, s2.id].sort(), sceneIds: [] });
    await expect.poll(async () => Boolean((await previewBoxes(page))?.group)).toBe(true);
    const group = (await previewBoxes(page))!.group!;
    expect(group.w).toBeGreaterThan(Math.abs(items[s2.id].cx - items[s1.id].cx));

    // Drag the group from the first sticker: both move right and down by the same pixels.
    const start = { x: items[s1.id].cx, y: items[s1.id].cy };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 20, { steps: 6 });
    await page.mouse.move(start.x + 80, start.y + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await clips(page)).find((c) => c.id === s1.id)!.positionX).toBeGreaterThan(0.3);
    const moved = await clips(page);
    expect(moved.find((c) => c.id === s2.id)!.positionX).toBeGreaterThan(0.76);
    expect(moved.find((c) => c.id === s1.id)!.positionY).toBeGreaterThan(0.41);
    await expect.poll(() => selection(page)).toEqual({ clipIds: [s1.id, s2.id].sort(), sceneIds: [] });
    await waitForSaves(page);

    // One undo restores both.
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await clips(page)).find((c) => c.id === s1.id)!.positionX).toBeCloseTo(0.25, 3);
    expect((await clips(page)).find((c) => c.id === s2.id)!.positionX).toBeCloseTo(0.75, 3);
});

test("the inspector's group mode applies a filter to two scenes in one step", async ({ page }) => {
    await createProject(page, "Group filter");
    const [a, b] = await twoScenes(page);
    await execute(page, { type: "selection.set", sceneIds: [a, b] });
    const inspector = page.getByTestId("inspector");
    await expect(inspector.getByTestId("inspector-group-title")).toHaveText("2 items");
    await inspector.getByTestId("inspector-tab-filter").click();
    await inspector.getByTestId("group-filter-warm").click();
    await expect.poll(async () => (await scenes(page)).map((s) => s.visualFilter)).toEqual(["warm", "warm"]);
    await waitForSaves(page);
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await scenes(page)).map((s) => s.visualFilter ?? "none")).toEqual(["none", "none"]);
});

test("a graphics clip takes an animation and a rotation from the inspector", async ({ page }) => {
    await createProject(page, "Graphics motion");
    const tracks = await page.evaluate(() => (window as unknown as StudioWindow).__studio.store.getState().timelineData.tracks);
    expect((await execute(page, {
        type: "clip.create",
        tracks: [...tracks, { type: "remotion", index: 1, label: "G1", muted: false, locked: false, visible: true, volume: 1 }],
        input: { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "remotion", label: "Title card", remotionPropsJson: "{}" },
    })).ok).toBe(true);
    await expect.poll(async () => (await clips(page)).some((c) => c.trackType === "remotion" && !c.id.startsWith("temp-"))).toBe(true);
    const graphic = (await clips(page)).find((c) => c.trackType === "remotion")!;
    await execute(page, { type: "selection.set", clipIds: [graphic.id] });

    const inspector = page.getByTestId("inspector");
    await inspector.getByTestId("inspector-tab-animation").click();
    await inspector.getByTestId("anim-card-in-fade_in").click();
    await expect.poll(async () => (await clips(page)).find((c) => c.id === graphic.id)!.animationJson ?? "").toContain("fade_in");

    await inspector.getByTestId("inspector-tab-video").click();
    const rotation = inspector.getByTestId("clip-rotation").getByRole("slider");
    await rotation.focus();
    for (let i = 0; i < 5; i += 1) await rotation.press("ArrowRight");
    await expect.poll(async () => (await clips(page)).find((c) => c.id === graphic.id)!.rotationDegrees).toBe(5);
    await waitForSaves(page);
});
