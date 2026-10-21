// Offline: edits keep working and wait in a queue on disk (IndexedDB); the chip says "Offline (n pending)"; the
// queue survives a reload and drains when OpenNan answers again.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudControl, cloudState, saveToCloud, serverIdOf, syncKind, waitSaved } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test.afterEach(async () => {
    await cloudControl("offline", { mode: "off" });
});

test("an offline queue survives a reload and drains", async ({ page }) => {
    await createProject(page, "Offline edit");
    await signInOpenNan(page);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: "Start" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const projectId = await saveToCloud(page);
    const clipId = (await snapshot(page)).clips[0]!.id;

    await cloudControl("offline", { mode: "drop" });
    await execute(page, { type: "clip.update", clipIds: [clipId], patch: { textContent: "Written offline" } });
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, mediaType: "text", textContent: "Second" } });
    await expect.poll(() => syncKind(page, projectId), { timeout: 20_000 }).toBe("offline");
    await expect(page.getByTestId("sync-chip")).toContainText(/Offline \(\d+ pending\)/);

    // A reload while OpenNan is still unreachable: the queue is on disk.
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __studio?: unknown }).__studio)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await snapshot(page)).clips.length, { timeout: 20_000 }).toBe(2);
    expect((await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))!.clips).toHaveLength(1);

    await cloudControl("offline", { mode: "off" });
    await waitSaved(page, projectId);
    const clips = (await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))!.clips;
    expect(clips.map((c) => c.text_content).sort()).toEqual(["Second", "Written offline"]);
});
