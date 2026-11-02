// Stapling the notarization ticket changes DMG bytes; update metadata must describe those final bytes.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const library = createRequire(builder.resolve("app-builder-lib"));
const yaml = library("js-yaml");
const root = resolve(process.argv[2] ?? "release");
function metadata(url) {
    const name = decodeURIComponent(url);
    if (!/^OpenNan-Studio-[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unexpected update filename: ${name}`);
    const bytes = readFileSync(join(root, name));
    return { sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
}
const feeds = readdirSync(root).filter(n => /^latest(?:-mac)?\.yml$/.test(n));
if (!feeds.length) throw new Error("No update metadata to verify");
for (const name of feeds) {
    const path = join(root, name);
    const feed = yaml.load(readFileSync(path, "utf8"));
    if (!Array.isArray(feed.files) || !feed.files.length) throw new Error("Empty update files");
    for (const file of feed.files) {
        Object.assign(file, metadata(file.url));
        if (file.url.endsWith(".dmg")) {
            // macOS updates use the signed ZIP. The pre-staple DMG blockmap is stale.
            delete file.blockMapSize;
            rmSync(join(root, `${decodeURIComponent(file.url)}.blockmap`), { force: true });
        }
    }
    if (feed.path) feed.sha512 = metadata(feed.path).sha512;
    writeFileSync(path, yaml.dump(feed));
}
