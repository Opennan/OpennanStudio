// Packs timeline-core, export, provider-sdk, provider-opennan, mcp-schema, and mcp, installs the tarballs into an
// empty folder with npm, and checks the installed package: ESM imports of "." and
// "./server", the bin shim, runtime dependencies, and the dist-smoke flow. The
// optional peers of @opennan/export (@ffmpeg/*, timeline-media, regl) stay uninstalled.
// npm fetches the MCP SDK tree from the registry, so the run needs it: mandatory in CI
// (CI=true or --require); elsewhere it is skipped with a message when
// OPENNAN_SKIP_PACK_SMOKE=1 is set or `npm ping` cannot reach the configured registry.
// Usage: node scripts/pack-smoke.mjs [--require]   (after pnpm build)
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["timeline-core", "export", "provider-sdk", "provider-opennan", "mcp-schema", "mcp"].map((name) => path.resolve(PKG, "..", name));
const required = process.env.CI === "true" || process.argv.includes("--require");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function skip(reason) {
    if (required) {
        console.error(`pack-smoke: cannot run (${reason}), and it is required here (CI or --require)`);
        process.exit(1);
    }
    console.log(`pack-smoke: SKIPPED (${reason}). CI runs it; run it locally with --require once the registry is reachable.`);
    process.exit(0);
}

if (process.env.OPENNAN_SKIP_PACK_SMOKE === "1") skip("OPENNAN_SKIP_PACK_SMOKE=1");
try {
    // Honors the user's npm config (registry, proxy); 15 s is plenty for one round trip.
    execFileSync("npm", ["ping", "--loglevel=error"], { stdio: "ignore", timeout: 15_000 });
} catch {
    skip("the npm registry is unreachable");
}

const dir = await mkdtemp(path.join(os.tmpdir(), "opennan-pack-smoke-"));
try {
    const tarballs = path.join(dir, "tarballs");
    for (const packageDir of PACKAGES) run("pnpm", ["pack", "--pack-destination", tarballs], packageDir);
    const app = path.join(dir, "app");
    await mkdir(app);
    await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "pack-smoke", private: true, type: "module" }));
    const files = (await readdir(tarballs)).map((file) => path.join(tarballs, file));
    // --legacy-peer-deps: @opennan/export's optional peer @opennan/timeline-media is not on the
    // registry, and npm 10 crashes resolving that peer set ("reading 'edgesOut'") instead of skipping it.
    // Optional peers stay uninstalled either way; required dependencies install as usual.
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps", ...files], app);
    run(process.execPath, ["--input-type=module", "-e", [
        "const node = await import('@opennan/mcp');",
        "const server = await import('@opennan/mcp/server');",
        "if (typeof node.startHttpServer !== 'function' || typeof server.createStudioMcpServer !== 'function') process.exit(1);",
    ].join(" ")], app);
    // Spec §3: every shipped package carries its generated notices (Task 24c).
    for (const name of ["timeline-core", "export", "provider-sdk", "mcp-schema", "mcp"]) await access(path.join(app, "node_modules/@opennan", name, "THIRD_PARTY_NOTICES"));
    console.log(`pack-smoke: bin ${run(path.join(app, "node_modules/.bin/opennan-studio"), ["--version"], app).trim()}`);
    run(process.execPath, [path.join(PKG, "scripts/dist-smoke.mjs"), path.join(app, "node_modules/@opennan/mcp/dist/cli.js")], PKG);
    console.log("pack-smoke: installed package works");
} finally {
    await rm(dir, { recursive: true, force: true });
}
