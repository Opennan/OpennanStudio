// Seeds files from the private frontend into a workspace package: copy once,
// rewrite imports, record provenance in packages/<pkg>/SEEDED.json.
// Usage: node scripts/seed-files.mjs <timeline-media|timeline-react> [--only=a,b] [--force] [--allow-unresolved]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FILES as CORE_FILES } from "./import-core.manifest.mjs";
import { buildIndex, rewriteForSeed, toPackageSpecifier } from "./seed-resolve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.OPENNAN_SRC ?? path.resolve(ROOT, "../opennan/frontend/src");
const MANIFESTS = ["timeline-media", "timeline-react"];
const isTest = (p) => /\.test\.tsx?$/.test(p);

const [name, ...rest] = process.argv.slice(2);
if (!MANIFESTS.includes(name)) {
    console.error(`usage: node scripts/seed-files.mjs <${MANIFESTS.join("|")}> [--only=a,b] [--force] [--allow-unresolved]`);
    process.exit(2);
}
if (!fs.existsSync(SRC)) {
    console.error(`Source not found: ${SRC} (set OPENNAN_SRC)`);
    process.exit(1);
}
const has = (flag) => rest.includes(flag);
const onlyArg = rest.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;

const loaded = {};
for (const manifestName of MANIFESTS) {
    loaded[manifestName] = await import(pathToFileURL(path.join(ROOT, "scripts/manifests", `${manifestName}.mjs`)).href);
}

const entries = [
    ...CORE_FILES.filter(([source]) => !isTest(source)).map(([source, dest]) => ({
        source,
        target: toPackageSpecifier("@opennan/timeline-core", dest),
    })),
    ...Object.entries(loaded).flatMap(([manifestName, mod]) => mod.FILES.filter(([source]) => !isTest(source)).map(([source, dest]) => ({
        source,
        target: manifestName === name ? dest : toPackageSpecifier(mod.PACKAGE_NAME, dest),
    }))),
];
const index = buildIndex(entries);
const manifest = loaded[name];
const pkgDir = path.join(ROOT, "packages", name);
const lockPath = path.join(pkgDir, "SEEDED.json");
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : {};

const problems = [];
let written = 0;
for (const [from, to] of manifest.FILES) {
    if (only && !only.has(to)) continue;
    const destAbs = path.join(pkgDir, to);
    if (fs.existsSync(destAbs) && !has("--force")) {
        console.log(`skip (exists): ${to}`);
        continue;
    }
    const abs = path.join(SRC, from);
    if (!fs.existsSync(abs)) {
        problems.push(`missing source: ${from}`);
        continue;
    }
    const raw = fs.readFileSync(abs, "utf8");
    const { code, unresolved } = rewriteForSeed(raw, {
        fromSource: from,
        destFile: to,
        index,
        rules: manifest.RULES ?? {},
        bareRules: manifest.BARE_RULES ?? {},
    });
    if (unresolved.length) problems.push(`${to}: unresolved ${unresolved.join(", ")}`);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, code);
    lock[to] = { source: from, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
    written += 1;
}
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(lockPath, `${JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 4)}\n`);
console.log(`Seeded ${written} file(s) into packages/${name}`);
if (problems.length) {
    console.error(problems.join("\n"));
    const fatal = problems.some((p) => p.startsWith("missing source")) || !has("--allow-unresolved");
    if (fatal) process.exit(1);
}
