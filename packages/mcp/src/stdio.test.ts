// End to end over stdio: the MCP SDK client spawns `opennan-studio mcp serve`
// (TypeScript sources through tsx) on a temp project file.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolsForPreset } from "./server";
import { NO_PIPELINES } from "./handlers/pipelines";
import { writeProjectFile } from "./project-file";
import { fixtureProject } from "./testing/fixture";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PACKAGE_DIR, "src/bin.ts");

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-stdio-"));
    file = path.join(dir, "fixture.opennan.json");
    await writeProjectFile(file, fixtureProject());
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function spawnClient(args: string[]) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", BIN, ...args],
        cwd: PACKAGE_DIR,
        stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    return { client, transport };
}

describe("stdio transport", () => {
    it("serves the tools of a project file and saves edits to it", async () => {
        const { client, transport } = spawnClient(["mcp", "serve", "--project", file]);
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe("opennan-studio");
        expect((await client.listTools()).tools).toHaveLength(toolsForPreset().length);
        const read = (await client.callTool({ name: "read_timeline", arguments: {} })) as CallToolResult;
        expect((read.structuredContent as { scenes: unknown[] }).scenes).toHaveLength(3);
        const split = (await client.callTool({ name: "split_timeline_clip", arguments: { clip_id: "music", at_time: 7.5 } })) as CallToolResult;
        expect(split.isError).toBe(false);
        await client.close();
        await expect.poll(async () => JSON.parse(await readFile(file, "utf8")).project.clips.length).toBe(3);
        await expect.poll(async () => readFile(`${file}.lock`).then(() => "locked", () => "released")).toBe("released");
    });

    it("answers capability tools with Connect OpenNan guidance", async () => {
        const { client, transport } = spawnClient(["mcp", "serve", "--project", file, "--read-only"]);
        await client.connect(transport);
        const result = (await client.callTool({ name: "qc_check", arguments: {} })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toBe("Connect OpenNan to use qc_check.");
        await expect(client.callTool({ name: "generate_storyboard", arguments: { scene_order: 1 } })).rejects.toThrow("Unknown tool");
        await client.close();
    });
});
