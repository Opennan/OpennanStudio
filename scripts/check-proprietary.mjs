// Fails CI when proprietary OpenNan pipeline code or prompts appear in the public repo (spec §2.1).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DENY_PATHS = [
    /(^|\/)ai\/(agents|planning)\//,
    /(^|\/)reserach\//,
    /(^|\/)RESEARCH_KB\.md$/,
    /(^|\/)gpu-server\//,
    /prompt/i,
    /chat_ai\.py$/,
    /assembler\.py$/,
];
const INSTRUCTION = /["'`]You are (an?|the) [^"'`]{180,}["'`]/;
// Shipped code must not name private files, modules, or their line numbers (spec §2.1): describe the behaviour
// instead. Plans and specs may. The AI director's public contract names (the turn object "director_turn" and the
// error code "director_unavailable", phase 9b) are API, not private modules.
const PRIVATE_REFERENCE = /assembler\.py|backend\/app\/|director_(?!(?:turn|unavailable)\b)[a-z]+|\bpublic_api\b|device_auth\.|tasks\.PUBLIC_ERRORS/;
const SHIPPED_CODE = /^(packages|apps)\//;

export function checkFile(file, content) {
    const issues = [];
    if (file.startsWith("scripts/check-proprietary")) return issues;
    for (const re of DENY_PATHS) if (re.test(file)) issues.push(`${file}: denylisted path (${re})`);
    if (INSTRUCTION.test(content)) issues.push(`${file}: looks like an LLM prompt`);
    if (SHIPPED_CODE.test(file) && PRIVATE_REFERENCE.test(content)) issues.push(`${file}: cites private source code`);
    return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
    const issues = files.flatMap((f) => checkFile(f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
    if (issues.length) {
        console.error(issues.join("\n"));
        process.exit(1);
    }
    console.log(`check-proprietary: ${files.length} files clean`);
}
