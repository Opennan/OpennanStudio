// THIRD_PARTY_NOTICES for the packages pack-smoke packs and npm would ship (spec §3, §11):
// @opennan/timeline-core, @opennan/export, @opennan/provider-sdk, @opennan/provider-local, @opennan/provider-opennan, @opennan/provider-fal, @opennan/director-client, @opennan/mcp-schema, @opennan/mcp. Every
// production dependency needs an allowed license (no GPL family, SSPL, or unknown);
// dependencies reached through workspace packages count too (`pnpm licenses list` does not
// follow workspace links, see scripts/check-licenses.mjs); the Apache-2.0 packages depend only on
// Apache-2.0 workspace packages (apacheDependencyProblems). The repo-wide GPL check of shipped trees and bundles is
// scripts/check-licenses.mjs (pnpm check:licenses).
// A package's THIRD_PARTY_ASSETS file (bundled non-npm material, such as timeline-core's Twemoji graphics) is
// appended to its notices and must be listed in package.json "files" too.
// Usage: node scripts/package-notices.mjs --check | --write
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["timeline-core", "export", "provider-sdk", "provider-local", "provider-opennan", "provider-fal", "director-client", "mcp-schema", "mcp"];

/** Add an id here only after reviewing it; anything else fails the check. */
export const ALLOWED_LICENSES = new Set([
    "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "MPL-2.0",
    "BlueOak-1.0.0", "CC0-1.0", "CC-BY-4.0", "Unlicense", "Python-2.0",
]);

/** SPDX expression check: OR needs one allowed branch, AND needs every id allowed (AND binds tighter). */
export function licenseAllowed(expression) {
    const text = String(expression ?? "").replace(/[()]/g, " ").trim();
    if (!text) return false;
    return text.split(/\s+OR\s+/i).some((branch) => branch.split(/\s+AND\s+/i).every((id) => ALLOWED_LICENSES.has(id.trim())));
}

/** `pnpm licenses list --json` output; a package with only workspace dependencies prints a plain line instead. */
export function parseListing(output) {
    const text = output.trim();
    if (text === "" || /^No licenses in packages found/.test(text)) return {};
    return JSON.parse(text);
}

/** The package and every workspace package it reaches through `dependencies`, in visit order. */
export function workspaceClosure(name, manifests) {
    const seen = [];
    const visit = (pkgName) => {
        if (seen.includes(pkgName)) return;
        seen.push(pkgName);
        for (const dep of Object.keys(manifests.get(pkgName)?.dependencies ?? {})) if (manifests.has(dep)) visit(dep);
    };
    visit(name);
    return seen;
}

/** Several listings (one per workspace package) as one. */
export function mergeListings(listings) {
    const merged = {};
    for (const listing of listings) for (const [license, packages] of Object.entries(listing)) (merged[license] ??= []).push(...packages);
    return merged;
}

