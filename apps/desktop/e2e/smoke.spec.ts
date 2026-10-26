// Desktop smoke (spec §11): launch, create a project, import media, edit, export a 3 s clip, and an MCP
// read_timeline round trip through the app binary's --mcp-bridge, an agent's export (assemble_video on the GPU
// path, followed with get_export_status), plus the preview's refusal of remote media.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    FIXTURE_SPEECH, FIXTURE_VIDEO, blurFocus, decodeFrame, ensureTinyModel, execute, launchStudio, probe, regionDifference, seedTinyModel, snapshot,
    waitForSaves, type Rect,
} from "./helpers";

const text = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

// Regions of the 1280×720 export (overlays sit in the free space: centre = pos × (frame − box) + box / 2). The
// tiktok_bold text is centred; the fire sticker (scale 1: 22 % of the height, about 160 px) is moved to the top
// centre (positionY 0.05: centre y ≈ 108); the control corner holds neither.
const TEXT_BAND: Rect = { x: 500, y: 345, width: 280, height: 30 };
const STICKER_BOX: Rect = { x: 610, y: 80, width: 60, height: 60 };
const CONTROL: Rect = { x: 80, y: 560, width: 220, height: 100 };
const FIRE = "twemoji:1f525";

test("launch, create, import, edit, looks, export 3 s, text and sticker export, MCP round trip and agent export, auto captions, refuse remote media", async () => {
    const captionsBlocked = await ensureTinyModel();
    const studio = await launchStudio({ prepare: (userData) => { if (!captionsBlocked) seedTinyModel(userData); } });
    const { page } = studio;
    let baseline = "";
    try {
        await test.step("launch", async () => {
            await expect(page).toHaveTitle("OpenNan Studio");
            expect(await page.evaluate(() => [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process])).toEqual(["undefined", "undefined"]);
            expect((await page.evaluate(() => Object.keys((window as unknown as { opennan: object }).opennan))).sort())
                .toEqual(["account", "ai", "app", "chat", "e2e", "exports", "mcp", "media", "persistence", "providers", "secrets", "session", "settings", "terminal"]);
        });

        await test.step("create project", async () => {
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("Smoke");
            await dialog.getByRole("radio", { name: "16:9 Landscape" }).check();
            await expect(dialog.getByLabel("Project name")).toHaveValue("Smoke");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect(page.getByRole("region", { name: "Media", exact: true })).toBeVisible();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Smoke");
        });

        await test.step("import media", async () => {
            await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
            const tile = page.getByTestId("media-item").first();
            await expect(tile).toContainText("0:06");
            const stored = fs.readdirSync(path.join(studio.userData, "media"));
            expect(stored).toHaveLength(1);
            expect(stored[0]).toMatch(/^[0-9a-f-]{36}\.webm$/);
        });

        await test.step("edit: add, split at 3 s, delete the rest", async () => {
            const tile = page.getByTestId("media-item").first();
            await tile.hover();
            await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
            await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
            await expect.poll(async () => (await page.locator(".editor-preview video").first().boundingBox())?.height ?? 0).toBeGreaterThan(100);
            const [scene] = (await snapshot(page)).scenes;
            await execute(page, { type: "selection.set", sceneId: scene.id });
            await execute(page, { type: "playhead.seek", seconds: 3 });
            await blurFocus(page);
            await page.keyboard.press("ControlOrMeta+b");
            await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(2);
            const second = (await snapshot(page)).scenes[1];
            await execute(page, { type: "selection.set", sceneId: second.id });
            await blurFocus(page);
            await page.keyboard.press("Delete");
            await expect.poll(async () => (await snapshot(page)).scenes.map((s) => Math.round(s.duration * 10) / 10)).toEqual([3]);
            await waitForSaves(page);
        });

        await test.step("looks: library rail, inspector, a filter, an adjustment, and an effect (exported natively below)", async () => {
            await expect(page.getByTestId("editor-library")).toBeVisible();
            await expect(page.getByTestId("inspector")).toBeVisible();
            const [scene] = (await snapshot(page)).scenes;
            await execute(page, { type: "selection.set", sceneId: scene.id });
            await page.getByTestId("editor-library").getByRole("tab", { name: "Filters", exact: true }).click();
            await page.getByTestId("filter-card-noir").click();
            await page.getByTestId("inspector-tab-adjust").click();
            await page.getByTestId("adjust-vignette").getByRole("slider").fill("50");
            await page.getByTestId("editor-library").getByRole("tab", { name: "Effects", exact: true }).click();
            await page.getByTestId("effect-card-fx_film_grain").click();
            await expect.poll(async () => {
                const s = (await snapshot(page)).scenes[0] as { visualFilter?: string; adjustmentsJson?: string | null; effects?: Array<{ effectId: string }> };
                return [s.visualFilter, s.adjustmentsJson, s.effects?.map((e) => e.effectId).join(",")];
            }).toEqual(["noir", '{"vignette":0.5}', "fx_film_grain"]);
            await page.getByTestId("editor-library").getByRole("tab", { name: "Media", exact: true }).click();
            await waitForSaves(page);
        });

        await test.step("export a 3 s clip (the fast GPU path: this window renders, main adds the audio)", async () => {
            await page.getByRole("button", { name: "Export", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "Export video" });
            await expect(dialog).toContainText("1280 × 720");
            await expect(dialog.locator(".export-engine")).toHaveText("Fast export (GPU)");
            await dialog.getByRole("button", { name: "Export MP4" }).click();
            const done = dialog.getByRole("status");
            const failed = dialog.getByRole("alert");
            await expect(done.or(failed)).toBeVisible({ timeout: 200_000 });
            if (await failed.isVisible()) throw new Error(`Export failed: ${await failed.innerText()}`);
            await expect(done).toContainText("Saved smoke-");
            const files = fs.readdirSync(studio.exportsDir).filter((name) => name.endsWith(".mp4"));
            expect(files).toHaveLength(1);
            baseline = path.join(studio.exportsDir, files[0]);
            const info = probe(baseline);
            expect(info.duration).toBeGreaterThan(2.9);
            expect(info.duration).toBeLessThan(3.1);
            const video = info.streams.find((s) => s.codec_type === "video");
            expect(["h264", "mpeg4"]).toContain(video?.codec_name);
            expect(video).toMatchObject({ width: 1280, height: 720 });
            expect(info.streams.some((s) => s.codec_type === "audio")).toBe(true);
            test.info().annotations.push({ type: "encoder", description: video!.codec_name });
            // Phase 10d: rendered in a worker that streamed the encoded video through the origin private file system
            // (the folder exists, and the intermediate was deleted once main had muxed it).
            const opfs = await page.evaluate(async () => {
                try {
                    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("opennan-exports");
                    const names: string[] = [];
                    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
                    return names;
                } catch {
                    return null;
                }
            });
            expect(opfs).toEqual([]);
            await dialog.getByRole("button", { name: "Close" }).click();
        });

        await test.step("text template and sticker from the library, exported natively, visible in the frame", async () => {
            const library = page.getByTestId("editor-library");
            await execute(page, { type: "playhead.seek", seconds: 0 });
            await library.getByRole("tab", { name: "Text", exact: true }).click();
            await page.getByTestId("text-template-tiktok_bold").click();
            await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.textContent === "POV: you finally did it").length).toBe(1);
            await expect(page.getByTestId("inspector-tab-animation")).toBeVisible();
            const textClip = (await snapshot(page)).clips.find((c) => c.textContent === "POV: you finally did it")!;
            // New text runs 5 s; keep it inside the 3 s scene so the export stays 3 s.
            expect((await execute(page, { type: "clip.update", clipIds: [textClip.id], patch: { endTime: 3 } })).ok).toBe(true);

            const stickersTab = library.getByRole("tab", { name: "Stickers", exact: true });
            await expect(stickersTab).toBeVisible();
            await stickersTab.click();
            await expect(page.getByTestId("library-stickers")).toBeVisible();
            await page.getByTestId(`sticker-card-${FIRE}`).click();
            type StickerClip = { id: string; trackType: string; stickerId?: string | null; startTime: number; endTime: number };
            const stickerClips = async () => ((await snapshot(page)).clips as unknown as StickerClip[]).filter((c) => c.trackType === "sticker" && c.stickerId === FIRE);
            await expect.poll(async () => (await stickerClips()).map((c) => [c.startTime, c.endTime])).toEqual([[0, 3]]);
            const [sticker] = await stickerClips();
            // The added sticker is selected: its inspector has the Animation tab (a sticker is an image: no Speed / Audio).
            await expect(page.getByTestId("inspector-tab-video")).toBeVisible();
            await page.getByTestId("inspector-tab-animation").click();
            await expect(page.getByTestId("inspector-panel-animation")).toBeVisible();
            await expect(page.getByTestId("inspector-tab-speed")).toHaveCount(0);
            // Off the centred text: top centre.
            expect((await execute(page, { type: "clip.update", clipIds: [sticker.id], patch: { positionX: 0.5, positionY: 0.05 } })).ok).toBe(true);
            await library.getByRole("tab", { name: "Media", exact: true }).click();
            await waitForSaves(page);

            await page.getByRole("button", { name: "Export", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "Export video" });
            await dialog.getByRole("button", { name: "Export MP4" }).click();
            const done = dialog.getByRole("status");
            const failed = dialog.getByRole("alert");
            await expect(done.or(failed)).toBeVisible({ timeout: 200_000 });
            if (await failed.isVisible()) throw new Error(`Export failed: ${await failed.innerText()}`);
            await expect(done).toContainText("Saved smoke-");
            await dialog.getByRole("button", { name: "Close" }).click();
            const files = fs.readdirSync(studio.exportsDir).filter((name) => name.endsWith(".mp4")).map((name) => path.join(studio.exportsDir, name));
            expect(files).toHaveLength(2);
            const output = files.find((file) => file !== baseline)!;
            const info = probe(output);
            expect(info.duration).toBeGreaterThan(2.9);
            expect(info.duration).toBeLessThan(3.1);
            expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });

            // Same source, looks, and time with and without the overlays: only the overlay areas change.
            const before = decodeFrame(baseline, 1.5, 1280, 720);
            const after = decodeFrame(output, 1.5, 1280, 720);
            const diff = { text: regionDifference(before, after, TEXT_BAND), sticker: regionDifference(before, after, STICKER_BOX), control: regionDifference(before, after, CONTROL) };
            test.info().annotations.push({ type: "overlay difference (0..255)", description: Object.entries(diff).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ") });
            expect(diff.control).toBeLessThan(12);
            expect(diff.text).toBeGreaterThan(Math.max(20, diff.control * 3));
            expect(diff.sticker).toBeGreaterThan(Math.max(30, diff.control * 3));

            // Leave the timeline as the steps below expect it (one scene, text track 1 free).
            expect((await execute(page, { type: "clip.delete", clipIds: [textClip.id, sticker.id] })).ok).toBe(true);
            await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.id === textClip.id || c.id === sticker.id).length).toBe(0);
            await waitForSaves(page);
        });

        await test.step("MCP read_timeline round trip through --mcp-bridge", async () => {
            const info = await page.evaluate(() => (window as unknown as { opennan: { mcp: { info(): Promise<{ running: boolean; url: string; tokenFile: string; configs: { claude: string } }> } } }).opennan.mcp.info());
            expect(info.running).toBe(true);
            expect(JSON.stringify(info)).not.toMatch(/"token"/);
            if (process.platform !== "win32") expect(fs.statSync(info.tokenFile).mode & 0o777).toBe(0o600);
            const transport = new StdioClientTransport({ ...JSON.parse(info.configs.claude).mcpServers["opennan-studio"], stderr: "inherit" });
            const client = new Client({ name: "desktop-smoke", version: "1.0.0" });
            await client.connect(transport);
            try {
                const timeline = text(await client.callTool({ name: "read_timeline", arguments: {} }));
                expect(timeline).toContain("\"Smoke\"");
                expect(timeline).toMatch(/Scenes \(1\)/);
                const created = await client.callTool({ name: "create_timeline_clip", arguments: { track_type: "text", track_index: 1, start_time: 0, end_time: 2, text_content: "from agent" } });
                expect(created.isError, text(created)).toBeFalsy();
                await expect.poll(async () => (await snapshot(page)).clips.map((c) => c.textContent)).toContain("from agent");
                const refused = await client.callTool({ name: "create_timeline_clip", arguments: { track_type: "video", track_index: 2, start_time: 0, end_time: 2, media_url: "https://evil.test/x.mp4" } });
                expect(refused.isError).toBe(true);
                await waitForSaves(page);

                // Agents use the available export engine. The fast path is verified above;
                // readiness can change after other exports, so also exercise the native fallback here.
                const before = fs.readdirSync(studio.exportsDir).filter((name) => name.endsWith(".mp4"));
                const started = await client.callTool({ name: "assemble_video", arguments: { resolution: "720p" } });
                expect(started.isError, text(started)).toBeFalsy();
                const jobId = (started.structuredContent as { jobId: string }).jobId;
                expect(jobId).toMatch(/^(?:gpu-[0-9a-f-]{36}|export-[0-9]+-[0-9]+)$/);
                const dialog = page.getByRole("dialog", { name: "Export video" });
                await expect(dialog).toBeVisible();
                const seen = new Set<string>();
                let job: Record<string, unknown> = {};
                await expect.poll(async () => {
                    const status = await client.callTool({ name: "get_export_status", arguments: { job_id: jobId } });
                    expect(status.isError, text(status)).toBeFalsy();
                    job = status.structuredContent as Record<string, unknown>;
                    seen.add(job.status === "running" ? `running:${String(job.engine)}` : String(job.status));
                    return job.status;
                }, { timeout: 200_000, intervals: [200] }).toMatch(/^(done|error|cancelled)$/);
                test.info().annotations.push({ type: "agent export states", description: [...seen].join(", ") });
                expect(job.status, JSON.stringify(job)).toBe("done");
                expect(job.encoder).toEqual(expect.any(String));
                const output = (job.output as { kind: string; path: string });
                expect(output.kind).toBe("file");
                expect(fs.realpathSync(path.dirname(output.path))).toBe(fs.realpathSync(studio.exportsDir));
                expect(output.path.endsWith(".mp4")).toBe(true);
                const after = fs.readdirSync(studio.exportsDir).filter((name) => name.endsWith(".mp4"));
                expect(after.filter((name) => !before.includes(name))).toEqual([path.basename(output.path)]);
                const info = probe(output.path);
                expect(info.duration).toBeGreaterThan(2.9);
                expect(info.duration).toBeLessThan(3.1);
                expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });
                expect(info.streams.some((s) => s.codec_type === "audio")).toBe(true);
                // The window's dialog showed the agent's export like its own, through to the result.
                await expect(dialog.getByRole("status")).toContainText("Saved smoke-");
                await dialog.getByRole("button", { name: "Close" }).click();
            } finally {
                await client.close();
            }
        });

        await test.step("auto captions with whisper.cpp (tiny model) on speech", async () => {
            if (captionsBlocked) {
                test.info().annotations.push({ type: "auto-captions skipped", description: captionsBlocked });
                return;
            }
            await page.getByRole("link", { name: "Projects" }).click();
            await page.getByRole("button", { name: "New project" }).first().click();
            const create = page.getByRole("dialog", { name: "New project" });
            await create.getByLabel("Project name").fill("Captions");
            await create.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Captions");
            await page.getByTestId("media-import-input").setInputFiles(FIXTURE_SPEECH);
            const tile = page.getByTestId("media-item").filter({ hasText: "jfk.wav" });
            await expect(tile).toContainText("0:11");
            await tile.hover();
            await tile.getByRole("button", { name: "Add jfk.wav to timeline" }).click();
            await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.mediaUrl?.startsWith("opennan-local://")).length).toBe(1);
            await waitForSaves(page);

            const button = page.getByRole("button", { name: "Auto captions" });
            await expect(button).not.toHaveAttribute("data-unavailable", "true");
            await button.click();
            const dialog = page.getByRole("dialog", { name: "Auto captions" });
            await dialog.getByLabel("Model").selectOption("tiny");
            await expect(dialog.getByLabel("Model")).toHaveValue("tiny");
            const started = Date.now();
            await dialog.getByRole("button", { name: "Start" }).click();
            const done = dialog.getByText(/Added \d+ captions? on a new Captions track\./);
            const failed = dialog.getByRole("alert");
            await expect(done.or(failed)).toBeVisible({ timeout: 120_000 });
            if (await failed.isVisible()) throw new Error(`Auto captions failed: ${await failed.innerText()}`);
            test.info().annotations.push({ type: "auto-captions", description: `${await done.innerText()} in ${((Date.now() - started) / 1000).toFixed(1)} s` });
            const after = await snapshot(page) as unknown as { clips: Array<{ trackType: string; trackIndex: number; textContent?: string | null }>; tracks: Array<{ type: string; index: number; label: string }> };
            const track = after.tracks.find((t) => t.type === "text" && t.label === "Captions");
            expect(track).toBeTruthy();
            const captions = after.clips.filter((c) => c.trackType === "text" && c.trackIndex === track!.index);
            expect(captions.length).toBeGreaterThan(0);
            expect(captions.map((c) => c.textContent).join(" ")).toMatch(/your country/i);
            await dialog.getByRole("button", { name: "Close" }).click();
            await execute(page, { type: "history.undo" });
            await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.textContent).length).toBe(0);
        });

        await test.step("the preview refuses remote media with a banner", async () => {
            await execute(page, { type: "clip.create", input: { trackType: "video", trackIndex: 3, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: "https://evil.test/x.mp4" } });
            await expect(page.getByRole("alert").filter({ hasText: "media from outside this project" })).toBeVisible();
            expect(await page.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.currentSrc.startsWith("https:")))).toBe(false);
        });
    } finally {
        await studio.close();
    }
});
