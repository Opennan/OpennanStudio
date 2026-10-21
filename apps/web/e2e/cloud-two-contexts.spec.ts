// Two browsers edit one cloud project at once: each edit is a field-level changeset; the second one meets a 412,
// rebases onto the first and goes through, so both edits stand on the server and in both editors.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudState, openEditor, saveToCloud, serverIdOf, waitSaved } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("two browsers editing one cloud project: both edits stand (rebase)", async ({ page, browser }) => {
    await createProject(page, "Shared edit");
    await signInOpenNan(page);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: "First" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const projectId = await saveToCloud(page);
    const clipId = (await snapshot(page)).clips[0]!.id;

    const context = await browser.newContext();
    const other = await context.newPage();
    await other.goto("/#/");
    await signInOpenNan(other);
    await openEditor(other, projectId);
    await expect.poll(async () => (await snapshot(other)).clips.length, { timeout: 30_000 }).toBe(1);

    // Both edit before either has seen the other's change.
    await Promise.all([
        execute(page, { type: "clip.update", clipIds: [clipId], patch: { opacity: 0.4 } }),
        execute(other, { type: "clip.update", clipIds: [clipId], patch: { textContent: "Bonjour" } }),
    ]);
    await waitSaved(page, projectId);
    await waitSaved(other, projectId);
    await expect.poll(async () => {
        const row = (await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))!.clips[0]!;
        return [row.opacity, row.text_content];
    }, { timeout: 20_000 }).toEqual([0.4, "Bonjour"]);
    for (const p of [page, other]) {
        await expect.poll(async () => {
            const clip = (await snapshot(p)).clips[0] as unknown as { opacity: number; textContent: string };
            return [clip.opacity, clip.textContent];
        }, { timeout: 20_000 }).toEqual([0.4, "Bonjour"]);
    }
    await context.close();
});
