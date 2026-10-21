// Share links (phase 9c), against the fake OpenNan server: a cloud project's view-only link is created with its
// options, copied (the checked link only), counted when someone views it, replaced by a new one (the old one stops at
// once) and turned off; a project with nothing to show is exported, uploaded with its id, set as the project's video
// and shared; a local project asks to be saved to OpenNan and sends nothing.
import { expect, test, type Page } from "@playwright/test";
import { createProject } from "./helpers";
import { directorProject } from "./director-helpers";
import { cloudState, serverIdOf } from "./cloud-helpers";
import { FAKE_OPENNAN, fakeState } from "./fixtures/fake-opennan";

interface ShareState { id: string; project_id: string; token: string; allow_download: boolean; revoked_at: string | null; views: number; expires_at: string }

async function shares(projectId: string): Promise<ShareState[]> {
    const state = (await (await fetch(`${FAKE_OPENNAN}/__test/cloud/state`)).json()) as { shares: ShareState[] };
    return state.shares.filter((s) => s.project_id === serverIdOf(projectId));
}

async function openShare(page: Page) {
    await page.getByTestId("topbar-share").click();
    const dialog = page.getByRole("dialog", { name: "Share" });
    await expect(dialog).toBeVisible();
    return dialog;
}

test("creates a view-only link with its options, copies it, counts its views, makes a new one and turns it off", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:4318" });
    const { projectId } = await directorProject(page, "Shared trip", { title: false });
    // A scene with a picture is something to show.
    await fetch(`${FAKE_OPENNAN}/__test/cloud/remote-change`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: serverIdOf(projectId), changes: { scenes: { create: [{ id: crypto.randomUUID(), start_image_url: `${FAKE_OPENNAN}/files/generated.png` }] } } }),
    });
    const dialog = await openShare(page);
    await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "none");
    await dialog.getByRole("combobox", { name: /Link works for/ }).selectOption("7");
    await dialog.getByRole("checkbox", { name: /Allow download/ }).check();
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "active");
    const [link] = await shares(projectId);
    expect(link).toMatchObject({ allow_download: true, revoked_at: null, views: 0 });
    expect(Math.round((Date.parse(link!.expires_at) - Date.now()) / 86_400_000)).toBe(7);
    const url = `${FAKE_OPENNAN}/s/${link!.token}`;
    await expect(dialog.getByRole("textbox", { name: "View-only link" })).toHaveValue(url);
    await expect(dialog.getByTestId("share-link")).toContainText("Viewers can download");
    await expect(dialog.getByTestId("share-views")).toContainText("Not viewed yet");
    await dialog.getByTestId("share-copy").click();
    await expect(dialog.getByTestId("share-copy")).toContainText("Link copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    // The options are remembered on this device; the token is never stored.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("opennan-studio:share-options") ?? "null"))).toEqual({ days: 7, allowDownload: true });
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(link!.token);

    // Someone watches it: the dialog shows the view next time it opens.
    const view = await fetch(`${FAKE_OPENNAN}/v1/shares/${link!.token}`);
    expect(view.status).toBe(200);
    expect(view.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await dialog.getByRole("button", { name: "Close" }).click();
    const again = await openShare(page);
    await expect(again.getByTestId("share-views")).toContainText("1 view");

    // A new link: the old one stops at once.
    await again.getByRole("button", { name: "New link" }).click();
    await again.getByRole("button", { name: "Make new link" }).click();
    await expect.poll(async () => (await shares(projectId)).filter((s) => s.revoked_at === null).length).toBe(1);
    const fresh = (await shares(projectId)).find((s) => s.revoked_at === null)!;
    expect(fresh.token).not.toBe(link!.token);
    await expect(again.getByRole("textbox", { name: "View-only link" })).toHaveValue(`${FAKE_OPENNAN}/s/${fresh.token}`);
    expect((await fetch(`${FAKE_OPENNAN}/v1/shares/${link!.token}`)).status).toBe(410);

    // Turn it off.
    await again.getByRole("button", { name: "Turn off", exact: true }).click();
    await again.getByRole("button", { name: "Turn off link" }).click();
    await expect(again.getByTestId("share-dialog")).toHaveAttribute("data-state", "none");
    expect((await shares(projectId)).every((s) => s.revoked_at !== null)).toBe(true);
    expect((await fetch(`${FAKE_OPENNAN}/v1/shares/${fresh.token}`)).status).toBe(410);
    await again.getByText(/Earlier links/).click();
    await expect(again.locator(".share-earlier li")).toHaveCount(2);
});

test("a project with nothing to show is exported, uploaded with its id, set as its video and shared (progress, then the link)", async ({ page }) => {
    test.setTimeout(150_000);
    // Scenes with words only: something to export, nothing OpenNan can show yet.
    const { projectId } = await directorProject(page, "Export then share");
    const dialog = await openShare(page);
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByTestId("share-nothing")).toContainText("Nothing to show yet");
    const before = (await fakeState()).requests.length;
    await dialog.getByRole("button", { name: "Export and share" }).click();
    await expect(dialog.getByTestId("share-progress")).toBeVisible();
    await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "active", { timeout: 120_000 });
    const requests = (await fakeState()).requests.slice(before);
    const upload = requests.find((r) => r.method === "POST" && r.path === "/v1/uploads");
    expect(upload).toBeTruthy();
    const project = (await cloudState()).projects.find((p) => p.id === serverIdOf(projectId)) as unknown as { final_video_url: string | null };
    expect(project.final_video_url).toMatch(new RegExp(`^${FAKE_OPENNAN.replace(/[.]/g, "\\.")}/files/`));
    const asset = (await cloudState()).assets.find((a) => a.media_url === project.final_video_url)!;
    expect(asset.project_ids).toEqual([serverIdOf(projectId)]);
    const [link] = await shares(projectId);
    const shown = (await (await fetch(`${FAKE_OPENNAN}/v1/shares/${link!.token}`)).json()) as { video: { url: string } | null };
    expect(shown.video?.url).toContain(project.final_video_url!);
    // The share export never reaches the Export dialog as a download.
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Export video" }).getByRole("button", { name: "Export MP4" })).toBeVisible();
});

test("a local project's Share asks to save it to OpenNan and calls nothing", async ({ page }) => {
    await page.goto("/#/");
    await createProject(page, "Local only");
    const before = (await fakeState()).requests.length;
    const dialog = await openShare(page);
    await expect(dialog.getByTestId("share-local")).toContainText("Sharing needs a cloud project");
    await expect(dialog.getByRole("button", { name: "Save to OpenNan" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    expect((await fakeState()).requests.slice(before)).toEqual([]);
});
