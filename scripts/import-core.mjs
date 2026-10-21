// Copies the framework-free timeline core from the private opennan frontend
// into packages/timeline-core, rewriting app imports. Re-runnable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, DOCS, RULES, LOCAL_RULES, FORKED } from "./import-core.manifest.mjs";
import { rewriteImports, findUnresolvedAppImports } from "./rewrite-imports.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "packages/timeline-core");
const SRC = process.env.OPENNAN_SRC ?? path.resolve(ROOT, "../opennan/frontend/src");

if (!fs.existsSync(SRC)) {
    console.error(`Source not found: ${SRC} (set OPENNAN_SRC)`);
    process.exit(1);
}

const problems = [];
for (const [from, to] of FILES) {
    if (FORKED.has(to)) continue;
    const abs = path.join(SRC, from);
    if (!fs.existsSync(abs)) {
        problems.push(`missing source: ${from}`);
        continue;
    }
    const out = rewriteImports(fs.readFileSync(abs, "utf8"), to, RULES, LOCAL_RULES[to]);
    const leftover = findUnresolvedAppImports(out);
    if (leftover.length) problems.push(`${to}: unresolved ${leftover.join(", ")}`);
    fs.mkdirSync(path.dirname(path.join(PKG, to)), { recursive: true });
    fs.writeFileSync(path.join(PKG, to), out);
}
for (const [from, to] of DOCS) {
    fs.copyFileSync(path.join(SRC, from), path.join(PKG, to));
}

if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
}
console.log(`Imported ${FILES.length} files into ${path.relative(ROOT, PKG)}`);
