// Round-trip cases for the editor tools.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectInMemory } from "../connect";
import { STUB_EXPORT_PATH } from "../export-runner";
import { createFixtureStudio } from "../fixture";
import { data, text, clipOf, type Case } from "../roundtrip";

export const EDITOR_CASES: Record<string, Case> = {
    manage_timeline_tracks: async (call, studio) => {
        expect(text(await call("manage_timeline_tracks", { action: "list" }))).toBe("Tracks: video1, audio1, text1.");
        await call("manage_timeline_tracks", { action: "add", track_type: "audio" });
        await call("manage_timeline_tracks", { action: "update", track_type: "audio", track_index: 1, muted: true });
        expect(studio.controller.snapshot().tracks.map((t) => `${t.type}${t.index}${t.muted ? "m" : ""}`)).toEqual(["video1", "audio1m", "text1", "audio2"]);
        expect((await call("manage_timeline_tracks", { action: "add", track_type: "text", track_index: 1 })).isError).toBe(true);
    },
    undo_last_edit: async (call, studio) => {
        expect(data(await call("undo_last_edit")).error).toBe("Nothing to undo.");
        await call("delete_timeline_clip", { clip_id: "title" });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "title")).toBeDefined();
        // Two scene.add commands, one tool call: one undo restores the 3 original scenes.
        await call("create_scenes", { scenes: [{ caption: "A" }, { caption: "B" }] });
        expect(studio.controller.snapshot().scenes).toHaveLength(5);
        expect(data(await call("undo_last_edit"))).toMatchObject({ calls: 1, steps: 2 });
        expect(studio.controller.snapshot().scenes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    },
    client_playback: async (call, studio) => {
        await call("client_playback", { action: "play", time: 4 });
        expect(studio.store.getState()).toMatchObject({ currentTime: 4, isPlaying: true });
        await call("client_playback", { action: "pause" });
        expect(studio.store.getState().isPlaying).toBe(false);
        expect((await call("client_playback", { action: "seek" })).isError).toBe(true);
    },
    client_select_clip: async (call, studio) => {
        await call("client_select_clip", { clip_ids: ["title", "music"] });
        expect([...studio.store.getState().selectedClipIds]).toEqual(["title", "music"]);
        expect((await call("client_select_clip", { clip_ids: ["zzz"] })).isError).toBe(true);
    },
    client_add_marker: async (call, studio) => {
        const marker = data(await call("client_add_marker", { time: 2.5, label: "beat" })).marker;
        expect(marker).toMatchObject({ time: 2.5, label: "beat" });
        expect(studio.store.getState().timelineMarkers).toHaveLength(1);
    },
    client_remove_marker: async (call, studio) => {
        const marker = data(await call("client_add_marker", { time: 1 })).marker;
        await call("client_remove_marker", { marker_id: marker.id });
        expect(studio.store.getState().timelineMarkers).toEqual([]);
        expect((await call("client_remove_marker", { marker_id: marker.id })).isError).toBe(true);
    },
    client_open_panel: async (call, studio) => {
        expect((await call("client_open_panel", { panel: "effects" })).isError).toBe(false);
        expect(studio.session.host.activePanel?.()).toBe("effects");
    },
    client_snapshot_page: async (call) => {
        const result = await call("client_snapshot_page");
        expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    },
    assemble_video: async (call, studio) => {
        const started = await call("assemble_video", { resolution: "720p" });
        expect(started.isError).toBe(false);
        const { jobId } = data(started);
        expect(jobId).toMatch(/^export-/);
        await studio.exporter?.settled(jobId);
        expect(data(await call("get_export_status", { job_id: jobId }))).toMatchObject({
            status: "done", output: { kind: "file", path: STUB_EXPORT_PATH }, width: 1280, height: 720,
        });
        expect(data(await call("assemble_video", { resolution: "4k" })).error).toBe("This exporter renders up to 1080p.");
        // An animated GIF (phase 10d): the same job, a GIF at most 640 wide.
        const gif = data(await call("assemble_video", { format: "gif", resolution: "720p" }));
        await studio.exporter?.settled(gif.jobId);
        expect(data(await call("get_export_status", { job_id: gif.jobId }))).toMatchObject({ status: "done", container: "gif", width: 640, height: 360 });
        // A host without an exporter: export.start is unavailable, and so is the tool.
        const bare = await createFixtureStudio();
        const { client, close } = await connectInMemory(bare.session);
        const none = (await client.callTool({ name: "assemble_video", arguments: {} })) as CallToolResult;
        expect(none.isError).toBe(true);
        expect(data(none)).toMatchObject({ unavailable: true });
        expect(text(none)).toContain("export.start needs @opennan/export");
        await close();
    },
    cancel_export: async (call, studio) => {
        // Nothing runs (the fixture's export finishes at once; createStudioExporter's tests cancel a running one).
        expect(data(await call("cancel_export", {})).error).toBe("No export is running.");
        const { jobId } = data(await call("assemble_video", { resolution: "720p" }));
        await studio.exporter?.settled(jobId);
        expect(data(await call("cancel_export", { job_id: jobId })).error).toBe("No export is running.");
        const bare = await createFixtureStudio();
        const { client, close } = await connectInMemory(bare.session);
        const none = (await client.callTool({ name: "cancel_export", arguments: {} })) as CallToolResult;
        expect(data(none)).toMatchObject({ unavailable: true });
        await close();
    },
    get_export_status: async (call, studio) => {
        expect(data(await call("get_export_status", { job_id: "nope" })).error).toBe("No export job nope in this session.");
        const { jobId } = data(await call("assemble_video"));
        await studio.exporter?.settled(jobId);
        expect(text(await call("get_export_status", { job_id: jobId }))).toBe(
            `Export ${jobId} finished: ${STUB_EXPORT_PATH} (1920x1080, 15s, libopenh264, 5 warnings).`,
        );
        const bare = await createFixtureStudio();
        const { client, close } = await connectInMemory(bare.session);
        const none = (await client.callTool({ name: "get_export_status", arguments: { job_id: jobId } })) as CallToolResult;
        expect(data(none)).toMatchObject({ unavailable: true });
        await close();
    },
    run_editor_command: async (call, studio) => {
        await call("delete_timeline_clip", { clip_id: "title" });
        await call("undo_last_edit");
        expect((await call("run_editor_command", { command: { type: "history.redo" } })).isError).toBe(false);
        expect(clipOf(studio, "title")).toBeUndefined();
        expect((await call("run_editor_command", { command: { type: "nope" } })).isError).toBe(true);
        expect(text(await call("run_editor_command", { command: { type: "clip.split", clipIds: ["music"] } })))
            .toMatch(/^Invalid clip\.split command: command must have required property 'atSeconds'/);
    },
};
