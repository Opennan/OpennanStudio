// The AI director in the AI tab (phase 9b), against the fake OpenNan server: the price before sending, a streamed
// turn whose edit lands through sync (highlighted, one undo step: Undo AI), Stop with its charge, a proposal run at
// its price, Buy credits on a 402, another device's running turn, and a local project that sends nothing.
import { expect, test } from "@playwright/test";
import { createProject, execute } from "./helpers";
import { fakeState } from "./fixtures/fake-opennan";
import { aiChanged, clipText, directorControl, directorProject, openAiTab, script, send, serverProject, setBalance } from "./director-helpers";
import { serverIdOf } from "./cloud-helpers";

test.afterEach(async () => {
    await setBalance(12.4);
    await directorControl("release").catch(() => undefined);
});

test("a turn streams, its edit lands on the timeline highlighted, and Undo AI takes the whole turn back", async ({ page }) => {
    const { projectId, titleClip: TITLE_CLIP } = await directorProject(page, "Directed");
    await expect(page.getByTestId("director-price")).toHaveText("≈ $0.08 typical · holds up to $0.43");
    await script([
        { text: "Looking at your project." },
        { edit: { label: "Retitle", changes: { clips: { patch: [{ id: TITLE_CLIP, text_content: "Night drive" }] } } } },
        { text: "Done: the title says Night drive." },
    ]);
    await send(page, "Change the title to Night drive");
    const messages = page.getByTestId("director-messages");
    await expect(messages).toContainText("Looking at your project.");
    await expect(messages.getByTestId("director-card").filter({ hasText: "Edit: Retitle" })).toContainText("Done");
    await expect(messages).toContainText("Done: the title says Night drive.");
    await expect(messages.getByTestId("director-charge").last()).toHaveText(/Charged \$0\.052/);
    await expect.poll(() => clipText(page, TITLE_CLIP), { timeout: 15_000 }).toBe("Night drive");
    await expect.poll(() => aiChanged(page, TITLE_CLIP)).toBe(true);
    const undo = messages.getByRole("button", { name: "Undo AI" }).last();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(() => clipText(page, TITLE_CLIP)).toBe("Hello");
    await expect(messages.getByRole("button", { name: "Undone" }).last()).toBeDisabled();
    await expect.poll(async () => (await serverProject(projectId)).clips.find((c) => c.id === TITLE_CLIP)?.text_content, { timeout: 15_000 }).toBe("Hello");
    // The AI step is in the same history as every edit: redo brings it back.
    expect((await execute(page, { type: "history.redo" })).ok).toBe(true);
    await expect.poll(() => clipText(page, TITLE_CLIP)).toBe("Night drive");
});

test("Stop ends the turn at once and shows what it charged", async ({ page }) => {
    await directorProject(page, "Stopped", { scenes: false, title: false });
    await script([{ text: "Starting a long job." }, { delay: 20_000 }, { text: "Never shown." }]);
    await send(page, "Do something long");
    const messages = page.getByTestId("director-messages");
    await expect(messages).toContainText("Starting a long job.");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(messages.getByTestId("director-charge").last()).toHaveText("Stopped · charged $0.026", { timeout: 10_000 });
    await expect(messages).not.toContainText("Never shown.");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("a proposal shows its price and Run sends its opaque run request (phase 9c); the storyboard lands as its own undo step", async ({ page }) => {
    const { projectId, sceneA: SCENE_A } = await directorProject(page, "Proposed", { title: false });
    await script([{ text: "I can draw it." }, { proposal: { tool: "generate_storyboard", scene_id: SCENE_A } }]);
    await send(page, "Draw scene 1");
    const proposal = page.getByTestId("director-proposal");
    await expect(proposal).toContainText("Draw a storyboard");
    await expect(proposal).toContainText("≈ $0.31");
    const before = (await fakeState()).requests.length;
    await proposal.getByRole("button", { name: "Run · $0.31" }).click();
    await expect(proposal.getByTestId("director-task")).toContainText("Done · charged $0.310", { timeout: 20_000 });
    const posts = (await fakeState()).requests.slice(before).filter((r) => r.method === "POST" && (r.path.endsWith("/storyboard") || r.path.endsWith("/run")));
    expect(posts.map((r) => r.path)).toEqual([expect.stringMatching(new RegExp(`^/v1/projects/${serverIdOf(projectId)}/director/turns/turn_[0-9a-f]{24}/proposals/prop_[0-9a-f]{24}/run$`))]);
    expect(posts[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(async () => page.evaluate((id) => {
        const scenes = (window as unknown as { __studio: { store: { getState(): { serverScenes: Array<{ id: string; shotBreakdown?: string | null }> } } } }).__studio.store.getState().serverScenes;
        return (JSON.parse(scenes.find((s) => s.id === id)?.shotBreakdown ?? "[]") as Array<{ keyframe_url?: string }>).filter((s) => s.keyframe_url).length;
    }, SCENE_A), { timeout: 20_000 }).toBe(3);
});

test("a balance below what a message holds shows Not enough credits · Buy credits and sends nothing; a 402 from OpenNan does too", async ({ page }) => {
    const { projectId } = await directorProject(page, "Broke", { scenes: false, title: false });
    // OpenNan's balance drops below a message's hold (the page still knows the old one: OpenNan's 402 decides).
    await setBalance(0.1);
    await send(page, "Hello");
    const toast = page.locator(".toast").filter({ hasText: "Not enough credits: a message holds up to $0.43 while it runs." });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast.getByRole("button", { name: "Buy credits" })).toBeVisible();
    const turns = (await directorControl("state")) as { turns: Array<{ project_id?: string; projectId?: string }> };
    expect(turns.turns.filter((t) => (t.project_id ?? t.projectId) === serverIdOf(projectId))).toHaveLength(0);
    // Now the page knows the low balance too: the next message is refused before anything is sent.
    const before = (await fakeState()).requests.filter((r) => r.path.endsWith("/director/turns") && r.method === "POST").length;
    await send(page, "Hello again");
    await expect(page.locator(".toast").filter({ hasText: "Not enough credits" }).first()).toBeVisible();
    await page.waitForTimeout(300);
    expect((await fakeState()).requests.filter((r) => r.path.endsWith("/director/turns") && r.method === "POST").length).toBe(before);
});

test("a turn running on another device: Send waits, Stop it cancels that turn", async ({ page }) => {
    const { projectId } = await directorProject(page, "Elsewhere", { scenes: false, title: false });
    await directorControl("hold", undefined, `?project_id=${serverIdOf(projectId)}`);
    await page.reload();
    await openAiTab(page);
    const banner = page.getByTestId("director-busy");
    await expect(banner).toContainText("The director is working on this project on another device.");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await banner.getByRole("button", { name: "Stop it" }).click();
    await expect(banner).toBeHidden();
    await script([{ text: "Back to you." }]);
    await send(page, "Hi again");
    await expect(page.getByTestId("director-messages")).toContainText("Back to you.");
});

test("a local project's AI tab asks to save it to OpenNan and calls nothing; signed out, Save opens Sign in with OpenNan", async ({ page }) => {
    await page.goto("/#/");
    await createProject(page, "Stays local");
    const before = (await fakeState()).requests.length;
    await openAiTab(page);
    const prompt = page.getByTestId("director-local");
    await expect(prompt).toContainText("The AI director works on cloud projects");
    await page.waitForTimeout(500);
    expect((await fakeState()).requests.length).toBe(before);
    await prompt.getByRole("button", { name: "Save to OpenNan" }).click();
    await expect(page.locator(".signin")).toBeVisible();
});
