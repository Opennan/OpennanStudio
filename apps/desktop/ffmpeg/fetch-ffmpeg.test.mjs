import assert from "node:assert/strict";
import { test } from "node:test";
import { MANIFEST, platformKey, sha256, verifySha256 } from "./fetch-ffmpeg.mjs";

test("manifest pins every archive by SHA-256 over HTTPS", () => {
    assert.match(MANIFEST.source.url, /^https:\/\/ffmpeg\.org\/releases\/ffmpeg-7\.1\.5\.tar\.xz$/);
    assert.match(MANIFEST.source.sha256, /^[0-9a-f]{64}$/);
    for (const [key, entry] of Object.entries(MANIFEST.builds)) {
        if (entry.build) continue;
        assert.match(entry.url, /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-[0-9-]+\/.*-lgpl-7\.1\.(zip|tar\.xz)$/, key);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, key);
        assert.ok(!/gpl-7/.test(entry.url.replace("lgpl-7", "")), `${key} must be an lgpl archive`);
    }
    assert.deepEqual(Object.keys(MANIFEST.builds).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
});

test("SHA-256 verification refuses tampered bytes", () => {
    const bytes = Buffer.from("ffmpeg");
    verifySha256(bytes, sha256(bytes));
    assert.throws(() => verifySha256(Buffer.from("ffmpeg!"), sha256(bytes)), /SHA-256 mismatch/);
});

test("platform keys", () => {
    assert.equal(platformKey("win32", "x64"), "win32-x64");
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
});
