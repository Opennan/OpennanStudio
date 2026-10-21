// The AI surface in the editor (phase 11): the inspector AI tab runs a paid tool from a button that shows "≈ $x · Run"
// and the refund note, the AI job tray follows it to "Done" with its cost; the clip menu's AI group lists tools with
// their prices (Remove background enabled); the library's AI tab opens the generator in its mode.
import { expect, test } from "@playwright/test";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, sceneRects, snapshot, timelineCanvasBox } from "./helpers";

test("inspector AI tab: priced button, refund note, job tray to Done with the cost, result on the timeline", async ({ page }) => {
    await createProject(page, "AI tab");
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm"]);
    const sceneId = await addToTimeline(page, "clip-360p.webm", "scene");
    await execute(page, { type: "selection.set", sceneIds: [sceneId], sceneId });
    await page.getByTestId("inspector-tab-ai").click();
    const section = page.getByTestId("ai-section-voice-isolation");
    const run = section.getByRole("button", { name: /^Run, about \$0\.130$/ });
    await expect(run).toHaveText("≈ $0.130 · Run");
    await expect(section).toContainText("Charged when it finishes. Refunded if it fails.");
    await run.click();
    const tray = page.getByTestId("ai-job-tray");
    await expect(tray).toContainText("Isolate voice");
    await expect(tray).toContainText("Done", { timeout: 30_000 });
    await expect(tray).toContainText("$0.13 charged");
    expect((await snapshot(page)).clips.filter((c) => c.trackType === "audio")).toHaveLength(1);
});

test("clip menu: an AI group with prices; Remove background runs; the library AI tab opens the voice generator", async ({ page }) => {
    await createProject(page, "AI menu");
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm"]);
    const sceneId = await addToTimeline(page, "clip-360p.webm", "scene");
    await expect.poll(async () => (await sceneRects(page)).length).toBe(1);
    const box = await timelineCanvasBox(page);
    const rect = (await sceneRects(page)).find((r) => r.id === sceneId)!;
    await page.mouse.click(box.x + rect.x + 30, box.y + rect.y + 20, { button: "right" });
    const group = page.getByTestId("ctx-ai-group");
    await expect(group).toBeVisible();
    const removeBackground = group.getByTestId("ctx-ai-remove-background");
    await expect(removeBackground).toBeEnabled();
    await expect(removeBackground).toContainText("≈ $0.011");
    await expect(group.getByTestId("ctx-ai-voice-isolation")).toContainText("≈ $0.130");
    await removeBackground.click();
    await expect(page.getByTestId("ai-job-tray")).toContainText("Done", { timeout: 60_000 });
    expect((await snapshot(page)).clips.filter((c) => c.trackType === "video")).toHaveLength(1);

    await page.getByTestId("editor-library").getByRole("tab", { name: "AI" }).click();
    await page.getByTestId("ai-tile-voice").click();
    const dialog = page.getByRole("dialog", { name: "Generate" });
    await expect(dialog.getByRole("radio", { name: "Voice" })).toHaveAttribute("aria-checked", "true");
});
