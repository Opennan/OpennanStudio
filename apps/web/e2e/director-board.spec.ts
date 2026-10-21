// The Storyboards board and the Script to video wizard (phase 9b): every paid step priced before it runs, results
// landing on the timeline through sync.
import { expect, test } from "@playwright/test";
import { directorProject, serverProject } from "./director-helpers";

const panelsOf = (page: import("@playwright/test").Page, id: string) => page.evaluate((sceneId) => {
    const scenes = (window as unknown as { __studio: { store: { getState(): { serverScenes: Array<{ id: string; shotBreakdown?: string | null }> } } } }).__studio.store.getState().serverScenes;
    return (JSON.parse(scenes.find((s) => s.id === sceneId)?.shotBreakdown ?? "[]") as Array<{ keyframe_url?: string }>).filter((s) => s.keyframe_url).length;
}, id);

test("the Storyboards board prices each scene and all of them, draws one, and shows its panels", async ({ page }) => {
    const { sceneA: SCENE_A, sceneB: SCENE_B } = await directorProject(page, "Boarded", { title: false });
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const board = page.getByTestId("storyboard-board");
    const scenes = board.getByTestId("storyboard-scene");
    await expect(scenes).toHaveCount(2);
    await expect(scenes.first()).toContainText("No storyboard");
    await expect(board.getByRole("button", { name: "Draw all · $0.62" })).toBeVisible({ timeout: 15_000 });
    await scenes.first().getByRole("button", { name: "Draw · $0.31" }).click();
    await expect(scenes.first()).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect(scenes.first()).toContainText("3 panels");
    await expect.poll(() => panelsOf(page, SCENE_A)).toBe(3);
    expect(await panelsOf(page, SCENE_B)).toBe(0);
    await scenes.first().getByRole("button", { name: "Scene 1, panel 2" }).click();
    await expect(page.getByRole("dialog", { name: "Panel 2 of 3" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
});

test("Script to video: a pasted script becomes subtitles, the plan makes the scenes, storyboards and videos follow", async ({ page }) => {
    test.setTimeout(150_000);
    const { projectId } = await directorProject(page, "From a script", { scenes: false, title: false });
    await page.getByRole("radio", { name: "Script to video" }).click();
    const wizard = page.getByTestId("script-wizard");
    await wizard.getByRole("textbox", { name: "Script" }).fill("Night falls on the town. A car waits under the bridge.");
    await expect(wizard.getByTestId("script-cues")).toHaveText(/2 subtitles/);
    await wizard.getByRole("button", { name: "Save script" }).click();
    await expect(wizard).toContainText("Saved to the project");
    await expect.poll(async () => (await serverProject(projectId)).srt_content).toContain("A car waits under the bridge.");
    await wizard.getByRole("button", { name: "Skip" }).click();
    await wizard.getByRole("textbox", { name: "Style" }).fill("noir");
    await wizard.getByRole("button", { name: "Plan scenes · $0.20" }).click({ timeout: 15_000 });
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { serverScenes: unknown[] } } } }).__studio.store.getState().serverScenes.length), { timeout: 20_000 }).toBe(2);
    await wizard.getByRole("button", { name: "Storyboards" }).click();
    await wizard.getByRole("button", { name: /^Draw all · \$/ }).click({ timeout: 15_000 });
    await expect(wizard.getByTestId("storyboard-scene").filter({ hasText: "3 panels" })).toHaveCount(2, { timeout: 30_000 });
    await wizard.getByRole("button", { name: "Videos", exact: true }).click();
    await wizard.getByRole("button", { name: /^Render 2 scenes · \$/ }).click({ timeout: 15_000 });
    await wizard.getByRole("button", { name: "Review" }).click();
    await expect(wizard.getByTestId("wizard-review")).toHaveText("2 of 2 scenes have a video", { timeout: 30_000 });
});
