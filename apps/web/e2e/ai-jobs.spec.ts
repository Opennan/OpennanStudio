// AI jobs against the fake OpenNan server (phase 11): the queue of two, cancel while queued (refunded), cancel after the
// paid step (409: it finishes and is charged), a failure with Retry (never retried by itself), not enough credits
// (Buy credits), signed out (Sign in with OpenNan first), a tool that is not live, and "Use the first N s" past a limit.
// The fake's knobs are global, so this file runs in its own Playwright project after the parallel suite.
import { expect, test, type Page } from "@playwright/test";
import { fakeControl, fakeState } from "./fixtures/fake-opennan";
import { addToTimeline, aiJobs, aiRun, aiTool, importFixtures, signInOpenNan, type AiHostWindow } from "./ai-helpers";
import { createProject, execute, snapshot } from "./helpers";

test.describe.configure({ mode: "serial" });

const isolations = async () => (await fakeState()).requests.filter((r) => r.method === "POST" && r.path === "/v1/audio/isolations");

async function setup(page: Page, signIn = true): Promise<string> {
    await createProject(page, "AI jobs");
    if (signIn) await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    return addToTimeline(page, "speech-with-gaps.wav", "clip");
}

test.beforeEach(async () => {
    await fakeControl("reset");
});
test.afterAll(async () => {
    await fakeControl("reset");
});

test("queues past two running jobs; cancel while queued in the app or on the server refunds", async ({ page }) => {
    const clipId = await setup(page);
    await fakeControl("task-steps?n=40");
    for (let i = 0; i < 3; i += 1) await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await aiJobs(page)).map((j) => j.status)).toEqual(["running", "running", "queued"]);
    const jobs = await aiJobs(page);
    await page.evaluate((id) => (window as unknown as AiHostWindow).__studio.ai.cancel(id), jobs[2]!.id);
    await expect.poll(async () => (await aiJobs(page))[2]!.status).toBe("cancelled");
    await expect.poll(async () => (await isolations()).length).toBe(2);
    await page.evaluate((id) => (window as unknown as AiHostWindow).__studio.ai.cancel(id), jobs[0]!.id);
    await expect.poll(async () => (await aiJobs(page))[0]).toMatchObject({ status: "cancelled", message: "Cancelled. You were not charged." });
    expect((await fakeState()).requests.some((r) => r.method === "POST" && /\/v1\/tasks\/[^/]+\/cancel$/.test(r.path))).toBe(true);
});

test("cancel after the paid step: the server refuses, the job finishes, is charged, and lands", async ({ page }) => {
    const clipId = await setup(page);
    await fakeControl("task-steps?n=6");
    await fakeControl("paid-started?tool=voice-isolation");
    await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await isolations()).length).toBe(1);
    // The paid step: the server's own stage (the fake's paid-started knob refuses cancels from here on).
    await expect.poll(async () => (await aiJobs(page))[0]?.stage, { timeout: 15_000 }).toBe("Isolating");
    const id = (await aiJobs(page))[0]!.id;
    await page.evaluate((jobId) => (window as unknown as AiHostWindow).__studio.ai.cancel(jobId), id);
    await expect.poll(async () => (await aiJobs(page))[0]).toMatchObject({ cancellable: false });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 30_000 }).toBe("succeeded");
    expect((await aiJobs(page))[0]!.costUsd).toBeGreaterThan(0);
    expect((await snapshot(page)).clips.filter((c) => c.trackType === "audio")).toHaveLength(2);
});

test("a failed run says it was refunded and offers Retry; nothing retries by itself", async ({ page }) => {
    const clipId = await setup(page);
    await fakeControl("fail-next?tool=voice-isolation&kind=pipeline_failed");
    await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 30_000 }).toBe("failed");
    expect((await aiJobs(page))[0]).toMatchObject({ refunded: true, error: expect.stringMatching(/not charged/i) });
    const toast = page.locator(".toast").filter({ hasText: "Isolate voice" });
    await expect(toast).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await isolations()).toHaveLength(1);
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => (await aiJobs(page)).at(-1)?.status, { timeout: 30_000 }).toBe("succeeded");
    expect(await isolations()).toHaveLength(2);
});

test("not enough credits: the submit is refused (402), Buy credits, no task", async ({ page }) => {
    const clipId = await setup(page);
    await fakeControl("balance?usd=0");
    await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 30_000 }).toBe("failed");
    await expect(page.locator(".account-toasts")).toContainText("Not enough credits");
    await expect(page.locator(".account-toasts").getByRole("button", { name: "Buy credits" })).toBeVisible();
    await expect(page.locator(".toast").filter({ hasText: "Isolate voice" })).toHaveCount(0);
    // The server answered the POST with 402 at submit: no task exists, nothing was polled or charged.
    expect((await fakeState()).requests.filter((r) => r.path.startsWith("/v1/tasks/"))).toHaveLength(0);
});

