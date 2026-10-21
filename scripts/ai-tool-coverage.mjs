// Writes docs/ai-tool-coverage.md from the built @opennan/mcp-schema registry (spec §5.11).
// Usage: node scripts/ai-tool-coverage.mjs [--check]   (run `pnpm build` first)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/ai-tool-coverage.md");
const DIST = path.join(ROOT, "packages/mcp-schema/dist/index.js");

if (!fs.existsSync(DIST)) {
    console.error("packages/mcp-schema/dist is missing: run pnpm build first");
    process.exit(1);
}
const { renderCoverageMarkdown } = await import(pathToFileURL(DIST).href);
const text = renderCoverageMarkdown();
if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (current !== text) {
        console.error("docs/ai-tool-coverage.md is out of date: run pnpm tools:coverage");
        process.exit(1);
    }
    console.log("ai-tool-coverage: up to date");
} else {
    fs.writeFileSync(OUT, text);
    console.log(`ai-tool-coverage: wrote ${text.split("\n").filter((line) => line.startsWith("| `")).length} rows`);
}
