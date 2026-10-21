// The built @opennan/mcp/server entry (dist/server.js and the chunks it imports) must not
// import a Node-only module or @opennan/export/node: hosts embed it outside Node's main
// process. src/server-api.test.ts checks the sources; this checks what tsup emitted.
// Usage: node scripts/check-server-dist.mjs   (after pnpm build)
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const NODE_ONLY = new Set([...builtinModules, "@opennan/export/node"]);

const seen = new Set();
const problems = [];
function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(path.join(DIST, file), "utf8");
    for (const [, specifier] of text.matchAll(/(?:import|from)\s*"([^"]+)"/g)) {
        if (specifier.startsWith("./")) visit(specifier.slice(2));
        else if (NODE_ONLY.has(specifier.replace(/^node:/, ""))) problems.push(`${file} imports ${specifier}`);
    }
}
visit("server.js");
for (const problem of problems) console.error(`check-server-dist: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`check-server-dist: ${seen.size} files, no Node-only imports`);
