// Runs a Node script inside Electron's Node (ELECTRON_RUN_AS_NODE=1), so tests load better-sqlite3 built for
// Electron's ABI, the same binary the app ships. Usage: node scripts/electron-node.mjs <script> [args...]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron"); // the binary path when required from Node
const child = spawn(electron, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
