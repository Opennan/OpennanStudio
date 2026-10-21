// Shared steps for the AI director specs (phase 9b): a signed-in cloud project with scenes and a text clip, the AI
// tab, and the fake server's director knobs.
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudControl, openEditor, serverIdOf } from "./cloud-helpers";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";

type CloudWindow = { __studioCloud: { backend(): { createProject(input: { name: string }): Promise<{ id: string }> } } };

export interface DirectorProject {
    projectId: string;
    sceneA: string;
    sceneB: string;
    titleClip: string;
}

export async function directorControl(name: string, body?: unknown, query = ""): Promise<unknown> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/director/${name}${query}`, {
        method: "POST", ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`fake director ${name}: ${response.status} ${await response.text()}`);
    return response.json();
}

export async function script(steps: unknown[]): Promise<void> {
    await directorControl("script", { steps });
}

export async function fakeControlGet(path: string): Promise<void> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/${path}`, { method: "POST" });
    if (!response.ok) throw new Error(`fake ${path}: ${response.status}`);
}

/** Signs in, makes a cloud project with two scenes and a title clip on the fake, opens it with the AI tab. */
export async function directorProject(page: Page, name: string, options: { scenes?: boolean; title?: boolean } = {}): Promise<DirectorProject> {
    await page.goto("/#/");
    await signInOpenNan(page);
    const projectId = await page.evaluate(async (projectName) => (await (window as unknown as CloudWindow).__studioCloud.backend().createProject({ name: projectName })).id, name);
    const ids = { sceneA: randomUUID(), sceneB: randomUUID(), titleClip: randomUUID() };
    const changes: Record<string, unknown> = {};
    if (options.scenes !== false) changes.scenes = { create: [{ id: ids.sceneA, caption: "Night falls on the town." }, { id: ids.sceneB, caption: "A car waits under the bridge." }] };
    if (options.title !== false) changes.clips = { create: [{ id: ids.titleClip, track_type: "text", track_index: 1, start_time: 0, end_time: 3, media_type: "text", text_content: "Hello" }] };
    if (Object.keys(changes).length > 0) await cloudControl("remote-change", { project_id: serverIdOf(projectId), changes });
    await openEditor(page, projectId);
    await openAiTab(page);
    return { projectId, ...ids };
}

export async function openAiTab(page: Page): Promise<void> {
    const tab = page.getByRole("tab", { name: "AI director" });
    if ((await tab.getAttribute("aria-selected")) !== "true") await page.getByRole("button", { name: "AI director" }).click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
}

export async function send(page: Page, message: string): Promise<void> {
    await page.getByRole("textbox", { name: "Message to the AI director" }).fill(message);
    await page.getByRole("button", { name: "Send" }).click();
}

export async function clipText(page: Page, clipId: string): Promise<string | null> {
    return page.evaluate((id) => {
        const state = (window as unknown as { __studio: { store: { getState(): { timelineData: { clips: Array<{ id: string; textContent?: string | null }> } | null } } } }).__studio.store.getState();
        return state.timelineData?.clips.find((c) => c.id === id)?.textContent ?? null;
    }, clipId);
}

export async function aiChanged(page: Page, id: string): Promise<boolean> {
    return page.evaluate((itemId) => Boolean((window as unknown as { __studio: { store: { getState(): { aiActivity: Record<string, { changed?: boolean }> } } } }).__studio.store.getState().aiActivity[itemId]?.changed), id);
}

export async function serverProject(projectId: string): Promise<{ clips: Array<Record<string, unknown>>; scenes: Array<Record<string, unknown>>; srt_content: string | null }> {
    const state = (await (await fetch(`${FAKE_OPENNAN}/__test/cloud/state`)).json()) as { projects: Array<{ id: string; clips: Array<Record<string, unknown>>; scenes: Array<Record<string, unknown>>; srt_content: string | null }> };
    return state.projects.find((p) => p.id === serverIdOf(projectId))!;
}

export async function setBalance(usd: number): Promise<void> {
    await fakeControlGet(`balance?usd=${usd}`);
}
