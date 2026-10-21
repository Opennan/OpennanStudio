// pnpm --filter @opennan/desktop smoke:packaged <app executable>: launches the packaged app the way a user
// does (fuses on, so no inspector and no Playwright) with a fresh user-data folder, and passes when the main
// process got through startup: the SQLite store and the MCP token file exist (native better-sqlite3 loaded
// from the asar's unpacked folder, migrations ran) and the process is still alive five seconds later.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
    console.error(`packaged-smoke: no app executable at ${executable}`);
    process.exit(1);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-packaged-"));
const child = spawn(executable, [], { env: { ...process.env, OPENNAN_STUDIO_USER_DATA: userData, OPENNAN_DISABLE_UPDATES: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (d) => { output += d; });
child.stderr.on("data", (d) => { output += d; });
let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ready = () => fs.existsSync(path.join(userData, "opennan-studio.sqlite")) && fs.existsSync(path.join(userData, "mcp", "token"));
const fail = (message) => {
    console.error(`packaged-smoke: ${message}\n${output.slice(-4000)}`);
    child.kill();
    process.exit(1);
};

const deadline = Date.now() + 30_000;
while (!ready()) {
    if (exited) fail(`the app exited during startup (${JSON.stringify(exited)})`);
    if (Date.now() > deadline) fail("the app did not open its store within 30 s");
    await sleep(250);
}
await sleep(5000);
if (exited) fail(`the app exited after startup (${JSON.stringify(exited)})`);
child.kill();
for (let i = 0; i < 40 && !exited; i += 1) await sleep(250);
try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
    // a dying helper process may still hold the folder; it is a temp folder
}
console.log("packaged-smoke: OK");
process.exit(0);
