#!/usr/bin/env node
// The opennan-studio executable (package.json "bin" -> dist/cli.js). The only
// module of @opennan/mcp with side effects.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "./cli";
import { openBrowser } from "./open-browser";

const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    nodePath: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    openUrl: (url) => openBrowser(url),
    waitForShutdown: (transport) => new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
        if (transport === "stdio") process.stdin.once("end", () => resolve());
    }),
};

void runCli(process.argv.slice(2), io).then((code) => {
    process.exit(code);
});