/** A listing -> one row per name@version, without this repo's packages and without duplicates. */
export function dependencyRows(listing) {
    const rows = new Map();
    for (const [license, packages] of Object.entries(listing)) {
        for (const pkg of packages) {
            if (pkg.name.startsWith("@opennan/")) continue;
            for (const version of pkg.versions ?? [pkg.version]) {
                rows.set(`${pkg.name}@${version}`, { name: pkg.name, version, license, homepage: pkg.homepage ?? null });
            }
        }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

/**
 * Apache-2.0 packages (spec §3: mcp-schema, provider-sdk, provider-local) stay Apache-2.0 all the way down:
 * a workspace dependency must be Apache-2.0 too, and mcp-schema and provider-sdk have no third-party
 * runtime dependencies at all.
 */
export function apacheDependencyProblems(pkg, manifests) {
    if (pkg.license !== "Apache-2.0") return [];
    const problems = [];
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
        const workspace = manifests.get(dep);
        if (workspace && workspace.license !== "Apache-2.0") problems.push(`${pkg.name} (Apache-2.0) must not depend on ${dep} (${workspace.license})`);
        if (!workspace && ["@opennan/mcp-schema", "@opennan/provider-sdk"].includes(pkg.name)) {
            problems.push(`${pkg.name} must have no third-party runtime dependencies (spec §3), has ${dep}`);
        }
    }
    return problems;
}

/** A package's THIRD_PARTY_ASSETS text normalized for the notices: LF line ends, no trailing spaces or blank tail. */
export function normalizeAssets(text) {
    return String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

/**
 * The notices text; `assets` is the package's THIRD_PARTY_ASSETS file (bundled non-npm material such as
 * timeline-core's Twemoji graphics), appended verbatim after the dependency list when present.
 */
export function renderNotices(packageName, rows, assets = null) {
    const lines = [`Third-party notices for ${packageName}`, "", "Generated by scripts/package-notices.mjs (pnpm notices:packages). Do not edit.", ""];
    if (rows.length === 0) lines.push("This package has no third-party runtime dependencies.");
    for (const row of rows) lines.push(`${row.name}@${row.version}  ${row.license}${row.homepage ? `  ${row.homepage}` : ""}`);
    lines.push("", "Each dependency's full license text ships inside that dependency's package.");
    const bundled = normalizeAssets(assets);
    if (bundled) lines.push("", "=".repeat(80), "Bundled assets (from THIRD_PARTY_ASSETS)", "=".repeat(80), "", bundled);
    return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const write = process.argv.includes("--write");
    const manifests = new Map(fs.readdirSync(path.join(ROOT, "packages")).flatMap((dir) => {
        const file = path.join(ROOT, "packages", dir, "package.json");
        if (!fs.existsSync(file)) return [];
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        return [[manifest.name, { ...manifest, dir: path.join(ROOT, "packages", dir) }]];
    }));
    const listings = new Map();
    /** One package's own listing; only packages with a non-workspace dependency are listed. */
    const listingOf = (name) => {
        if (!listings.has(name)) {
            const deps = Object.keys(manifests.get(name).dependencies ?? {}).filter((dep) => !manifests.has(dep));
            listings.set(name, deps.length === 0
                ? {}
                : parseListing(execFileSync("pnpm", ["--filter", name, "licenses", "list", "--prod", "--json"], { cwd: ROOT, encoding: "utf8" })));
        }
        return listings.get(name);
    };
    let ok = true;
    for (const dir of PACKAGES) {
        const packageDir = path.join(ROOT, "packages", dir);
        const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
        const deps = Object.keys(pkg.dependencies ?? {});
        for (const problem of apacheDependencyProblems(pkg, manifests)) {
            console.error(`package-notices: ${problem}`);
            ok = false;
        }
        if (!(pkg.files ?? []).includes("THIRD_PARTY_NOTICES")) {
            console.error(`package-notices: ${pkg.name} does not list THIRD_PARTY_NOTICES in package.json "files"`);
            ok = false;
        }
        const rows = dependencyRows(mergeListings(workspaceClosure(pkg.name, manifests).map(listingOf)));
        for (const row of rows.filter((r) => !licenseAllowed(r.license))) {
            console.error(`package-notices: ${pkg.name} depends on ${row.name}@${row.version} under "${row.license}", which is not allowed`);
            ok = false;
        }
        const target = path.join(packageDir, "THIRD_PARTY_NOTICES");
        const assetsFile = path.join(packageDir, "THIRD_PARTY_ASSETS");
        const assets = fs.existsSync(assetsFile) ? fs.readFileSync(assetsFile, "utf8") : null;
        if (assets !== null && !(pkg.files ?? []).includes("THIRD_PARTY_ASSETS")) {
            console.error(`package-notices: ${pkg.name} does not list THIRD_PARTY_ASSETS in package.json "files"`);
            ok = false;
        }
        const notices = renderNotices(pkg.name, rows, assets);
        if (write) fs.writeFileSync(target, notices);
        else if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== notices) {
            console.error(`package-notices: ${path.relative(ROOT, target)} is out of date: run pnpm notices:packages`);
            ok = false;
        }
        console.log(`package-notices: ${pkg.name}: ${rows.length} dependencies`);
    }
    if (!ok) process.exit(1);
}
