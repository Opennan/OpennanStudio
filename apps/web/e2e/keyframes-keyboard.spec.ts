// Phase 10d end to end: keyframe diamonds from the keyboard. Tab reaches the selected clip's diamonds (focus
// selects and seeks, the canvas rings it), arrows retime (undo still works while a diamond has focus),
// Alt+arrow moves focus, Enter opens the easing menu (Escape returns focus), Delete removes; each checked in the
// stored keyframesJson.
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, snapshot, timelineCanvasBox, waitForSaves } from "./helpers";

interface Point { time: number; scale?: number; easing?: number }
interface KeyframeDiamonds { clipId: string | null; focusedTime: number | null; diamonds: Array<{ time: number; x: number; y: number }> }

const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function clipPoints(page: Page, id: string): Promise<Point[]> {
    const clip = (await snapshot(page)).clips.find((c) => c.id === id) as unknown as { keyframesJson?: string | null } | undefined;
    const raw = JSON.parse(clip?.keyframesJson ?? "[]") as Point[] | { keyframes?: Point[] };
    return (Array.isArray(raw) ? raw : raw.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
}

const pointTimes = async (page: Page, id: string) => (await clipPoints(page, id)).map((p) => round3(p.time));

const debugKeyframes = (page: Page) => page.evaluate(() => (window as unknown as { __timelineDebugKeyframes?: () => KeyframeDiamonds | null }).__timelineDebugKeyframes?.() ?? null);

const selectedKeyframe = (page: Page) => page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { selectedKeyframe: unknown } } } }).__studio.store.getState().selectedKeyframe);

/** The accessible name of the focused element, when it is a keyframe option. */
const focusedOption = (page: Page) => page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("role") === "option" ? el.getAttribute("aria-label") : null;
});

test("keyframe diamonds are reachable and editable from the keyboard", async ({ page }) => {
    test.setTimeout(180_000);
    await createProject(page, "Keyboard keyframes");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    // A layer clip 1..5 s with Scale keyframes at 0.5 s and 2.5 s (item time).
    const created = await execute(page, {
        type: "clip.create",
        input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: (await snapshot(page)).scenes[0].sourceVideoUrl, mediaType: "video", label: "Overlay" },
    }) as { createdClipIds?: string[] };
    const id = created.createdClipIds?.[0];
    expect(id).toBeTruthy();
    await execute(page, { type: "selection.set", clipIds: [id] });
    expect((await execute(page, { type: "keyframe.set", clipId: id, time: 0.5, values: { scale: 1 } })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", clipId: id, time: 2.5, values: { scale: 1.5 } })).ok).toBe(true);
    await execute(page, { type: "playhead.seek", seconds: 0 });
    await waitForSaves(page);

    // One tab stop for the group, named after the clip.
    const list = page.getByRole("listbox", { name: "Keyframes of Overlay" });
    await expect(list.getByRole("option")).toHaveCount(2);
    // The hidden options sit over the drawn diamonds.
    const canvas = await timelineCanvasBox(page);
    const drawn = (await debugKeyframes(page))!.diamonds;
    for (const [index, diamond] of drawn.entries()) {
        const box = await list.getByRole("option").nth(index).boundingBox();
        expect(Math.abs(box!.x + box!.width / 2 - (canvas.x + diamond.x))).toBeLessThan(1.5);
        expect(Math.abs(box!.y + box!.height / 2 - (canvas.y + diamond.y))).toBeLessThan(1.5);
    }

    // Tab from the track column's last control lands on the first diamond: selected, playhead on it (1 + 0.5 s),
    // ring drawn. (On the canvas itself Tab stays the editor's "select the next clip".)
    await page.getByRole("button", { name: "Add track" }).focus();
    await page.keyboard.press("Tab");
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 0.50 s: Scale; easing Linear");
    await expect.poll(() => selectedKeyframe(page)).toEqual({ clipId: id, time: 0.5 });
    await expect.poll(async () => (await snapshot(page)).currentTime).toBeCloseTo(1.5, 2);
    await expect.poll(async () => (await debugKeyframes(page))?.focusedTime).toBe(0.5);

    // Right arrow: one frame later; Shift+Right: ten more. Focus stays on the moved diamond.
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => pointTimes(page, id!)).toEqual([0.533, 2.5]);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => pointTimes(page, id!)).toEqual([0.867, 2.5]);
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 0.87 s: Scale; easing Linear");
    await expect(page.getByRole("status").filter({ hasText: "Keyframe moved to 0.87 s" })).toHaveCount(1);
    // The clip did not move (the arrows were the diamond's, not the clip nudge's).
    expect((await snapshot(page)).clips.find((c) => c.id === id)?.startTime).toBe(1);

    // Undo still reaches the editor shortcuts from a focused diamond: one step per press.
    await waitForSaves(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => pointTimes(page, id!)).toEqual([0.533, 2.5]);

    // Alt+Right: the next diamond.
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 2.50 s: Scale; easing Linear");
    await expect.poll(() => selectedKeyframe(page)).toEqual({ clipId: id, time: 2.5 });

    // Enter opens the easing menu with focus inside; Escape closes it and returns focus to the diamond.
    await page.keyboard.press("Enter");
    const menu = page.getByTestId("keyframe-menu");
    await expect(menu).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=keyframe-menu]") !== null)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 2.50 s: Scale; easing Linear");
    // Clip still selected (Escape stayed in the menu).
    expect(await page.evaluate(() => [...(window as unknown as { __studio: { store: { getState(): { selectedClipIds: Set<string> } } } }).__studio.store.getState().selectedClipIds])).toEqual([id]);

    // Enter, then pick Ease out with the arrows.
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await clipPoints(page, id!))[1].easing).toBe(2);
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 2.50 s: Scale; easing Ease out");

    // Delete removes the keyframe (not the clip) and focus moves to the remaining diamond.
    await page.keyboard.press("Delete");
    await expect.poll(() => pointTimes(page, id!)).toEqual([0.533]);
    expect((await snapshot(page)).clips.some((c) => c.id === id)).toBe(true);
    await expect.poll(() => focusedOption(page)).toBe("Keyframe at 0.53 s: Scale; easing Linear");
    await waitForSaves(page);
});
