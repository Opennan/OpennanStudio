// The on-device cloud store follows the account's stable id (phase 9a.1): a browser that used cloud projects while
// the server sent no account_id keeps its records under the email; once /v1/account sends the id, the records move to
// the id's store before anything reads them, and the cloud project opens with its queue and working copy intact.
import { expect, test, type Page } from "@playwright/test";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { openEditor, saveToCloud, waitSaved } from "./cloud-helpers";
import { FAKE_OPENNAN, fakeControl } from "./fixtures/fake-opennan";
import { createProject, execute, snapshot } from "./helpers";

/** The account prefixes of the keys in the cloud IndexedDB store. */
async function storeAccounts(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("opennan-studio-cloud", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
            const request = db.transaction("kv", "readonly").objectStore("kv").getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return [...new Set(keys.map((key) => String(key).split("\u0000")[0]!))].sort();
    });
}

test("cloud state kept under the email moves to the account id once the server sends it", async ({ page }) => {
    await fakeControl("account?id=none");
    try {
        await createProject(page, "Moves with the id");
        await signInOpenNan(page);
        await importFixtures(page, ["testsrc-6s.webm"]);
        const projectId = await saveToCloud(page);
        await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "text", textContent: "Before the id" } });
        await waitSaved(page, projectId);
        expect(await storeAccounts(page)).toEqual(["ada@example.com"]);

        await fetch(`${FAKE_OPENNAN}/__test/account`, { method: "POST" });
        await page.goto("/#/");
        await page.reload();
        await openEditor(page, projectId);
        await expect.poll(async () => (await snapshot(page)).clips.map((c) => (c as unknown as { textContent: string }).textContent), { timeout: 30_000 }).toEqual(["Before the id"]);
        await waitSaved(page, projectId);
        await expect.poll(() => storeAccounts(page)).toEqual(["id:usr_ada_7f3k"]);
    } finally {
        await fetch(`${FAKE_OPENNAN}/__test/account`, { method: "POST" });
    }
});
