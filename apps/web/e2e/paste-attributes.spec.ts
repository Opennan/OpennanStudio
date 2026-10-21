// Phase 10c copy / paste attributes end to end: a styled scene's filter, Adjust, effect, animation, and speed are
// copied with ⌥⌘C (Ctrl+Alt+C), pasted onto another scene with ⌥⌘V and the picker, undone in one step, pasted again
// from the timeline's context menu with Speed unticked, and the result survives a reload.
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, blurFocus, createProject, execute, sceneRects, snapshot, timelineCanvasBox, waitForSaves } from "./helpers";

interface AttrScene {
    id: string;
    visualFilter?: string | null;
    filterIntensity?: number | null;
    adjustmentsJson?: string | null;
    animationJson?: string | null;
    playbackSpeed?: number | null;
    timelinePositionSeconds?: number | null;
    effects?: Array<{ id: string; effectId: string; sceneId: string | null; paramsJson: string | null }> | null;
}

const scene = async (page: Page, id: string): Promise<AttrScene> => ((await snapshot(page)).scenes as unknown as AttrScene[]).find((s) => s.id === id)!;
const clipboardKinds = (page: Page) => page.evaluate(() => (
    (window as unknown as { __studio: { store: { getState(): { attributeClipboard: { kinds: string[] } | null } } } }).__studio.store.getState().attributeClipboard?.kinds ?? null
));
const ANIMATION = JSON.stringify({ in: { id: "zoom_in", duration: 1 } });

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

test("copy a scene's attributes, paste them with the shortcut and the context menu, undo, and reload", async ({ page }) => {
    await createProject(page, "Paste attributes");
    const [a, b] = await twoScenes(page);

    // Scene A: filter, Adjust, an effect, an In animation, and 2× speed.
    expect((await execute(page, { type: "look.set", sceneId: a, filter: "warm", intensity: 0.7, adjustments: { exposure: 0.3, vignette: 0.4 } })).ok).toBe(true);
    expect((await execute(page, { type: "clip.effect.add", sceneId: a, effectId: "fx_rgb_split", params: { amount: 0.8 } })).ok).toBe(true);
    expect((await execute(page, { type: "animation.set", sceneId: a, slot: "in", animationId: "zoom_in", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "speed.set", sceneId: a, speed: 2 })).ok).toBe(true);
    await waitForSaves(page);
    // A's 2× halved it, and B rippled left to about 3 s.
    expect((await scene(page, b)).timelinePositionSeconds).toBeLessThan(3.1);

    // ⌥⌘C on the selected scene copies its attributes.
    await execute(page, { type: "selection.set", sceneId: a });
    await blurFocus(page);
    await page.keyboard.press("Alt+ControlOrMeta+KeyC");
    await expect.poll(() => clipboardKinds(page)).toEqual(["filter", "adjust", "effects", "animation", "speed"]);
    await expect(page.getByText("Copied attributes: Filter, Adjust, Effects, Animation, Speed")).toBeVisible();

    // ⌥⌘V on scene B opens the picker with every copied kind ticked; Paste applies them in one command.
    await execute(page, { type: "selection.set", sceneId: b });
    await blurFocus(page);
    await page.keyboard.press("Alt+ControlOrMeta+KeyV");
    const picker = page.getByRole("dialog", { name: "Paste attributes" });
    await expect(picker).toBeVisible();
    for (const name of ["Filter", "Adjust", "Effects", "Animation", "Speed"]) await expect(picker.getByRole("checkbox", { name })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: "Mask" })).toBeDisabled();
    await picker.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByText("Pasted attributes onto 1 item")).toBeVisible();
    await expect.poll(async () => (await scene(page, b)).playbackSpeed).toBe(2);
    const pasted = await scene(page, b);
    const source = await scene(page, a);
    expect(pasted).toMatchObject({ visualFilter: "warm", filterIntensity: 0.7, adjustmentsJson: source.adjustmentsJson, animationJson: ANIMATION });
    expect(pasted.effects?.map((e) => [e.effectId, e.paramsJson, e.sceneId])).toEqual([["fx_rgb_split", "{\"amount\":0.8}", b]]);
    expect(pasted.effects![0].id).not.toBe(source.effects![0].id);
    await waitForSaves(page);

    // One undo puts scene B back exactly.
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await scene(page, b)).visualFilter ?? "none").toBe("none");
    const undone = await scene(page, b);
    expect(undone.playbackSpeed ?? 1).toBe(1);
    expect(undone.effects ?? []).toEqual([]);
    expect(undone.animationJson ?? null).toBeNull();
    expect(undone.adjustmentsJson ?? null).toBeNull();
    expect((await scene(page, a)).visualFilter).toBe("warm");
    await waitForSaves(page);

    // The timeline's context menu: Paste attributes… on scene B, Speed unticked this time.
    await expect.poll(async () => (await sceneRects(page)).length).toBe(2);
    const box = await timelineCanvasBox(page);
    const rect = (await sceneRects(page)).find((r) => r.id === b)!;
    await page.mouse.click(box.x + rect.x + 30, box.y + rect.y + 20, { button: "right" });
    // The menu row shows its shortcut (the inspector's icon button has the same label without it).
    await page.getByRole("button", { name: /^Paste attributes… (⌥ ⌘|Ctrl Alt) V$/ }).click();
    await expect(picker).toBeVisible();
    await picker.getByRole("checkbox", { name: "Speed" }).uncheck();
    await picker.getByRole("button", { name: "Paste", exact: true }).click();
    await expect.poll(async () => (await scene(page, b)).visualFilter).toBe("warm");
    expect((await scene(page, b)).playbackSpeed ?? 1).toBe(1);
    expect((await scene(page, b)).effects?.map((e) => e.effectId)).toEqual(["fx_rgb_split"]);
    await waitForSaves(page);

    // Persisted: the same fields after a reload; the unticked kind stays remembered for the next paste.
    await page.reload();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(2);
    const reloaded = await scene(page, b);
    expect(reloaded).toMatchObject({ visualFilter: "warm", filterIntensity: 0.7, animationJson: ANIMATION });
    expect(reloaded.playbackSpeed ?? 1).toBe(1);
    expect(reloaded.effects?.map((e) => e.effectId)).toEqual(["fx_rgb_split"]);
    expect(await page.evaluate(() => window.localStorage.getItem("opennan-studio:paste-attributes"))).toBe(JSON.stringify({ excluded: ["speed"] }));
});
