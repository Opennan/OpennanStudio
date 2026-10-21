// The 9b server fixes in Studio (phase 9c), against the fake OpenNan server: a proposal runs by its opaque run request
// at its own price, a price that rose is shown and needs a fresh click; storyboards show their sheets (board and
// inspector); undoing a storyboard puts the scene's earlier shots back on OpenNan.
import { expect, test, type Page } from "@playwright/test";
import { fakeState } from "./fixtures/fake-opennan";
import { directorControl, directorProject, script, send, serverProject } from "./director-helpers";
import { cloudControl, serverIdOf } from "./cloud-helpers";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";

test.afterEach(async () => {
    await directorControl("proposal-price", { bump_usd: 0 }).catch(() => undefined);
    await cloudControl("sheet-views", { unfiltered: false }).catch(() => undefined);
});

const sheetsOf = (page: Page, id: string) => page.evaluate((sceneId) => {
    const scenes = (window as unknown as { __studio: { store: { getState(): { serverScenes: Array<{ id: string; storyboardSheets?: Array<{ imageUrl: string | null; panels: unknown[] }> | null }> } } } }).__studio.store.getState().serverScenes;
    return scenes.find((s) => s.id === sceneId)?.storyboardSheets ?? null;
}, id);

test("a proposal runs by its run request at its own price; a price that rose is shown and runs only on a fresh click", async ({ page }) => {
    const { projectId, sceneA: SCENE_A } = await directorProject(page, "Repriced", { title: false });
    await script([{ text: "I can draw it." }, { proposal: { tool: "generate_storyboard", scene_id: SCENE_A } }]);
    await send(page, "Draw scene 1");
    const proposal = page.getByTestId("director-proposal");
    await expect(proposal).toContainText("≈ $0.31");
    await directorControl("proposal-price", { bump_usd: 0.05 });
    const before = (await fakeState()).requests.length;
    await proposal.getByRole("button", { name: "Run · $0.31" }).click();
    await expect(proposal).toContainText("The price went up to ≈ $0.36, so nothing ran.");
    const runs = (await fakeState()).requests.slice(before).filter((r) => r.method === "POST" && r.path.includes("/proposals/"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.path).toMatch(new RegExp(`^/v1/projects/${serverIdOf(projectId)}/director/turns/turn_[0-9a-f]{24}/proposals/prop_[0-9a-f]{24}/run$`));
    expect((await fakeState()).requests.slice(before).filter((r) => r.method === "POST" && r.path.endsWith("/storyboard"))).toHaveLength(0);
    // Nothing ran on its own; the next click runs the step at the price shown.
    await proposal.getByRole("button", { name: "Run · $0.36" }).click();
    await expect(proposal.getByTestId("director-task")).toContainText("Done · charged $0.360", { timeout: 20_000 });
    const posts = (await fakeState()).requests.slice(before).filter((r) => r.method === "POST" && r.path.endsWith("/storyboard"));
    expect(posts.map((r) => r.path)).toEqual([`/v1/projects/${serverIdOf(projectId)}/scenes/${SCENE_A}/storyboard`]);
});

test("a proposal past its 15 minutes asks to ask the director again and sends nothing", async ({ page }) => {
    const { sceneA: SCENE_A } = await directorProject(page, "Late", { title: false });
    await script([{ proposal: { tool: "generate_storyboard", scene_id: SCENE_A } }]);
    await send(page, "Draw scene 1");
    const proposal = page.getByTestId("director-proposal");
    await expect(proposal.getByRole("button", { name: "Run · $0.31" })).toBeVisible();
    await directorControl("proposal-expire", {});
    const before = (await fakeState()).requests.length;
    await proposal.getByRole("button", { name: "Run · $0.31" }).click();
    await expect(proposal.getByTestId("proposal-expired")).toContainText("ask the director again");
    await expect(proposal.getByRole("button", { name: /^Run/ })).toHaveCount(0);
    expect((await fakeState()).requests.slice(before).filter((r) => r.method === "POST" && r.path.endsWith("/storyboard"))).toHaveLength(0);
});

test("a drawn storyboard shows its sheet and panels on the board and in the scene inspector", async ({ page }) => {
    const { sceneA: SCENE_A } = await directorProject(page, "Sheets", { title: false });
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const board = page.getByTestId("storyboard-board");
    const first = board.getByTestId("storyboard-scene").first();
    await first.getByRole("button", { name: "Draw · $0.31" }).click({ timeout: 15_000 });
    await expect(first).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect.poll(() => sheetsOf(page, SCENE_A), { timeout: 20_000 }).toEqual([expect.objectContaining({ imageUrl: expect.stringContaining("generated.png?sheet=") })]);
    await expect(first.getByTestId("storyboard-sheets").getByRole("button", { name: "Scene 1, storyboard sheet 1" })).toBeVisible();
    await first.getByRole("button", { name: "Scene 1, storyboard sheet 1" }).click();
    const viewer = page.getByRole("dialog", { name: "Scene 1, storyboard sheet 1" });
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Next" }).click();
    const panel = page.getByRole("dialog", { name: "Panel 1 of 3" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    // The scene inspector shows the same storyboard, read only.
    await page.evaluate((id) => (window as unknown as { __studio: { store: { getState(): { selectScene(id: string): void } } } }).__studio.store.getState().selectScene(id), SCENE_A);
    await page.locator("#right-dock-tab-inspector").click();
    const section = page.getByTestId("inspector-storyboard");
    await expect(section).toBeVisible();
    await expect(section).toContainText("3 panels");
    await section.getByRole("button", { name: "Panel 2 of 3" }).click();
    await expect(page.getByTestId("inspector-storyboard-large").locator("img")).toHaveAttribute("alt", "Panel 2 of 3");
});

test("undoing a storyboard puts the scene's earlier shots back on OpenNan; redo draws it again", async ({ page }) => {
    const { projectId, sceneA: SCENE_A } = await directorProject(page, "Undo boards", { title: false });
    const before = (await serverProject(projectId)).scenes.find((s) => s.id === SCENE_A)!.shots_version as string;
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const first = page.getByTestId("storyboard-board").getByTestId("storyboard-scene").first();
    await first.getByRole("button", { name: "Draw · $0.31" }).click({ timeout: 15_000 });
    await expect(first).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect.poll(() => sheetsOf(page, SCENE_A), { timeout: 20_000 }).not.toBeNull();
    const drawn = (await serverProject(projectId)).scenes.find((s) => s.id === SCENE_A)!.shots_version as string;
    expect(drawn).not.toBe(before);
    // The AI step is recorded once its revision arrived (the editor can undo it); ⌘Z takes it back.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __studio: { controller: { historyDepth(): { undo: number } } } }).__studio.controller.historyDepth().undo), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { __studio: { controller: { execute(c: { type: string }): Promise<unknown> } } }).__studio.controller.execute({ type: "history.undo" }));
    await expect.poll(async () => (await serverProject(projectId)).scenes.find((s) => s.id === SCENE_A)!.shots_version, { timeout: 20_000 }).toBe(before);
    expect((await serverProject(projectId)).scenes.find((s) => s.id === SCENE_A)).toMatchObject({ shots: [], storyboard_sheets: [] });
    await expect.poll(() => sheetsOf(page, SCENE_A), { timeout: 20_000 }).toBeNull();
    await expect(first).toHaveAttribute("data-status", "none");
    await page.evaluate(() => (window as unknown as { __studio: { controller: { execute(c: { type: string }): Promise<unknown> } } }).__studio.controller.execute({ type: "history.redo" }));
    await expect.poll(async () => (await serverProject(projectId)).scenes.find((s) => s.id === SCENE_A)!.shots_version, { timeout: 20_000 }).toBe(drawn);
    await expect(first).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
});

test("a storyboard image from another host is never shown or fetched; OpenNan's own panels are (9c.1)", async ({ page }) => {
    const { projectId, sceneA: SCENE_A } = await directorProject(page, "Hosts", { title: false });
    const elsewhere: string[] = [];
    await page.route("https://evil.example/**", (route) => {
        elsewhere.push(route.request().url());
        return route.fulfill({ status: 404, body: "" });
    });
    const ours = `${FAKE_OPENNAN}/files/generated.png`;
    // A server (or anything between) that sends storyboard images from another host: the fake answers them as stored.
    await cloudControl("sheet-views", { unfiltered: true });
    await cloudControl("set-shots", {
        project_id: serverIdOf(projectId), scene_id: SCENE_A, shots: [{ description: "Wide", duration: 3, image_url: "https://evil.example/k.png" }, { description: "Close", duration: 3 }],
        sheets: [{ image_url: "https://evil.example/sheet.png", panels: [{ index: 0, shot_index: 0, image_url: "https://evil.example/p0.png" }, { index: 1, shot_index: 1, image_url: `${ours}?panel=1` }] }],
    });
    await cloudControl("bump", { project_id: serverIdOf(projectId) });
    await expect.poll(() => sheetsOf(page, SCENE_A), { timeout: 20_000 }).toEqual([{ imageUrl: null, panels: [expect.objectContaining({ imageUrl: expect.stringContaining("generated.png?panel=1") })] }]);
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const first = page.getByTestId("storyboard-board").getByTestId("storyboard-scene").first();
    await expect(first).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    // The sheet's own image was elsewhere: no sheet is drawn, only OpenNan's panel.
    await expect(first.getByTestId("storyboard-sheets")).toHaveCount(0);
    await expect(first.locator(".director-panels img")).toHaveCount(1);
    await page.evaluate((id) => (window as unknown as { __studio: { store: { getState(): { selectScene(id: string): void } } } }).__studio.store.getState().selectScene(id), SCENE_A);
    await page.locator("#right-dock-tab-inspector").click();
    await expect(page.getByTestId("inspector-storyboard").locator(".on-storyboard-thumb img")).toHaveCount(1);
    expect(await page.locator('img[src*="evil.example"]').count()).toBe(0);
    expect(elsewhere).toEqual([]);
});
