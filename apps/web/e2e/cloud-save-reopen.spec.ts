// Save to OpenNan, then open the cloud project in a fresh browser (another device): the edit history, the media
// (downloaded into that browser's cache) and the Studio-only fields all arrive. Local projects stay local: the
// saved project leaves the Local tab and appears in the Cloud tab.
import { expect, test } from "@playwright/test";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { cloudState, openEditor, saveToCloud, serverIdOf } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("save a project to OpenNan and reopen it in a fresh browser", async ({ page, browser }) => {
    await createProject(page, "Trip edit");
    await signInOpenNan(page);
    await importFixtures(page, ["testsrc-6s.webm"]);
    const sceneId = await addToTimeline(page, "testsrc-6s.webm", "scene");
    await execute(page, { type: "speed.set", sceneId, speed: 2 });
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0.5, endTime: 2.5, mediaType: "text", textContent: "Hello cloud" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const before = await snapshot(page);

    const projectId = await saveToCloud(page);
    const server = (await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))!;
    expect(server.name).toBe("Trip edit");
    expect(server.scenes).toHaveLength(1);
    expect(server.clips.map((c) => c.text_content)).toEqual(["Hello cloud"]);

    await page.goto("/#/");
    await page.getByRole("tab", { name: "On this device" }).click();
    await expect(page.getByRole("list", { name: "Projects" }).getByText("Trip edit")).toHaveCount(0);
    await page.getByRole("tab", { name: "OpenNan cloud" }).click();
    await expect(page.getByTestId("cloud-list").getByText("Trip edit")).toBeVisible();

    const context = await browser.newContext();
    const other = await context.newPage();
    await other.goto("/#/");
    await signInOpenNan(other);
    await openEditor(other, projectId);
    await expect.poll(async () => (await snapshot(other)).project?.name, { timeout: 30_000 }).toBe("Trip edit");
    const seen = await snapshot(other);
    expect(seen.clips.map((c) => (c as unknown as { textContent: string }).textContent)).toEqual(["Hello cloud"]);
    expect(seen.scenes.map((s) => s.id)).toEqual(before.scenes.map((s) => s.id));
    expect((seen.scenes[0] as unknown as { playbackSpeed: number }).playbackSpeed).toBe(2);
    // The other browser downloads the video into its own cache and plays it from there.
    await expect.poll(async () => (await snapshot(other)).scenes[0]!.sourceVideoUrl, { timeout: 30_000 }).toMatch(/^opennan-local:\/\/media\/c-/);
    await context.close();
});
