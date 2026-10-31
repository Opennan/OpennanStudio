// Vitest/Vite aliases that point @opennan/* imports at package sources, so
// package tests run without building their workspace dependencies first.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = {
    "@opennan/timeline-core": "packages/timeline-core/src",
    "@opennan/timeline-media": "packages/timeline-media/src",
    "@opennan/timeline-react": "packages/timeline-react/src",
    "@opennan/export": "packages/export/src",
    "@opennan/mcp-schema": "packages/mcp-schema/src",
    "@opennan/mcp": "packages/mcp/src",
    "@opennan/provider-sdk": "packages/provider-sdk/src",
    "@opennan/provider-local": "packages/provider-local/src",
    "@opennan/provider-opennan": "packages/provider-opennan/src",
    "@opennan/provider-fal": "packages/provider-fal/src",
    "@opennan/director-client": "packages/director-client/src",
    "@opennan/story-film": "packages/story-film/src",
};

function escape(name) {
    return name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function workspaceAliases() {
    const aliases = [];
    for (const [name, dir] of Object.entries(PACKAGES)) {
        const abs = path.join(ROOT, dir);
        aliases.push({ find: new RegExp(`^${escape(name)}\\/(.*)$`), replacement: `${abs}/$1` });
        aliases.push({ find: new RegExp(`^${escape(name)}$`), replacement: path.join(abs, "index.ts") });
    }
    return aliases;
}
