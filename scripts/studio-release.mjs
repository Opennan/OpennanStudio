// Stage verified installer metadata and publish immutable binaries to R2 before switching update feeds.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const targets = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "windows-x64" };
const base = "https://cdn.opennan.com/programs/studio";
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function validateRelease(root, version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable x.y.z version");
    const binaries = [], feeds = [], files = [];
    for (const [target, platform] of Object.entries(targets)) {
        const dir = join(root, target);
        const report = JSON.parse(readFileSync(join(dir, "verification.json"), "utf8"));
        if (report.version !== version || report.target !== target || report.scan !== "passed" || report.signature !== "verified" || (target.startsWith("darwin") && report.notarization !== "verified")) throw new Error(`Unverified target ${target}`);
        const names = readdirSync(dir).filter((name) => /\.(dmg|zip|exe|blockmap|yml)$/.test(name));
        const installer = `OpenNan-Studio-${version}-${target}.${target.startsWith("darwin") ? "dmg" : "exe"}`;
        const feed = target.startsWith("darwin") ? "latest-mac.yml" : "latest.yml";
        if (!names.includes(installer) || !names.includes(feed) || (target.startsWith("darwin") && !names.includes(`OpenNan-Studio-${version}-${target}.zip`))) throw new Error(`Incomplete target ${target}`);
        for (const name of names) {
            if (name !== feed && !name.startsWith(`OpenNan-Studio-${version}-${target}.`)) throw new Error(`Unexpected file ${name}`);
            const path = join(dir, name);
            const digest = sha256(readFileSync(path));
            if (report.sha256?.[name] !== digest) throw new Error(`Checksum mismatch ${name}`);
            (name === feed ? feeds : binaries).push({ path, key: `${target}/${name}`, digest });
        }
        if (!readFileSync(join(dir, feed), "utf8").includes(`version: ${version}\n`)) throw new Error(`Wrong feed version ${target}`);
        files.push({ platform, url: `${base}/${target}/${installer}`, size_bytes: statSync(join(dir, installer)).size, sha256: report.sha256[installer] });
    }
    return { binaries, feeds, manifest: { version, released_at: new Date().toISOString(), files } };
}

function stage(root, target, version) {
    if (!targets[target] || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release target/version");
    // Called by CI only after scanner and OS signature verification succeed.
    const checksums = Object.fromEntries(readdirSync(root).filter((n) => /\.(dmg|zip|exe|blockmap|yml)$/.test(n)).map((n) => [n, sha256(readFileSync(join(root, n)))]));
    writeFileSync(join(root, "verification.json"), JSON.stringify({ version, target, scan: "passed", signature: "verified", notarization: target.startsWith("darwin") ? "verified" : null, sha256: checksums }, null, 2));
}

async function publish(root, version) {
    const release = validateRelease(root, version);
    const { R2_ENDPOINT, R2_BUCKET } = process.env;
    if (!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(R2_ENDPOINT ?? "") || !/^[a-z0-9][a-z0-9.-]+$/.test(R2_BUCKET ?? "")) throw new Error("Configure R2_ENDPOINT and R2_BUCKET");
    const aws = (args) => execFileSync("aws", ["--endpoint-url", R2_ENDPOINT, ...args], { encoding: "utf8" });
    const current = await fetch(`${base}/latest.json`, { signal: AbortSignal.timeout(15000) });
    if (current.ok) {
        const previous = (await current.json()).version;
        if (!/^\d+\.\d+\.\d+$/.test(previous)) throw new Error("Invalid current release version");
        const a = version.split(".").map(Number), b = previous.split(".").map(Number);
        const difference = a.map((n, i) => n - b[i]).find(n => n !== 0) ?? 0;
        if (difference <= 0) throw new Error("Release version must be newer than the published version");
    } else if (current.status !== 404) throw new Error(`Cannot read current release: ${current.status}`);
    // No binary key is ever reused: old installed apps can finish their in-flight downloads.
    for (const file of release.binaries) {
        // A retry may find binaries from an interrupted upload. Only reuse byte-identical files.
        let existing = null;
        try { existing = JSON.parse(aws(["s3api", "head-object", "--bucket", R2_BUCKET, "--key", `programs/studio/${file.key}`])); }
        catch (error) { if (!/\(404\)|\(NoSuchKey\)|Not Found/.test(String(error.stderr))) throw error; }
        if (existing) {
            if (existing.Metadata?.sha256 !== file.digest || existing.ContentLength !== statSync(file.path).size) throw new Error(`Refusing to overwrite ${file.key}`);
            continue;
        }
        aws(["s3api", "put-object", "--bucket", R2_BUCKET, "--key", `programs/studio/${file.key}`, "--body", file.path, "--if-none-match", "*", "--metadata", `sha256=${file.digest}`, "--cache-control", "public,max-age=31536000,immutable"]);
    }
    // Check the actual public delivery path before exposing any new update metadata.
    {
        for (const file of release.binaries) {
            const res = await fetch(`${base}/${file.key}`, { signal: AbortSignal.timeout(120000) });
            if (!res.ok || sha256(Buffer.from(await res.arrayBuffer())) !== file.digest) throw new Error(`Public CDN verification failed: ${file.key}`);
        }
        for (const file of release.feeds) aws(["s3", "cp", file.path, `s3://${R2_BUCKET}/programs/studio/${file.key}`, "--cache-control", "public,max-age=60", "--content-type", "text/yaml"]);
        const manifestPath = join(root, "latest.json");
        writeFileSync(manifestPath, JSON.stringify(release.manifest, null, 2));
        aws(["s3", "cp", manifestPath, `s3://${R2_BUCKET}/programs/studio/latest.json`, "--cache-control", "public,max-age=60", "--content-type", "application/json"]);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, root, target, version] = process.argv.slice(2);
    if (command === "stage") stage(root, target, version);
    else if (command === "publish") await publish(root, target);
    else throw new Error("Usage: studio-release.mjs stage DIR TARGET VERSION | publish DIR VERSION");
}
