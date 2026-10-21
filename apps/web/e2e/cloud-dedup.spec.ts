// Dedup: the same file in two projects goes up once. The second Save to OpenNan asks with the file's SHA-256 and the
// server answers "deduplicated" — no bytes are sent again.
import { expect, test } from "@playwright/test";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { cloudState, saveToCloud } from "./cloud-helpers";
import { createProject } from "./helpers";

test("the same file in two projects is uploaded once", async ({ page }) => {
    await createProject(page, "Dedup one");
    await signInOpenNan(page);
    await importFixtures(page, ["click-120bpm.wav"]);
    const before = await cloudState();
    await saveToCloud(page);
    await createProject(page, "Dedup two");
    await importFixtures(page, ["click-120bpm.wav"]);
    await saveToCloud(page);
    const after = await cloudState();
    const newUploads = after.uploads.slice(before.uploads.length);
    expect(newUploads).toHaveLength(1);
    expect(newUploads[0]).toMatchObject({ scope: "account", completed: true });
    expect(newUploads[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const asset = after.assets.find((a) => a.sha256 === newUploads[0]!.sha256)!;
    expect(asset.project_ids.length).toBe(2);
});
