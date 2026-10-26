import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { APP_DIR, FIXTURE_VIDEO, launchStudio, snapshot, waitForSaves } from "./helpers";

test("subscription chat on a local project: real MCP editing, multiline input, retry, stop, reopen and both agents", async () => {
    test.skip(process.platform === "win32", "The isolated CLI fixtures use POSIX launchers; native Windows CLI installs use .exe.");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "studio-chat-cli-"));
    for (const profile of ["claude", "codex"]) {
        fs.writeFileSync(path.join(bin, profile), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(APP_DIR, "e2e/fixtures/chat-cli.mjs"))} ${profile} "$@"\n`, { mode: 0o700 });
    }
    const studio = await launchStudio({ env: { OPENNAN_STUDIO_E2E_HIDDEN: "1", OPENNAN_STUDIO_E2E_CHAT_BIN: bin } });
    const { page } = studio;
    try {
        await expect(page.getByRole("tab", { name: "OpenNan cloud" })).toHaveCount(0);
        await page.getByRole("button", { name: "New project" }).first().click();
        const dialog = page.getByRole("dialog", { name: "New project" });
        await dialog.getByLabel("Project name").fill("Local subscription chat");
        await dialog.getByRole("button", { name: "Create project" }).click();
        await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
        const tile = page.getByTestId("media-item").first();
        await tile.hover();
        await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
        await page.locator("#right-dock-tab-ai").click();
        const panel = page.getByTestId("agent-chat");
        await expect(panel).toContainText("Signed in with your subscription");
        await expect(page.getByRole("button", { name: "Save to OpenNan" })).toHaveCount(0);
        const input = panel.getByRole("textbox", { name: "Message your AI agent" });
        await input.fill("Add a title");
        await input.press("Shift+Enter");
        await input.pressSequentially("Keep it for three seconds.");
        await expect(input).toHaveValue("Add a title\nKeep it for three seconds.");
        // Switching inspector/AI preserves the draft.
        await page.locator("#right-dock-tab-inspector").click();
        await page.locator("#right-dock-tab-ai").click();
        await expect(input).toHaveValue("Add a title\nKeep it for three seconds.");
        await input.press("Enter");
        await expect(panel.getByRole("log")).toContainText("Added a title through MCP using claude.");
        await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.textContent === "Made by claude")).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            const snap = (window as unknown as { __studio: { controller: { snapshot(): { tracks: Array<{ type: string; visible: boolean }> } } } }).__studio.controller.snapshot();
            return snap.tracks.some((track) => track.type === "text" && track.visible);
        })).toBe(true);
        await expect(input).toHaveValue("");
        await expect(input).toBeFocused();
        await waitForSaves(page);
        await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeVisible();
        await input.fill("fixture-undo");
        await input.press("Enter");
        await expect(panel.getByRole("log")).toContainText("Undid the last edit.");
        await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.textContent === "Made by claude")).toBe(false);

        await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeVisible();
        await waitForSaves(page);
        await page.reload();
        await expect(panel.getByRole("log")).toContainText("Undid the last edit.");
        await input.fill("fixture-fail");
        await input.press("Enter");
        await expect(panel.getByRole("alert")).toContainText("Subscription limit reached");
        await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeVisible();
        await input.fill("fixture-slow");
        await input.press("Enter");
        const stop = panel.getByRole("button", { name: "Stop", exact: true });
        await expect(stop).toBeEnabled();
        await stop.click();
        await expect(panel.getByRole("log")).toContainText("Stopped.");
        await panel.getByRole("button", { name: "New chat" }).click();
        await expect(panel.getByRole("log")).not.toContainText("Stopped.");
        await panel.getByRole("combobox", { name: "AI agent" }).selectOption("codex");
        await input.fill("Add a title with Codex");
        await input.press("Enter");
        await expect(panel.getByRole("log")).toContainText("Added a title through MCP using codex.");
        await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.textContent === "Made by codex")).toBe(true);

        await panel.locator("summary").click();
        await panel.getByRole("combobox", { name: "MCP client" }).selectOption("opencode");
        const config = panel.getByLabel("MCP configuration");
        await expect(config).toContainText('"type": "local"');
        expect(JSON.parse(await config.innerText()).mcp["opennan-studio"].command).toContain("--mcp-bridge");
        await panel.getByRole("combobox", { name: "MCP client" }).selectOption("antigravity");
        await expect(config).toContainText('"mcpServers"');
        await page.screenshot({ path: "/tmp/opennan-ai-chat-after.png" });
        // All controls and messages fit the narrow dock without horizontal scrolling.
        expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await waitForSaves(page);
        const projectUrl = page.url();
        await page.getByRole("link", { name: "Projects", exact: true }).click();
        await page.goto(projectUrl);
        await expect(panel.getByRole("log")).toContainText("Added a title through MCP using codex.");
    } finally {
        await studio.close();
        fs.rmSync(bin, { recursive: true, force: true });
    }
});

test("installed subscription CLIs can edit a real local timeline", async () => {
    test.skip(process.env.OPENNAN_CHAT_LIVE !== "1", "Opt in to real CLI subscription usage with OPENNAN_CHAT_LIVE=1.");
    const studio = await launchStudio({ env: { OPENNAN_STUDIO_E2E_HIDDEN: "1" } });
    const { page } = studio;
    try {
        await page.getByRole("button", { name: "New project" }).first().click();
        const dialog = page.getByRole("dialog", { name: "New project" });
        await dialog.getByLabel("Project name").fill("Subscription integration verification");
        await dialog.getByRole("button", { name: "Create project" }).click();
        await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
        const tile = page.getByTestId("media-item").first();
        await tile.hover();
        await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
        await page.locator("#right-dock-tab-ai").click();
        const panel = page.getByTestId("agent-chat");
        for (const profile of ["claude", "codex"]) {
            await panel.getByRole("combobox", { name: "AI agent" }).selectOption(profile);
            await expect(panel).toContainText("Signed in with your subscription", { timeout: 25_000 });
            const input = panel.getByRole("textbox", { name: "Message your AI agent" });
            await input.fill(`Use the opennan-studio MCP tools to read this timeline, then add one text overlay that says "Verified ${profile}" from 0 to 3 seconds. Place the title at position_y ${profile === "claude" ? "0.3" : "0.7"}. Do not use any generation, paid tools, shell tools, external services or subagents. Reply with a short confirmation.`);
            await input.press("Enter");
            await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.textContent === `Verified ${profile}`), { timeout: 100_000 }).toBe(true);
            await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 100_000 });
            await expect(panel.getByRole("alert")).toHaveCount(0);
        }
        await waitForSaves(page);
        await page.screenshot({ path: "/tmp/opennan-ai-chat-live.png" });
    } finally { await studio.close(); }
});
