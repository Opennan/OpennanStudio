// Rewrites app-alias import specifiers ("@/...") in files copied from the
// private opennan frontend into package-relative paths.
import path from "node:path";

const SPECIFIER = /(["'])((?:@\/|\.\.?\/)[^"']+)\1/g;

function toRelative(fromFile, targetFile) {
    const fromDir = path.posix.dirname(fromFile);
    let rel = path.posix.relative(fromDir, targetFile).replace(/\.(ts|tsx)$/, "");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
}

export function rewriteImports(source, destFile, rules, localRules = {}) {
    return source.replace(SPECIFIER, (match, quote, spec) => {
        let target = localRules[spec] ?? rules[spec];
        if (!target && spec.startsWith("@/lib/")) {
            target = `src/lib/${spec.slice("@/lib/".length)}.ts`;
        }
        if (!target) return match;
        return `${quote}${toRelative(destFile, target)}${quote}`;
    });
}

export function findUnresolvedAppImports(source) {
    const found = [];
    for (const m of source.matchAll(/(["'])(@\/[^"']+)\1/g)) found.push(m[2]);
    return found;
}
