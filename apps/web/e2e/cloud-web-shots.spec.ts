// Shots made on opennan.com stay read only in Studio (phase 9a.1) and the inspector says so, linking to the project on
// opennan.com.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudControl, openEditor, serverIdOf } from "./cloud-helpers";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";
import { sceneRects, snapshot } from "./helpers";

type CloudWindow = { __studioCloud: { backend(): { createProject(input: { name: string }): Promise<{ id: string }> } } };

test("a scene planned on opennan.com shows Made on opennan.com with a link, and its shots are read only", async ({ page }) => {
    await page.goto("/#/");
    await signInOpenNan(page);
    const projectId = await page.evaluate(async () => (await (window as unknown as CloudWindow).__studioCloud.backend().createProject({ name: "Planned on the web" })).id);
    const sceneId = "5b0f7f8e-3f0e-4a8f-9d65-2f1f1d3c0a11";
    await cloudControl("remote-change", { project_id: serverIdOf(projectId), changes: { scenes: { create: [{ id: sceneId, caption: "Opening" }] } } });
    await cloudControl("set-shots", { project_id: serverIdOf(projectId), scene_id: sceneId, shots: [{ index: 0, description: "Wide", duration: 2 }, { index: 1, description: "Close", duration: 3 }] });
    await openEditor(page, projectId);
    await expect.poll(async () => (await sceneRects(page)).length, { timeout: 30_000 }).toBe(1);
    expect(JSON.parse(((await snapshot(page)).scenes[0] as unknown as { shotBreakdown?: string }).shotBreakdown ?? "[]")).toMatchObject([{ prompt: "Wide", readOnly: true }, { prompt: "Close", readOnly: true }]);
    await page.evaluate((id) => (window as unknown as { __studio: { store: { getState(): { selectScene(id: string): void } } } }).__studio.store.getState().selectScene(id), sceneId);
    const badge = page.getByTestId("inspector-web-shots");
    await expect(badge).toContainText("Made on opennan.com — edit shots there");
    const link = badge.getByRole("link", { name: "Open on opennan.com" });
    await expect(link).toHaveAttribute("href", `${FAKE_OPENNAN}/video/${serverIdOf(projectId)}`);
    await expect(link).toHaveAttribute("target", "_blank");
});
