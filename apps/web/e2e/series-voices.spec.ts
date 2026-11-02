// Real local editor, IndexedDB and localStorage; the account voice list comes from the fixture API. No paid generation.
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, snapshot, waitForSaves } from "./helpers";
import { signInOpenNan } from "./ai-helpers";

const STORY = { version: 1, title: "Rain", style: "watercolour", music: "piano", characters: [
    { id: "theo", name: "Theo", look: "ginger curls" }, { id: "mae", name: "Mae", look: "teal coat" },
], shots: [{ id: "s1", cast: ["theo", "mae"], frame: "A rainy street", motion: "Theo waves", seconds: 5 }] };
async function open(page: Page) {
    await page.getByTestId("editor-library").getByRole("tab", { name: "AI" }).click();
    await page.getByTestId("ai-tile-story-film").click();
    await page.getByRole("button", { name: "Voices", exact: true }).click();
    return page.getByTestId("series-voices");
}
test("assigns an owned clone, preserves multiline typing, validates timing, reopens, reuses the next episode cast and saves silence", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await createProject(page, "Series episode 1");
    await signInOpenNan(page);
    expect((await execute(page, { type: "project.update", patch: { storyFilmJson: JSON.stringify(STORY) } })).ok).toBe(true);
    let panel = await open(page);
    const voice = panel.getByLabel("Voice for Theo");
    await expect(voice.locator("option", { hasText: "Theo's voice" })).toHaveCount(1);
    await voice.selectOption("opennan:vc_test_theo");
    await panel.getByLabel("Speech in this shot").selectOption("dialogue");
    const words = panel.getByLabel("Spoken words");
    await words.fill("Hello."); await words.press("End"); await words.press("Enter"); await words.pressSequentially("Are you listening?");
    await expect(words).toBeFocused();
    await expect(words).toHaveValue("Hello.\nAre you listening?");
    await panel.getByLabel("End (seconds)").fill("9");
    await panel.getByRole("button", { name: "Save voices and dialogue" }).click();
    await expect(panel.getByRole("alert")).toContainText("within the shot");
    await panel.getByLabel("End (seconds)").fill("4");
    await panel.getByRole("button", { name: "Save voices and dialogue" }).click();
    await expect(panel.getByRole("status")).toHaveText("Voices and dialogue saved");
    await panel.getByLabel("Series ID", { exact: true }).fill("rain");
    await panel.getByLabel("Series name", { exact: true }).fill("Rain Check");
    await panel.getByRole("button", { name: "Save cast for future episodes" }).click();
    await expect(panel.getByLabel("Saved series")).toHaveValue("rain");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await waitForSaves(page); await page.reload();
    panel = await open(page);
    await expect(panel.getByLabel("Voice for Theo")).toHaveValue("opennan:vc_test_theo");
    await expect(panel.getByLabel("Spoken words")).toHaveValue("Hello.\nAre you listening?");
    await page.screenshot({ path: "/tmp/opennan-series-voices.png", fullPage: true });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByTestId("editor-library").getByRole("tab", { name: "Media", exact: true }).click();
    await createProject(page, "Series episode 2");
    await execute(page, { type: "project.update", patch: { storyFilmJson: JSON.stringify({ ...STORY, title: "Episode 2" }) } });
    panel = await open(page);
    await panel.getByLabel("Saved series").selectOption("rain");
    await panel.getByRole("button", { name: "Use this cast" }).click();
    await expect(panel.getByLabel("Voice for Theo")).toHaveValue("opennan:vc_test_theo");
    await expect(panel.getByLabel("Speech in this shot")).toHaveValue("unassigned");
    await panel.getByLabel("Speech in this shot").selectOption("silent");
    await panel.getByRole("button", { name: "Save voices and dialogue" }).click();
    await expect(panel.getByRole("status")).toHaveText("Voices and dialogue saved");
    const final = JSON.parse((await snapshot(page)).project!.storyFilmJson!);
    expect(final.series.id).toBe("rain"); expect(final.shots[0].dialogue).toEqual([]);
    expect(errors).toEqual([]);
});
