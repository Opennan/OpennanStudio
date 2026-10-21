// Which whisper.cpp the desktop app runs (spec §5.9). Packaged builds use only the bundled folder
// (<resources>/whisper). Unpackaged runs (dev, tests, the Playwright smoke) take OPENNAN_WHISPER_DIR when it is
// an absolute path, else the fetched binaries under resources/whisper/<platform>-<arch>/. The folder must hold
// whisper-cli[.exe] and checksums.json; provider-local checks the files against it before the first run.
import fs from "node:fs";
import path from "node:path";

export interface WhisperLookup {
    env: Record<string, string | undefined>;
    resourcesPath: string;
    appPath: string;
    platform: NodeJS.Platform;
    arch: string;
    isPackaged: boolean;
    exists?(file: string): boolean;
}

export type WhisperLocation = { dir: string; reason: null } | { dir: null; reason: string };

export function resolveWhisper(input: WhisperLookup): WhisperLocation {
    const exists = input.exists ?? ((file: string) => fs.existsSync(file));
    const exe = input.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const override = input.env.OPENNAN_WHISPER_DIR;
    const dir = input.isPackaged
        ? path.join(input.resourcesPath, "whisper")
        : override && path.isAbsolute(override) ? override : path.join(input.appPath, "resources", "whisper", `${input.platform}-${input.arch}`);
    if (exists(path.join(dir, exe)) && exists(path.join(dir, "checksums.json"))) return { dir, reason: null };
    return { dir: null, reason: `This build has no whisper.cpp for ${input.platform}-${input.arch}, so auto captions are not available.` };
}
