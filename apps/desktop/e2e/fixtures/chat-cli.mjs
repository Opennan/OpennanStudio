// Deterministic CLI replacement. The CLI is simulated; MCP, Electron IPC, timeline edits and persistence are real.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [profile, ...args] = process.argv.slice(2);
if (args[0] === "auth") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
    process.exit(0);
}
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("fixture-fail")) {
    emit(profile === "claude" ? { type: "result", is_error: true, result: "Subscription limit reached. Try again later." } : { type: "turn.failed", error: { message: "Subscription limit reached. Try again later." } });
    process.exit(1);
}
const session = "7cbb4552-b33a-49ed-84f9-297b1d3d6a6a";
emit(profile === "claude" ? { type: "system", session_id: session } : { type: "thread.started", thread_id: session });
if (prompt.includes("fixture-slow")) { setInterval(() => {}, 1000); await new Promise(() => {}); }
let bridge;
if (profile === "claude") bridge = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers["opennan-studio"];
else {
    const value = (key) => JSON.parse(args.find((arg) => arg.startsWith(key + "=")).slice(key.length + 1));
    bridge = { command: value("mcp_servers.opennan-studio.command"), args: value("mcp_servers.opennan-studio.args") };
}
const client = new Client({ name: "chat-cli-fixture", version: "1.0.0" });
const transport = new StdioClientTransport({ ...bridge, stderr: "inherit" });
await client.connect(transport);
const listed = await client.listTools();
if (listed.tools.some((tool) => /cloud_project|cloud_sync|plan_scenes|project_script/.test(tool.name))) throw new Error("Retired cloud tools were exposed");
await client.callTool({ name: "read_timeline", arguments: {} });
const undo = /fixture-undo/.test(prompt);
const tool = undo ? "undo_last_edit" : "add_text_overlay";
if (profile === "codex") emit({ type: "item.started", item: { id: "tool-1", type: "mcp_tool_call", tool } });
const result = await client.callTool({ name: tool, arguments: undo ? {} : { text: `Made by ${profile}`, start_time: 0, end_time: 3 } });
if (result.isError) throw new Error(JSON.stringify(result.content));
const reply = undo ? "Undid the last edit." : `Added a title through MCP using ${profile}.`;
if (profile === "claude") {
    emit({ type: "stream_event", event: { type: "message_start", message: { id: "reply-1" } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply.slice(0, 8) } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply.slice(8) } } });
    emit({ type: "assistant", message: { id: "reply-1", content: [{ type: "text", text: reply }] } });
    emit({ type: "result", result: reply, is_error: false });
} else {
    emit({ type: "item.completed", item: { id: "tool-1", type: "mcp_tool_call", tool } });
    emit({ type: "item.completed", item: { id: "reply-1", type: "agent_message", text: reply } });
    emit({ type: "turn.completed" });
}
await client.close();
