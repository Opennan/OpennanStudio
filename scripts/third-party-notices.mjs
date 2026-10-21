// Vite/Rollup plugin: writes THIRD_PARTY_NOTICES.txt for the packages whose code is in
// the bundle (spec §3 "Each package ships LICENSE and a generated THIRD_PARTY_NOTICES").
// For each bundled module under node_modules it reads the package's package.json and its
// LICENSE/NOTICE/COPYING files. Workspace packages (@opennan/*) are skipped: their
// license is the app's own LICENSE, which `licenseFile` copies into the build.
// It also writes third-party-licenses.json ([{ name, version, license }]), the record of
// what was bundled that `pnpm check:licenses` checks (scripts/check-licenses.mjs).
// `extraEntries` adds material that is bundled without being an npm module (the vendored Twemoji
// graphics) to both outputs, sorted with the packages.
import fs from "node:fs";
import path from "node:path";

const LICENSE_FILE = /^(licen[cs]e|notice|copying)([.-].*)?$/i;
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function packageRootOf(file) {
    const index = file.lastIndexOf(NODE_MODULES);
    if (index < 0) return null;
    const base = file.slice(0, index + NODE_MODULES.length);
    const parts = file.slice(base.length).split(path.sep);
    return path.join(base, ...parts.slice(0, parts[0].startsWith("@") ? 2 : 1));
}

/** Bundled module ids -> one entry per package version, sorted by name. */
export function collectNotices(moduleIds) {
    const byRoot = new Map();
    for (const id of moduleIds) {
        const root = packageRootOf(id.replace(/^\0/, "").split("?")[0]);
        if (!root || byRoot.has(root) || !fs.existsSync(path.join(root, "package.json"))) continue;
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (String(manifest.name).startsWith("@opennan/")) {
            byRoot.set(root, null);
            continue;
        }
        const texts = fs.readdirSync(root).filter((name) => LICENSE_FILE.test(name)).sort()
            .map((name) => fs.readFileSync(path.join(root, name), "utf8").trim());
        const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? "UNKNOWN";
        byRoot.set(root, { name: manifest.name, version: manifest.version, license, texts });
    }
    const unique = new Map();
    for (const entry of byRoot.values()) if (entry) unique.set(`${entry.name}@${entry.version}`, entry);
    return [...unique.values()].sort(byName);
}

export function formatNotices(appName, packages) {
    const rule = (char) => char.repeat(80);
    const sections = packages.map((p) => [
        rule("="),
        `${p.name} ${p.version} (${p.license})`,
        rule("-"),
        p.texts.length > 0 ? p.texts.join(`\n\n${rule("-")}\n\n`) : `The package ships no license file. Its package.json declares: ${p.license}.`,
    ].join("\n"));
    return [`THIRD-PARTY SOFTWARE NOTICES`, ``, `${appName} includes the following third-party packages.`, ``, ...sections, ``].join("\n");
}

export const LICENSE_MANIFEST = "third-party-licenses.json";

/**
 * `extraEntries` ([{ name, version, license, licenseText }]) -> notice entries: material that is in the build
 * without being an npm module, such as the Twemoji graphics vendored in @opennan/timeline-core.
 */
export function extraNoticeEntries(extraEntries = []) {
    return extraEntries.map((entry) => {
        for (const key of ["name", "version", "license"]) {
            if (typeof entry?.[key] !== "string" || entry[key].trim() === "") throw new Error(`thirdPartyNotices: extraEntries need a ${key} (got ${JSON.stringify(entry)})`);
        }
        if (entry.licenseText !== undefined && typeof entry.licenseText !== "string") throw new Error(`thirdPartyNotices: extraEntries licenseText must be a string (${entry.name})`);
        const text = (entry.licenseText ?? "").replace(/\r\n?/g, "\n").trim();
        return { name: entry.name, version: entry.version, license: entry.license, texts: text ? [text] : [] };
    });
}

export function thirdPartyNotices({ appName, fileName = "THIRD_PARTY_NOTICES.txt", licenseFile, extraEntries = [] }) {
    const extras = extraNoticeEntries(extraEntries);
    return {
        name: "opennan-third-party-notices",
        apply: "build",
        generateBundle(_options, bundle) {
            const ids = Object.values(bundle).flatMap((output) => (
                output.type === "chunk" ? output.moduleIds ?? Object.keys(output.modules ?? {}) : []
            ));
            const packages = [...collectNotices(ids), ...extras].sort(byName);
            this.emitFile({ type: "asset", fileName, source: formatNotices(appName, packages) });
            const manifest = packages.map(({ name, version, license }) => ({ name, version, license }));
            this.emitFile({ type: "asset", fileName: LICENSE_MANIFEST, source: `${JSON.stringify(manifest, null, 2)}\n` });
            if (licenseFile) this.emitFile({ type: "asset", fileName: "LICENSE", source: fs.readFileSync(licenseFile, "utf8") });
        },
    };
}
