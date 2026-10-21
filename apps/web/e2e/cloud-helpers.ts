// Shared steps for the cloud project specs (phase 9a): save a local project to OpenNan through the project menu, read
// a cloud project's sync state through the e2e build's window.__studioCloud, and drive the fake server's cloud knobs.
import { expect, type Page } from "@playwright/test";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";

type CloudWindow = {
    __studioCloud?: {
        backend(): {
            syncState(projectId: string): { kind: string; pending?: number; items?: Array<{ message: string; reason: string }> } | null;
            flush(projectId: string): Promise<void>;
        } | null;
    };
};

export async function cloudControl(name: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/cloud/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`fake cloud ${name}: ${response.status} ${await response.text()}`);
    return response.json();
}

export interface CloudProjectState {
    id: string;
    name: string;
    revision: number;
    deleted_at: string | null;
    clips: Array<Record<string, unknown> & { id: string }>;
    scenes: Array<Record<string, unknown> & { id: string }>;
}

export interface CloudStateView {
    projects: CloudProjectState[];
    assets: Array<{ id: string; sha256: string | null; size_bytes: number; scope: string; media_url: string; project_ids: string[] }>;
    uploads: Array<{ id: string; scope: string; project_id: string | null; sha256: string | null; size_bytes: number; puts: number; completed: boolean }>;
}

export async function cloudState(): Promise<CloudStateView> {
    return (await fetch(`${FAKE_OPENNAN}/__test/cloud/state`)).json() as Promise<CloudStateView>;
}

/** The editor's project id from the URL (#/p/<id>). */
export async function currentProjectId(page: Page): Promise<string> {
    const hash = await page.evaluate(() => window.location.hash);
    return decodeURIComponent(/^#\/p\/([^/]+)/.exec(hash)?.[1] ?? "");
}

export const serverIdOf = (projectId: string) => projectId.replace(/^cloud-/, "");

export async function syncKind(page: Page, projectId: string): Promise<string | null> {
    return page.evaluate((id) => (window as unknown as CloudWindow).__studioCloud?.backend()?.syncState(id)?.kind ?? null, projectId);
}

export async function waitSaved(page: Page, projectId: string): Promise<void> {
    await expect.poll(() => syncKind(page, projectId), { timeout: 30_000 }).toBe("saved");
    await expect(page.getByTestId("sync-chip")).toContainText("Saved");
}

/** Project menu → Save to OpenNan… → Save; returns the cloud project's id once the editor shows it. */
export async function saveToCloud(page: Page): Promise<string> {
    await page.getByRole("button", { name: "Project menu" }).click();
    await page.getByRole("menuitem", { name: "Save to OpenNan…" }).click();
    const dialog = page.getByRole("dialog", { name: /Save ".*" to OpenNan/ });
    await expect(dialog.getByTestId("save-plan")).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Save to OpenNan" }).click();
    await expect.poll(() => currentProjectId(page), { timeout: 60_000 }).toMatch(/^cloud-/);
    const projectId = await currentProjectId(page);
    await waitSaved(page, projectId);
    return projectId;
}

/** Opens a project in the editor and waits for its controller (window.__studio) to exist. */
export async function openEditor(page: Page, projectId: string): Promise<void> {
    await page.goto(`/#/p/${projectId}`);
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __studio?: unknown }).__studio)), { timeout: 30_000 }).toBe(true);
}
