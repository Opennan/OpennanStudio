// Scopes the universal rules Tailwind v4 emits outside preflight (the `@layer properties`
// fallback `*, ::before, ::after, ::backdrop { --tw-*: initial }`) under the editor roots,
// so the compiled stylesheet does not touch host elements.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(pkg, process.argv[2] ?? "dist/styles.css");
const SCOPE = ":where(.opennan-studio,.opennan-studio-portal)";
const UNIVERSAL = /^(\*|html|body|:host|:root)?(::?(before|after|backdrop))?$/;

function scopeSelector(selector) {
    const trimmed = selector.trim();
    if (/^(html|body|:host|:root)$/.test(trimmed)) return [SCOPE];
    if (trimmed === "*") return [SCOPE, `${SCOPE} *`];
    return [`${SCOPE} ${trimmed.replace(/^\*/, "")}`];
}

const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
let scoped = 0;
root.walkRules((rule) => {
    const selectors = rule.selectors;
    if (!selectors.some((s) => s.trim() === "*" || /^(html|body)$/.test(s.trim()))) return;
    if (!selectors.every((s) => UNIVERSAL.test(s.trim()) && s.trim() !== "")) return;
    rule.selectors = [...new Set(selectors.flatMap(scopeSelector))];
    scoped += 1;
});
fs.writeFileSync(file, root.toString());
console.log(`scoped ${scoped} universal rule(s) in ${path.relative(pkg, file)}`);
