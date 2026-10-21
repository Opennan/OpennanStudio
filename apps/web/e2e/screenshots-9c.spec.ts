// Screenshots of phase 9c for docs/theme/phase-9c/ (dark, 1440×900): the Share dialog (options, an active link with its
// views, a new link's confirmation, nothing to show, Export and share in progress, a local project), a proposal whose
// price rose and an expired one, storyboard sheets on the board and in the inspector; plus a check that the Share dialog
// uses theme greys only. SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-9c.spec.ts --workers=1.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject } from "./helpers";
import { ROOT } from "./motion-helpers";
import { cloudControl, serverIdOf } from "./cloud-helpers";
import { directorControl, directorProject, script, send } from "./director-helpers";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";

const OUT = path.join(ROOT, "docs", "theme", "phase-9c");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-9c");
test.use({ colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));
test.afterEach(async () => {
    await directorControl("proposal-price", { bump_usd: 0 }).catch(() => undefined);
    await cloudControl("latency", { ms: 0 }).catch(() => undefined);
});

const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

async function colours(page: Page, selector: string): Promise<string[]> {
    return page.evaluate((sel) => {
        const out = new Set<string>();
        for (const root of document.querySelectorAll(sel)) {
            for (const el of [root, ...root.querySelectorAll("*")]) {
                const style = getComputedStyle(el);
                for (const value of [style.color, style.backgroundColor, style.borderTopColor]) {
                    const m = /rgba?\(([^)]+)\)/.exec(value);
                    if (!m) continue;
                    const [r, g, b, a = "1"] = m[1]!.split(",").map((s) => s.trim());
                    if (Number(a) === 0) continue;
                    out.add(`${r},${g},${b}`);
                }
            }
        }
        return [...out];
    }, selector);
}

/** Greys, plus the destructive red a Turn off button uses. */
const allowed = (rgb: string) => {
    const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 24 || r > g + 40;
};

async function withPicture(projectId: string): Promise<void> {
    await cloudControl("remote-change", { project_id: serverIdOf(projectId), changes: { scenes: { create: [{ id: crypto.randomUUID(), start_image_url: `${FAKE_OPENNAN}/files/generated.png` }] } } });
}

test("the Share dialog: options, an active link, a new link, nothing to show, Export and share", async ({ page }) => {
    const { projectId } = await directorProject(page, "Night drive");
    await page.getByTestId("topbar-share").click();
    const dialog = page.getByRole("dialog", { name: "Share" });
    await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "none");
    await shot(page, "share-create");
    expect((await colours(page, ".share-dialog")).filter((c) => !allowed(c))).toEqual([]);
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByTestId("share-nothing")).toBeVisible();
    await shot(page, "share-nothing-to-show");
    // Export and share, held at the upload so its steps show.
    await cloudControl("latency", { ms: 2_500, path_prefix: "/u/" });
    await dialog.getByRole("button", { name: "Export and share" }).click();
    await expect(dialog.getByTestId("share-progress")).toHaveAttribute("data-step", "upload", { timeout: 60_000 });
    await shot(page, "share-exporting");
    await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "active", { timeout: 60_000 });
    await cloudControl("latency", { ms: 0 });
    const token = (await (await fetch(`${FAKE_OPENNAN}/__test/cloud/state`)).json() as { shares: Array<{ token: string }> }).shares.at(-1)!.token;
    await fetch(`${FAKE_OPENNAN}/v1/shares/${token}`);
    await fetch(`${FAKE_OPENNAN}/v1/shares/${token}`);
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("topbar-share").click();
    await expect(dialog.getByTestId("share-views")).toContainText("2 views");
    await shot(page, "share-active");
    expect((await colours(page, ".share-dialog")).filter((c) => !allowed(c))).toEqual([]);
    await dialog.getByRole("button", { name: "New link" }).click();
    await shot(page, "share-new-link");
    await dialog.getByRole("button", { name: "Keep" }).click();
    void projectId;
});

test("a local project's Share", async ({ page }) => {
    await page.goto("/#/");
    await createProject(page, "Local only");
    await page.getByTestId("topbar-share").click();
    await expect(page.getByTestId("share-local")).toBeVisible();
    await shot(page, "share-local-project");
});

test("a proposal whose price rose, and an expired one", async ({ page }) => {
    const { sceneA, sceneB } = await directorProject(page, "Repriced");
    await script([{ text: "I can draw both scenes." }, { proposal: { tool: "generate_storyboard", scene_id: sceneA } }, { proposal: { tool: "generate_storyboard", scene_id: sceneB } }]);
    await send(page, "Draw the scenes");
    const proposals = page.getByTestId("director-proposal");
    await expect(proposals).toHaveCount(2);
    await directorControl("proposal-price", { bump_usd: 0.05 });
    await proposals.first().getByRole("button", { name: "Run · $0.31" }).click();
    await expect(proposals.first()).toContainText("The price went up");
    await directorControl("proposal-expire", {});
    await proposals.nth(1).getByRole("button", { name: "Run · $0.31" }).click();
    await expect(proposals.nth(1).getByTestId("proposal-expired")).toBeVisible();
    await shot(page, "proposal-price-changed-and-expired");
});

test("storyboard sheets on the board and in the inspector", async ({ page }) => {
    const { sceneA } = await directorProject(page, "Sheets", { title: false });
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const first = page.getByTestId("storyboard-board").getByTestId("storyboard-scene").first();
    await first.getByRole("button", { name: "Draw · $0.31" }).click({ timeout: 15_000 });
    await expect(first.getByTestId("storyboard-sheets")).toBeVisible({ timeout: 20_000 });
    await shot(page, "storyboard-sheets");
    await page.evaluate((id) => (window as unknown as { __studio: { store: { getState(): { selectScene(id: string): void } } } }).__studio.store.getState().selectScene(id), sceneA);
    await page.locator("#right-dock-tab-inspector").click();
    await expect(page.getByTestId("inspector-storyboard")).toBeVisible();
    await page.getByTestId("inspector-storyboard").getByRole("button", { name: "Panel 2 of 3" }).click();
    await shot(page, "inspector-storyboard");
});
