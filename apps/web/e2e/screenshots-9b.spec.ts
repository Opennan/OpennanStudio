// Screenshots of phase 9b (the AI director) for docs/theme/phase-9b/ (dark, 1440×900): the AI tab (price line, a
// running turn, a finished turn with its charge and Undo AI, a proposal and its task, another device's turn), the
// local-project prompt, the Storyboards board and the Script to video wizard; plus a check that the AI tab uses theme
// greys only. SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-9b.spec.ts --workers=1.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject } from "./helpers";
import { ROOT } from "./motion-helpers";
import { serverIdOf } from "./cloud-helpers";
import { directorControl, directorProject, openAiTab, script, send } from "./director-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-9b");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-9b");
test.use({ colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));
test.afterEach(async () => {
    await directorControl("hold-tasks", undefined, "?on=0").catch(() => undefined);
    await directorControl("release").catch(() => undefined);
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

/** Greys, plus the destructive red refusals use and the success green of "Saved". */
const allowed = (rgb: string) => {
    const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 24 || r > g + 40 || g > r + 30;
};

test("the AI tab: price, a running turn, a finished turn, a proposal and its task", async ({ page }) => {
    const { titleClip, sceneA } = await directorProject(page, "Night drive");
    await expect(page.getByTestId("director-price")).toHaveText("≈ $0.08 typical · holds up to $0.43");
    await shot(page, "ai-tab");
    await script([
        { text: "Looking at your project: two scenes and a title." },
        { tool: { name: "read_project", label: "Read the project", summary: "2 scenes, 1 clip" } },
        { delay: 2_500 },
        { edit: { label: "Retitle", changes: { clips: { patch: [{ id: titleClip, text_content: "Night drive" }] } } } },
        { text: "Done: the title now says Night drive. Want a storyboard for scene 1?" },
        { proposal: { tool: "generate_storyboard", scene_id: sceneA } },
    ]);
    await send(page, "Change the title to Night drive and suggest a storyboard");
    await expect(page.getByTestId("director-messages")).toContainText("Looking at your project");
    await shot(page, "ai-turn-running");
    await expect(page.getByTestId("director-proposal")).toContainText("≈ $0.31", { timeout: 15_000 });
    await expect(page.getByTestId("director-charge").last()).toHaveText(/Charged/);
    await shot(page, "ai-turn-finished");
    await directorControl("hold-tasks", undefined, "?on=1");
    await page.getByTestId("director-proposal").getByRole("button", { name: "Run · $0.31" }).click();
    await expect(page.getByTestId("director-proposal").getByTestId("director-task")).toBeVisible();
    await shot(page, "ai-proposal-running");
    const bad = (await colours(page, ".director")).filter((rgb) => !allowed(rgb));
    expect(bad).toEqual([]);
});

test("another device's turn, the local prompt", async ({ page }) => {
    const { projectId } = await directorProject(page, "Shared", { title: false });
    await directorControl("hold", undefined, `?project_id=${serverIdOf(projectId)}`);
    await page.reload();
    await openAiTab(page);
    await expect(page.getByTestId("director-busy")).toBeVisible();
    await shot(page, "ai-busy-elsewhere");
    await page.goto("/#/");
    await createProject(page, "Stays local");
    await openAiTab(page);
    await expect(page.getByTestId("director-local")).toBeVisible();
    await shot(page, "ai-local-project");
});

test("the Storyboards board and the Script to video wizard", async ({ page }) => {
    await directorProject(page, "Storyboarded", { title: false });
    await page.getByRole("radio", { name: "Storyboards" }).click();
    const scenes = page.getByTestId("storyboard-scene");
    await scenes.first().getByRole("button", { name: "Draw · $0.31" }).click({ timeout: 15_000 });
    await expect(scenes.first()).toContainText("3 panels", { timeout: 20_000 });
    await shot(page, "storyboards");
    await page.getByRole("radio", { name: "Script to video" }).click();
    await page.getByRole("textbox", { name: "Script" }).fill("Night falls on the town. A car waits under the bridge. Headlights cut through the rain.");
    await expect(page.getByTestId("script-cues")).toHaveText(/3 subtitles/);
    await shot(page, "script-to-video");
    await page.getByTestId("script-wizard").getByRole("button", { name: "Videos", exact: true }).click();
    await expect(page.getByRole("button", { name: /Render 2 scenes · \$/ })).toBeVisible({ timeout: 15_000 });
    await shot(page, "script-to-video-videos");
});