test("signed out: Sign in with OpenNan opens first; closing it sends nothing", async ({ page }) => {
    const clipId = await setup(page, false);
    expect((await aiTool(page, "voice-isolation", { clipId })).state).toBe("sign-in");
    await aiRun(page, "voice-isolation", { clipId });
    const modal = page.locator(".signin");
    await expect(modal).toContainText("Isolate voice needs an OpenNan account.");
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    expect((await fakeState()).uploads).toHaveLength(0);
    expect(await isolations()).toHaveLength(0);
});

test("a tool that is not live is disabled with its reason and sends nothing", async ({ page }) => {
    await fakeControl("tool-status?id=voice-isolation&status=unavailable");
    const clipId = await setup(page);
    await expect.poll(async () => (await aiTool(page, "voice-isolation", { clipId })).state).toBe("unavailable");
    expect((await aiTool(page, "voice-isolation", { clipId })).reason).toMatch(/unavailable/i);
    await aiRun(page, "voice-isolation", { clipId });
    await page.waitForTimeout(500);
    expect((await fakeState()).uploads).toHaveLength(0);
    expect(await isolations()).toHaveLength(0);
});

test("past the limit: the tool offers the first N seconds and the run sends only that", async ({ page }) => {
    const clipId = await setup(page);
    // Stretch the clip past voice isolation's 10 minutes (its media is 3.2 s; the range is cut to the file).
    await execute(page, { type: "clip.update", clipIds: [clipId], patch: { endTime: 700 } });
    await expect.poll(async () => (await aiTool(page, "voice-isolation", { clipId }))).toMatchObject({ state: "over-limit", limit: { maxSeconds: 600 } });
    await aiRun(page, "voice-isolation", { clipId });
    await page.waitForTimeout(500);
    expect(await isolations()).toHaveLength(0);
    await aiRun(page, "voice-isolation", { clipId, maxSeconds: 600 });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 30_000 }).toBe("succeeded");
    expect(await isolations()).toHaveLength(1);
});

test("phase 11.1: a balance below what the run holds is refused before anything is uploaded, with Buy credits", async ({ page }) => {
    // Voice isolation holds its longest input (10 minutes: $1.30) while it runs; the account has $0.50.
    await fakeControl("balance?usd=0.5");
    const clipId = await setup(page);
    await expect.poll(async () => (await aiTool(page, "voice-isolation", { clipId })).price.label).toBe("≈ $0.130");
    await aiRun(page, "voice-isolation", { clipId });
    const toast = page.locator(".toast").filter({ hasText: "Not enough credits: this run holds up to $1.30 while it goes." });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Buy credits" })).toBeVisible();
    await page.waitForTimeout(500);
    expect((await fakeState()).uploads).toHaveLength(0);
    expect(await isolations()).toHaveLength(0);
});

test("phase 11.1: a busy cancel (task_busy_retry) is asked again after Retry-After and then cancels", async ({ page }) => {
    const clipId = await setup(page);
    await fakeControl("task-steps?n=40");
    await fakeControl("cancel-busy?n=1");
    await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 15_000 }).toBe("running");
    await expect.poll(async () => (await isolations()).length).toBe(1);
    const id = (await aiJobs(page))[0]!.id;
    await page.evaluate((jobId) => (window as unknown as AiHostWindow).__studio.ai.cancel(jobId), id);
    await expect.poll(async () => (await aiJobs(page))[0], { timeout: 15_000 }).toMatchObject({ status: "cancelled", message: "Cancelled. You were not charged." });
    const cancels = (await fakeState()).requests.filter((r) => r.method === "POST" && /\/v1\/tasks\/[^/]+\/cancel$/.test(r.path));
    expect(cancels).toHaveLength(2);
    expect(cancels[1]!.at - cancels[0]!.at).toBeGreaterThanOrEqual(900);
});

test("phase 11.1: without quotes (an older server) the label is the never-under estimate, and the run goes", async ({ page }) => {
    await fakeControl("quotes?status=404");
    const clipId = await setup(page);
    await expect.poll(async () => (await aiTool(page, "voice-isolation", { clipId })).price.label).toBe("≈ $0.131");
    await aiRun(page, "voice-isolation", { clipId });
    await expect.poll(async () => (await aiJobs(page))[0]?.status, { timeout: 30_000 }).toBe("succeeded");
    expect((await fakeState()).requests.filter((r) => r.path === "/v1/quotes").length).toBeGreaterThan(0);
});
