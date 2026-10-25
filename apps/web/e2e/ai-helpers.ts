// Shared steps for the phase 11 AI specs: sign in through the fake OpenNan server's device flow, import fixtures, and
// read what the fake saw. The fake's knobs are global, so each AI spec uses its own tool or resets what it set.
import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_OPENNAN, fakeControl } from "./fixtures/fake-opennan";
import { snapshot, waitForSaves } from "./helpers";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Signs in from the account chip (popup approval) and waits for the balance in the chip. */
export async function signInOpenNan(page: Page): Promise<void> {
    const chip = page.locator(".account-chip");
    await chip.click();
    const modal = page.locator(".signin");
    await expect(modal).toHaveAttribute("data-state", "start");
    const popup = page.waitForEvent("popup");
    await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
    const opened = await popup;
    await opened.waitForURL(/\/console\/device\?code=/);
    const code = (await page.locator(".signin-code-text").textContent())!.trim();
    await fakeControl(`approve/${code}`);
    await opened.close();
    await expect(chip).not.toContainText("Sign in", { timeout: 10_000 });
}

/** Imports fixture files into the media bin and waits for their tiles. */
export async function importFixtures(page: Page, names: string[]): Promise<void> {
    const before = await page.getByTestId("media-item").count();
    await page.getByTestId("media-import-input").setInputFiles(names.map((name) => path.join(FIXTURES, name)));
    await expect(page.getByTestId("media-item")).toHaveCount(before + names.length, { timeout: 20_000 });
}

/** Adds a media tile to the timeline (video: a main-track scene; audio: an audio clip at the playhead); returns the new item's id. */
export async function addToTimeline(page: Page, name: string, kind: "clip" | "scene"): Promise<string> {
    const before = await snapshot(page);
    const tile = page.getByTestId("media-item").filter({ hasText: name });
    await tile.hover();
    await tile.getByRole("button", { name: `Add ${name} to timeline` }).click();
    if (kind === "scene") {
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(before.scenes.length + 1);
        await waitForSaves(page);
        const known = new Set(before.scenes.map((s) => s.id));
        return (await snapshot(page)).scenes.find((s) => !known.has(s.id))!.id;
    }
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(before.clips.length + 1);
    // The optimistic clip has a temporary id until the backend answers.
    await waitForSaves(page);
    await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.id.startsWith("temp"))).toBe(false);
    const known = new Set(before.clips.map((c) => c.id));
    return (await snapshot(page)).clips.find((c) => !known.has(c.id))!.id;
}

export type AiHostWindow = {
    __studio: {
        ai: {
            run(tool: string, params: Record<string, unknown>): void;
            tool(tool: string, params: Record<string, unknown>): { state: string; reason?: string; price: { kind: string; label?: string }; limit?: { maxSeconds?: number } };
            jobs(): Array<{ id: string; status: string; stage?: string; error?: string; message?: string; costUsd?: number; cancellable: boolean; refunded?: boolean }>;
            cancel(id: string): void;
            retry(id: string): void;
        };
    };
};

export const aiTool = (page: Page, tool: string, params: Record<string, unknown>) =>
    page.evaluate(([t, p]) => (window as unknown as AiHostWindow).__studio.ai.tool(t as string, p as Record<string, unknown>), [tool, params] as const);
export const aiRun = (page: Page, tool: string, params: Record<string, unknown>) =>
    page.evaluate(([t, p]) => (window as unknown as AiHostWindow).__studio.ai.run(t as string, p as Record<string, unknown>), [tool, params] as const);
export const aiJobs = (page: Page) => page.evaluate(() => (window as unknown as AiHostWindow).__studio.ai.jobs());

/** Sets one of the fake server's upload knobs (they live under /__test/cloud/ on the fake). */
export async function uploadControl(name: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/cloud/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`fake upload knob ${name}: ${response.status} ${await response.text()}`);
    return response.json();
}

export interface FakeUploadsView {
    uploads: Array<{ id: string; scope: string; project_id: string | null; sha256: string | null; size_bytes: number; puts: number; completed: boolean }>;
}

/** The uploads the fake server has seen. */
export async function uploadState(): Promise<FakeUploadsView> {
    return (await fetch(`${FAKE_OPENNAN}/__test/cloud/state`)).json() as Promise<FakeUploadsView>;
}
