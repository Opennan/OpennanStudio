// Removes source-text tests (it-blocks that read component source with
// readFileSync) from a seeded test file. Relies on the source files' consistent
// formatting: a block starts at "<indent>it(" and ends at the next "<indent>});".
// Usage: node scripts/strip-source-text-tests.mjs <file> --readers=a(,b( --helpers=a,b
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function removeBlocks(lines, startRe, shouldRemove) {
    const out = [];
    let removed = 0;
    let kept = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const match = startRe.exec(lines[i]);
        if (match) {
            const end = lines.findIndex((line, j) => j > i && line === `${match[1]}});`);
            if (end > i) {
                const block = lines.slice(i, end + 1);
                if (shouldRemove(block)) {
                    removed += 1;
                    i = end;
                    if (lines[i + 1] === "") i += 1;
                    continue;
                }
                kept += 1;
            }
        }
        out.push(lines[i]);
    }
    return { lines: out, removed, kept };
}

export function stripSourceTextTests(code, { readers, helpers = [] }) {
    let lines = code.split("\n");
    const its = removeBlocks(lines, /^(\s+)it\(/, (block) => readers.some((reader) => block.join("\n").includes(reader)) || block.join("\n").includes("readFileSync"));
    lines = its.lines;
    lines = removeBlocks(lines, /^()describe\(/, (block) => !block.some((line) => /^\s+it\(/.test(line))).lines;
    for (const helper of helpers) {
        const start = lines.findIndex((line) => line.startsWith(`function ${helper}(`));
        if (start < 0) continue;
        const end = lines.findIndex((line, j) => j > start && line === "}");
        lines.splice(start, end - start + 1 + (lines[end + 1] === "" ? 1 : 0));
    }
    let out = lines.join("\n");
    for (const [name, mod] of [["readFileSync", "node:fs"], ["resolve", "node:path"]]) {
        const importLine = new RegExp(`^import \\{ ${name} \\} from "${mod}";\\n`, "m");
        const rest = out.replace(importLine, "");
        if (!new RegExp(`\\b${name}\\(`).test(rest)) out = rest;
    }
    return { code: out, removed: its.removed, kept: its.kept };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const [file, ...args] = process.argv.slice(2);
    const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=`).split("=")[1].split(",").filter(Boolean);
    const { code, removed, kept } = stripSourceTextTests(fs.readFileSync(file, "utf8"), { readers: opt("readers"), helpers: opt("helpers") });
    fs.writeFileSync(file, code);
    console.log(`${path.basename(file)}: removed ${removed}, kept ${kept}`);
}
