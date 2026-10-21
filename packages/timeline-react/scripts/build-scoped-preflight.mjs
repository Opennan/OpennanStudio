// Scopes Tailwind's preflight under the editor roots so the host page is not reset.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import prefixer from "postcss-prefix-selector";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const input = fs.readFileSync(require.resolve("tailwindcss/preflight.css"), "utf8");
const SCOPES = [".opennan-studio", ".opennan-studio-portal"];

const result = await postcss([
    prefixer({
        prefix: ":where(.opennan-studio, .opennan-studio-portal)",
        transform(prefix, selector, prefixedSelector) {
            if (/^(html|:host|body)$/.test(selector)) return SCOPES.join(", ");
            if (selector.startsWith("html ") || selector.startsWith(":host ")) return `${prefix} ${selector.replace(/^(html|:host)\s+/, "")}`;
            return prefixedSelector;
        },
    }),
]).process(input, { from: undefined });

const out = path.join(pkg, "src/styles/preflight.scoped.css");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `/* GENERATED from tailwindcss/preflight.css by scripts/build-scoped-preflight.mjs */\n${result.css}`);
console.log(`wrote ${path.relative(pkg, out)}`);
