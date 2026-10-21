// Drives a built opennan-studio CLI over stdio with the MCP SDK client: the shipped
// bundle (externals, exports, entry), not the TypeScript sources the tests run.
// Usage: node scripts/dist-smoke.mjs <path to cli.js>
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = path.resolve(process.argv[2] ?? "dist/cli.js");
const dir = await mkdtemp(path.join(os.tmpdir(), "opennan-dist-smoke-"));
const problems = [];
try {
    const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
    const project = path.join(dir, "smoke.opennan.json");
    execFileSync(process.execPath, [cli, "project", "new", project], { encoding: "utf8" });
    const client = new Client({ name: "dist-smoke", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "serve", "--project", project] }));
    const { tools } = await client.listTools();
    const read = await client.callTool({ name: "read_timeline", arguments: {} });
    const created = await client.callTool({ name: "add_text_overlay", arguments: { text: "Smoke", start_time: 0, end_time: 2 } });
    await client.close();
    if (tools.length < 100) problems.push(`expected the full tool list, got ${tools.length} tools`);
    if (read.isError) problems.push(`read_timeline failed: ${JSON.stringify(read.content)}`);
    if (created.isError) problems.push(`add_text_overlay failed: ${JSON.stringify(created.content)}`);
    // The server saves and releases its lock as it exits.
    for (let i = 0; i < 50 && (await stat(`${project}.lock`).catch(() => null)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const saved = JSON.parse(await readFile(project, "utf8"));
    if (saved.project.clips.length !== 1) problems.push(`expected 1 saved clip, got ${saved.project.clips.length}`);
    if (problems.length === 0) console.log(`dist-smoke: ${cli} ${version}: ${tools.length} tools, edit saved`);
} finally {
    await rm(dir, { recursive: true, force: true });
}
for (const problem of problems) console.error(`dist-smoke: ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
