// Phase 9c: every money string Studio shows for a price, hold, quote or charge rounds UP (never under what it may
// cost); a balance rounds DOWN (never shows credit that isn't there). This guard reads the shipped sources: any
// "$${… .toFixed(…)}" must sit next to (the same line or the four before) a Math.ceil (prices) or a Math.floor
// (balances). A plain toFixed rounds to the nearest and could show a $0.4249 hold as "$0.42".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-e2e", "e2e", "parity", "generated", "test-results"]);
const MONEY_TEMPLATE = /\$\$\{[^`]*\.toFixed\(/;
const ROUNDED = /Math\.(ceil|floor)\(/;

function sources(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sources(full, out);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) out.push(full);
    }
    return out;
}

export function unroundedMoney(text) {
    const lines = text.split("\n");
    const found = [];
    lines.forEach((line, i) => {
        if (!MONEY_TEMPLATE.test(line)) return;
        const context = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        if (!ROUNDED.test(context)) found.push({ line: i + 1, text: line.trim() });
    });
    return found;
}

test("the guard flags a nearest-rounded money string and passes rounded ones", () => {
    assert.equal(unroundedMoney("const a = `$${usd.toFixed(2)}`;").length, 1);
    assert.equal(unroundedMoney("const cents = Math.ceil(usd * 100);\nconst a = `$${(cents / 100).toFixed(2)}`;").length, 0);
    assert.equal(unroundedMoney("const a = `$${(Math.floor(usd * 100) / 100).toFixed(2)}`;").length, 0);
});

test("every money string in shipped sources rounds up (prices) or down (balances)", () => {
    const roots = ["packages", "apps"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
    const offenders = [];
    for (const root of roots) {
        for (const workspace of fs.readdirSync(root)) {
            const src = path.join(root, workspace, "src");
            if (!fs.existsSync(src)) continue;
            for (const file of sources(src)) {
                for (const hit of unroundedMoney(fs.readFileSync(file, "utf8"))) offenders.push(`${path.relative(ROOT, file)}:${hit.line}: ${hit.text}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});
