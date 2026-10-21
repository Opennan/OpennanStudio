// A real conflict: a clip deleted on another device while this one edits it. The edit can't apply, so the chip
// shows Conflict with the edit listed; "Keep my version as a copy" makes a local project from the version before.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudControl, saveToCloud, serverIdOf, syncKind } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("a clip deleted elsewhere: Conflict, then keep my version as a copy", async ({ page }) => {
    await createProject(page, "Conflict demo");
    await signInOpenNan(page);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: "Mine" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const projectId = await saveToCloud(page);
    const clipId = (await snapshot(page)).clips[0]!.id;

    await cloudControl("delete-entity", { project_id: serverIdOf(projectId), kind: "clip", id: clipId });
    await execute(page, { type: "clip.update", clipIds: [clipId], patch: { textContent: "My last edit" } });
    await expect.poll(() => syncKind(page, projectId), { timeout: 20_000 }).toBe("conflict");
    const chip = page.getByTestId("sync-chip");
    await expect(chip).toContainText("Conflict");
    await chip.click();
    const popover = page.getByRole("dialog", { name: "Sync status" });
    await expect(popover.getByRole("list", { name: "Edits not applied" })).toContainText("deleted on another device");
    await popover.getByRole("button", { name: "Keep my version as a copy" }).click();
    const link = popover.getByRole("link", { name: /\(my version\)$/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect.poll(async () => ((await snapshot(page)).clips[0] as unknown as { textContent: string } | undefined)?.textContent, { timeout: 20_000 }).toBe("My last edit");
});
