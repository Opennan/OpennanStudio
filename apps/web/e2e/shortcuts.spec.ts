// Keyboard shortcuts through the real document listener (src/editor/shortcuts).
import { expect, test } from "@playwright/test";
import { FIXTURE_VIDEO, blurFocus, createProject, execute, snapshot, waitForSaves } from "./helpers";

const textClips = async (page: Parameters<typeof snapshot>[0]) => (await snapshot(page)).clips.filter((c) => c.trackType === "text").length;
const settled = (id: string) => !/^(temp-|optimistic-)/.test(id);

test.beforeEach(async ({ page }) => {
    await createProject(page, "Keys");
    await blurFocus(page);
});

test("T adds a text clip; Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo it", async ({ page }) => {
    await page.keyboard.press("t");
    await expect.poll(() => textClips(page)).toBe(1);
    await expect.poll(async () => (await snapshot(page)).clips.every((c) => settled(c.id))).toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => textClips(page)).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => textClips(page)).toBe(1);
});

test("I and O set the marker range; Ctrl/Cmd+A then Delete clears the timeline", async ({ page }) => {
    await page.keyboard.press("t");
    await expect.poll(() => textClips(page)).toBe(1);
    await expect.poll(async () => (await snapshot(page)).clips.every((c) => settled(c.id))).toBe(true);
    await page.keyboard.press("i");
    await execute(page, { type: "playhead.seek", seconds: 2 });
    await page.keyboard.press("o");
    await expect.poll(async () => (await snapshot(page)).markers.map((m) => m.label)).toEqual(["In", "Out"]);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect.poll(() => textClips(page)).toBe(0);
});

test("the top bar's canvas preset and rename are not undo steps, and both persist", async ({ page }) => {
    await page.keyboard.press("t");
    await expect.poll(() => textClips(page)).toBe(1);
    await expect.poll(async () => (await snapshot(page)).clips.every((c) => settled(c.id))).toBe(true);

    await page.getByRole("radiogroup", { name: "Canvas" }).getByRole("radio", { name: "9:16 Vertical" }).check();
    await expect(page.getByRole("button", { name: "Preview ratio" })).toContainText("9:16");
    const title = page.getByRole("textbox", { name: "Project name" });
    await title.fill("Renamed");
    await title.press("Enter");
    await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Renamed");
    expect((await snapshot(page)).project?.aspectRatio).toBe("9:16");

    // Only the text clip is undone (Task 4): project.update is not a backend undo step.
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => textClips(page)).toBe(0);
    expect((await snapshot(page)).project).toMatchObject({ name: "Renamed", aspectRatio: "9:16" });
    await waitForSaves(page);

    await page.reload();
    await expect(page.getByRole("button", { name: "Preview ratio" })).toContainText("9:16");
    await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue("Renamed");
    await expect.poll(() => textClips(page)).toBe(0);
});

test("Delete removes one selected V1 scene, and Ctrl/Cmd+Z restores exactly that one", async ({ page }) => {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").first();
    await expect(tile).toContainText("0:06");
    const add = tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" });
    await tile.hover();
    await add.click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    await tile.hover();
    await add.click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(2);
    await expect.poll(async () => (await snapshot(page)).scenes.every((s) => settled(s.id))).toBe(true);
    const ids = (await snapshot(page)).scenes.map((s) => s.id);

    // The keymap runs first and hands a selected scene to the timeline's delete-selection request;
    // the canvas listener sees defaultPrevented and does not delete a second time.
    await execute(page, { type: "selection.set", sceneId: ids[0] });
    await blurFocus(page);
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await snapshot(page)).scenes.map((s) => s.id)).toEqual([ids[1]]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await snapshot(page)).scenes.map((s) => s.id).sort()).toEqual([...ids].sort());
});
