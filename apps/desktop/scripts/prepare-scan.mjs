// Expose Electron ASAR contents to antivirus scanners alongside the signed original packages.
import { createRequire } from "node:module";
import { readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const library = createRequire(builder.resolve("app-builder-lib"));
const { extractAll } = library("@electron/asar");
const root = resolve(process.argv[2] ?? "release");
const output = join(root, "scan-unpacked");
const archives = [];
function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === output || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".asar")) archives.push(path);
    }
}
walk(root);
if (!archives.some(path => path.endsWith("/app.asar") || path.endsWith("\\app.asar"))) throw new Error("No packaged application found to scan");
mkdirSync(output, { recursive: true });
for (const [index, archive] of archives.entries()) extractAll(archive, join(output, String(index)));
console.log(`Prepared ${archives.length} ASAR archives for scanning`);
