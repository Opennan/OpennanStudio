// pnpm --filter @opennan/desktop check:whisper [dir]: the bundled whisper.cpp folder must carry its MIT license,
// the models' MIT notice, SOURCE.txt for the pinned version, and checksums.json matching every shipped file
// (provider-local checks the same list before the first run). On the host platform whisper-cli must run.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
export const NOTICE_FILES = ["LICENSE.txt", "MODELS-LICENSE.txt", "SOURCE.txt", "checksums.json"];

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** Problems with one resources/whisper/<platform>-<arch> folder. `run` runs whisper-cli --help (host only). */
export function whisperProblems(dir, { platform = path.basename(dir).split("-")[0], run = null } = {}) {
    const problems = [];
    const license = read(path.join(dir, "LICENSE.txt"));
    if (!/MIT License/.test(license) || !/(The ggml authors|Georgi Gerganov)/.test(license)) problems.push("LICENSE.txt is not whisper.cpp's MIT license");
    if (/GNU (Lesser )?General Public/i.test(license)) problems.push("LICENSE.txt mentions the GPL");
    const models = read(path.join(dir, "MODELS-LICENSE.txt"));
    if (!/MIT License/.test(models) || !/OpenAI/.test(models)) problems.push("MODELS-LICENSE.txt is not the whisper models' MIT notice");
    const source = read(path.join(dir, "SOURCE.txt"));
    if (!source.includes(`whisper.cpp ${MANIFEST.version}`) || !source.includes(MANIFEST.source.sha256)) problems.push("SOURCE.txt does not name the pinned whisper.cpp version and source SHA-256");
    let checksums = null;
    try {
        checksums = JSON.parse(read(path.join(dir, "checksums.json")) || "null");
    } catch {
        checksums = null;
    }
    const files = checksums && typeof checksums.files === "object" && checksums.files ? checksums.files : null;
    if (!files) {
        problems.push("checksums.json is missing or lists no files");
        return problems;
    }
    const exe = platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    if (!files[exe]) problems.push(`checksums.json does not list ${exe}`);
    for (const [name, expected] of Object.entries(files)) {
        const file = path.join(dir, name);
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || name.includes("..")) problems.push(`checksums.json names an invalid file: ${name}`);
        else if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) problems.push(`${name} is listed but missing`);
        else if (sha256(file) !== expected) problems.push(`${name} does not match checksums.json`);
    }
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!NOTICE_FILES.includes(name) && !files[name]) problems.push(`${name} is not listed in checksums.json`);
    }
    if (run && files[exe]) {
        try {
            const help = run(path.join(dir, exe));
            if (!/--output-json/.test(help)) problems.push("whisper-cli --help does not list --output-json");
        } catch (error) {
            problems.push(`whisper-cli does not run: ${error.message.split("\n")[0]}`);
        }
    }
    return problems;
}

/** whisper-cli --help (it prints its usage on stderr): both streams, or a throw on failure. */
export function runHelp(exe) {
    const out = spawnSync(exe, ["--help"], { encoding: "utf8", timeout: 10_000 });
    if (out.error) throw out.error;
    if (out.status !== 0) throw new Error(`exit ${out.status}`);
    return `${out.stdout}${out.stderr}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const key = `${process.platform}-${process.arch}`;
    const dir = path.resolve(process.argv[2] ?? path.join(HERE, "..", "resources", "whisper", key));
    const problems = whisperProblems(dir, { run: path.basename(dir) === key ? runHelp : null });
    if (problems.length > 0) {
        console.error(`check-whisper: ${dir}\n${problems.join("\n")}`);
        process.exit(1);
    }
    console.log(`check-whisper: whisper.cpp ${MANIFEST.version} (MIT) in ${dir}${path.basename(dir) === key ? ", whisper-cli runs" : ""}`);
}
