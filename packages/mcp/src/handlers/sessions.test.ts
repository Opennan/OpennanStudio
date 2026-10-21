// Several MCP servers over one StudioSession (the HTTP host's shape): calls run one
// at a time, and undo_last_edit undoes whole tool calls around edits made elsewhere.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectInMemory } from "../testing/connect";
import { createFixtureStudio } from "../testing/fixture";

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

describe("tool calls on a shared session", () => {
    it("keeps every concurrent read-modify-write edit, also across servers", async () => {
        const studio = await createFixtureStudio();
        const a = await connectInMemory(studio.session);
        const b = await connectInMemory(studio.session);
        const results = await Promise.all([
            call(a.client, "add_shot", { scene_order: 2, prompt: "a", duration: 1 }),
            call(b.client, "add_shot", { scene_order: 2, prompt: "b", duration: 1 }),
            call(a.client, "manage_timeline_tracks", { action: "add", track_type: "audio" }),
            call(b.client, "manage_timeline_tracks", { action: "add", track_type: "audio" }),
        ]);
        expect(results.map((result) => result.isError)).toEqual([false, false, false, false]);
        const s2 = studio.controller.snapshot().scenes.find((scene) => scene.id === "s2");
        const prompts = JSON.parse(s2?.shotBreakdown ?? "[]").map((shot: { prompt: string }) => shot.prompt);
        expect(prompts.slice(0, 2)).toEqual(["wide", "close"]);
        expect([...prompts.slice(2)].sort()).toEqual(["a", "b"]);
        expect(studio.controller.snapshot().tracks.filter((t) => t.type === "audio").map((t) => t.index)).toEqual([1, 2, 3]);
        await a.close();
        await b.close();
    });

    it("undoes whole tool calls and counts an editor edit as one call", async () => {
        const studio = await createFixtureStudio();
        const { client, close } = await connectInMemory(studio.session);
        await call(client, "create_scenes", { scenes: [{ caption: "A" }, { caption: "B" }] });
        await studio.controller.execute({ type: "clip.delete", clipIds: ["title"] }); // an edit in the editor UI
        expect((await call(client, "undo_last_edit")).structuredContent).toMatchObject({ calls: 1, steps: 1 });
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toContain("title");
        expect((await call(client, "undo_last_edit")).structuredContent).toMatchObject({ calls: 1, steps: 2 });
        expect(studio.controller.snapshot().scenes.map((scene) => scene.id)).toEqual(["s1", "s2", "s3"]);
        await close();
    });
});
