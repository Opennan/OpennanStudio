import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CAPABILITY_TOOLS, OPENNAN_PIPELINE_TOOLS, PIPELINE_TOOLS, STUDIO_TOOLS } from "@opennan/mcp-schema";
import { NO_PIPELINES } from "./handlers/pipelines";
import { failure, success } from "./outcome";
import { SERVER_INSTRUCTIONS, toolsForPreset } from "./server";
import { connectInMemory } from "./testing/connect";
import { createFixtureStudio } from "./testing/fixture";

async function connect(options?: Parameters<typeof connectInMemory>[1]) {
    const studio = await createFixtureStudio();
    const connected = await connectInMemory(studio.session, options);
    const call = async (name: string, args: Record<string, unknown> = {}) => (await connected.client.callTool({ name, arguments: args })) as CallToolResult;
    return { ...connected, call, studio };
}

const text = (result: CallToolResult) => (result.content[0] as { text: string }).text;

describe("createStudioMcpServer", () => {
    it("identifies itself and lists every schema tool with annotations", async () => {
        const { client, close } = await connect();
        expect(client.getServerVersion()?.name).toBe("opennan-studio");
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(toolsForPreset().map((tool) => tool.name));
        expect(tools.find((tool) => tool.name === "read_timeline")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
        expect(tools.find((tool) => tool.name === "delete_timeline_clip")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(tools.find((tool) => tool.name === "generate_video")?.annotations?.openWorldHint).toBe(true);
        await close();
    });

    it("creates a visible lane for an agent's title and undoes the lane and clip together", async () => {
        const { call, close, studio } = await connect();
        const before = studio.controller.snapshot();
        // T1 is occupied by the fixture's title: this overlay needs a new text track.
        expect((await call("add_text_overlay", { text: "Agent title", start_time: 0, end_time: 3 })).isError).toBeFalsy();
        const after = studio.controller.snapshot();
        const title = after.clips.find((clip) => clip.textContent === "Agent title")!;
        expect(after.tracks).toContainEqual(expect.objectContaining({ type: "text", index: title.trackIndex, visible: true }));
        expect(after.tracks).toHaveLength(before.tracks.length + 1);
        expect((await call("undo_last_edit")).isError).toBeFalsy();
        expect(studio.controller.snapshot().tracks).toEqual(before.tracks);
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toEqual(before.clips.map((clip) => clip.id));
        await close();
    });

    it("keeps its instructions short", () => {
        expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(200);
    });

    it("rejects invalid arguments as a tool error", async () => {
        const { call, close } = await connect();
        const missing = await call("split_timeline_clip", { clip_id: "title" });
        expect(missing.isError).toBe(true);
        expect(text(missing)).toMatch(/^Invalid arguments for split_timeline_clip: arguments must have required property 'at_time'/);
        expect((await call("read_timeline", { bogus: 1 })).isError).toBe(true);
        await close();
    });

    it("rejects unknown tools as a protocol error", async () => {
        const { call, close } = await connect();
        await expect(call("no_such_tool")).rejects.toThrow(/Unknown tool: no_such_tool/);
        await close();
    });

    it("reports a listed tool without a handler", async () => {
        const { call, close } = await connect({ handlers: {} });
        const result = await call("read_timeline");
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ unavailable: true, reason: "read_timeline has no handler in this server." });
        await close();
    });

    it("turns a handler exception into a tool error", async () => {
        const { call, close } = await connect({ handlers: { read_timeline: async () => { throw new Error("boom"); } } });
        expect(await call("read_timeline")).toMatchObject({ isError: true, structuredContent: { ok: false, error: "boom" } });
        await close();
    });

    it("answers every capability tool with capability-unavailable guidance (project pipelines: no cloud runtime)", async () => {
        const { call, close } = await connect();
        for (const tool of CAPABILITY_TOOLS.filter((t) => !(OPENNAN_PIPELINE_TOOLS as readonly string[]).includes(t.name))) {
            const required = Object.fromEntries((tool.inputSchema.required ?? []).map((key) => {
                const property = tool.inputSchema.properties[key] as { type?: string; enum?: string[] };
                const value = property.enum?.[0] ?? (property.type === "integer" || property.type === "number" ? 1 : property.type === "boolean" ? true : property.type === "array" ? [] : "x");
                return [key, value];
            }));
            const result = await call(tool.name, required);
            expect(result.isError, tool.name).toBe(true);
            expect(result.structuredContent, tool.name).toMatchObject({ ok: false, unavailable: true, capability: tool.capability });
            if ((OPENNAN_PIPELINE_TOOLS as readonly string[]).includes(tool.name)) {
                expect(text(result), tool.name).toBe(NO_PIPELINES);
                continue;
            }
            const guidance = tool.capability?.startsWith("opennan.")
                ? /^Connect OpenNan to use /
                : tool.capability?.startsWith("provider.") ? / needs a connected provider\./ : / requires a provider with the /;
            expect(text(result), tool.name).toMatch(guidance);
        }
        await close();
    });

    it("runs calls on one session one at a time, also across servers", async () => {
        const studio = await createFixtureStudio();
        let value = 0;
        // A read-modify-write with a pause in the middle, like add_shot or a track add.
        const handlers = {
            find_clip: async () => {
                const read = value;
                await new Promise((resolve) => setTimeout(resolve, 5));
                value = read + 1;
                return success(`value ${value}`);
            },
        };
        const a = await connectInMemory(studio.session, { handlers });
        const b = await connectInMemory(studio.session, { handlers });
        await Promise.all([a, b, a, b].map((c) => c.client.callTool({ name: "find_clip", arguments: {} })));
        expect(value).toBe(4);
        await a.close();
        await b.close();
    });

    it("undoes the edits of a call that fails part way", async () => {
        const { call, close, studio } = await connect({
            handlers: {
                find_clip: async (_args, { session }) => {
                    await session.execute({ type: "clip.delete", clipIds: ["title"] });
                    await session.execute({ type: "clip.delete", clipIds: ["music"] });
                    return failure("Step 3: boom");
                },
            },
        });
        const result = await call("find_clip");
        expect(result.isError).toBe(true);
        expect(text(result)).toBe("Step 3: boom Undid the 2 edits this call made before it failed.");
        expect(result.structuredContent).toMatchObject({ rolledBack: 2 });
        expect(studio.controller.snapshot().clips.map((clip) => clip.id).sort()).toEqual(["music", "title"]);
        await close();
    });

    it("answers a stuck call with a timeout and frees the queue", async () => {
        let release!: () => void;
        const stuck = new Promise<void>((resolve) => {
            release = resolve;
        });
        let aborted = false;
        const { call, close } = await connect({
            callTimeoutMs: 50,
            handlers: {
                find_clip: async (_args, { signal }) => {
                    signal.addEventListener("abort", () => {
                        aborted = true;
                    });
                    await stuck;
                    return success("late");
                },
                read_timeline: async () => success("read"),
            },
        });
        const slow = await call("find_clip");
        expect(slow.isError).toBe(true);
        expect(text(slow)).toMatch(/^find_clip did not finish within 0\.05 s/);
        expect(aborted).toBe(true);
        expect(text(await call("read_timeline"))).toBe("read");
        release();
        await close();
    });

    it("lists only the offline tools with the offline preset", async () => {
        const { client, call, close } = await connect({ tools: toolsForPreset("offline") });
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(toolsForPreset("offline").map((tool) => tool.name));
        expect(tools).toHaveLength(67);
        await expect(call("generate_video", { prompt: "x" })).rejects.toThrow(/Unknown tool: generate_video/);
        await expect(call("plan_scenes", {})).rejects.toThrow(/Unknown tool: plan_scenes/);
        await close();
    });

    it("refuses OpenNan-only arguments of offline tools before running them", async () => {
        const { call, close, studio } = await connect({ handlers: {} });
        const result = await call("update_scene", { scene_order: 1, character_ids: ["c1"] });
        expect(result.structuredContent).toMatchObject({ unavailable: true, capability: "opennan.story.plan" });
        expect(text(result)).toBe("Connect OpenNan to use update_scene. These arguments need it: character_ids.");
        expect(studio.controller.snapshot().scenes[0].caption).toBe("Intro");
        await close();
    });
});
