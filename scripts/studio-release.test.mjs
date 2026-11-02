// Release validation must reject partial, altered, unsigned or unscanned installers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targets, sha256, validateRelease } from "./studio-release.mjs";

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "studio-release-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const target of Object.keys(targets)) {
        const dir = join(root, target);
        mkdirSync(dir);
        const mac = target.startsWith("darwin");
        const data = {
            [`OpenNan-Studio-1.2.3-${target}.${mac ? "dmg" : "exe"}`]: "test-installer",
            [mac ? "latest-mac.yml" : "latest.yml"]: "version: 1.2.3\n",
            ...(mac ? { [`OpenNan-Studio-1.2.3-${target}.zip`]: "test-update" } : {}),
        };
        for (const [name, content] of Object.entries(data)) writeFileSync(join(dir, name), content);
        writeFileSync(join(dir, "verification.json"), JSON.stringify({ version: "1.2.3", target, scan: "passed", signature: "verified", notarization: mac ? "verified" : null, sha256: Object.fromEntries(Object.entries(data).map(([name, content]) => [name, sha256(content)])) }));
    }
    return root;
}

test("a full verified release produces R2 links and separate per-architecture feeds", (t) => {
    const release = validateRelease(fixture(t), "1.2.3");
    assert.equal(release.manifest.files.length, 3);
    assert.equal(release.binaries.length, 5);
    assert.equal(new Set(release.feeds.map(f => f.key)).size, 3);
    assert.ok(release.manifest.files.every(f => f.url.startsWith("https://cdn.opennan.com/programs/studio/")));
});

test("changed binaries and missing architecture stop publication", (t) => {
    const root = fixture(t);
    writeFileSync(join(root, "darwin-arm64/OpenNan-Studio-1.2.3-darwin-arm64.dmg"), "tampered");
    assert.throws(() => validateRelease(root, "1.2.3"), /Checksum mismatch/);
    rmSync(join(root, "darwin-arm64"), { recursive: true });
    assert.throws(() => validateRelease(root, "1.2.3"));
});

test("missing scan, signature or notarization verification cannot publish", (t) => {
    const root = fixture(t);
    const path = join(root, "darwin-arm64/verification.json");
    const report = JSON.parse(readFileSync(path, "utf8"));
    for (const key of ["scan", "signature", "notarization"]) {
        writeFileSync(path, JSON.stringify({ ...report, [key]: "failed" }));
        assert.throws(() => validateRelease(root, "1.2.3"), /Unverified/);
    }
});

test("unstable and mismatched release versions cannot publish", (t) => {
    const root = fixture(t);
    assert.throws(() => validateRelease(root, "1.2.3-beta.1"), /stable/);
    assert.throws(() => validateRelease(root, "1.2.4"), /Unverified/);
});
