// Pure specifier resolution for seeding private-frontend files into workspace
// packages. No I/O; scripts/seed-files.mjs does the copying.
import path from "node:path";

const PATH_SPECIFIER = /(["'])((?:@\/|\.\.?\/)[^"'\n]+)\1/g;
const IMPORT_CONTEXT = String.raw`(from\s+|import\(\s*|vi\.mock\(\s*|vi\.importActual\(\s*|require\(\s*)`;

function stripExt(p) {
    return p.replace(/\.(tsx?|mjs|js)$/, "");
}

function escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function toPackageSpecifier(packageName, dest) {
    return `${packageName}/${stripExt(dest.replace(/^src\//, ""))}`;
}

// entries: [{ source: "<path under frontend/src>", target: "src/…" | "@opennan/…" }]
export function buildIndex(entries) {
    const index = new Map();
    for (const { source, target } of entries) index.set(stripExt(source), target);
    return index;
}

function render(target, destFile) {
    if (!target.startsWith("src/")) return target;
    let rel = path.posix.relative(path.posix.dirname(destFile), stripExt(target));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
}

export function resolveSpecifier(spec, fromSource, { index, rules }) {
    if (rules[spec]) return { target: rules[spec] };
    let key;
    if (spec.startsWith("@/")) {
        key = spec.slice(2);
    } else if (spec.startsWith("./") || spec.startsWith("../")) {
        key = path.posix.normalize(path.posix.join(path.posix.dirname(fromSource), spec));
    } else {
        return { keep: true };
    }
    key = stripExt(key);
    // A rule written as "@/<path>" also applies to relative imports of that file.
    const ruled = rules[`@/${key}`];
    if (ruled) return { target: ruled };
    const target = index.get(key) ?? index.get(`${key}/index`);
    return target ? { target } : { unresolved: true };
}

export function rewriteForSeed(code, { fromSource, destFile, index, rules, bareRules = {} }) {
    const unresolved = new Set();
    let out = code.replace(PATH_SPECIFIER, (match, quote, spec) => {
        const resolved = resolveSpecifier(spec, fromSource, { index, rules });
        if (resolved.unresolved) {
            unresolved.add(spec);
            return match;
        }
        if (resolved.keep) return match;
        return `${quote}${render(resolved.target, destFile)}${quote}`;
    });
    for (const [bare, target] of Object.entries(bareRules)) {
        const re = new RegExp(`${IMPORT_CONTEXT}(["'])${escape(bare)}\\2`, "g");
        out = out.replace(re, (_match, context, quote) => `${context}${quote}${render(target, destFile)}${quote}`);
    }
    return { code: out, unresolved: [...unresolved] };
}
