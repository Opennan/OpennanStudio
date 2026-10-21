// Which ffmpeg the desktop export runs. Packaged builds use only the bundled LGPL binary
// (<resources>/ffmpeg). Unpackaged runs (dev, tests, the Playwright smoke) take OPENNAN_FFMPEG and
// OPENNAN_FFPROBE when both are set, else the fetched binaries under resources/ffmpeg/<platform>-<arch>/.
import fs from "node:fs";
import path from "node:path";

export interface FfmpegPaths {
    ffmpegPath: string;
    ffprobePath: string;
}

export interface FfmpegLookup {
    env: Record<string, string | undefined>;
    resourcesPath: string;
    appPath: string;
    platform: NodeJS.Platform;
    arch: string;
    isPackaged: boolean;
    exists?(file: string): boolean;
}

export function resolveFfmpeg(input: FfmpegLookup): FfmpegPaths | null {
    const exists = input.exists ?? ((file: string) => fs.existsSync(file));
    const exe = input.platform === "win32" ? ".exe" : "";
    let dir: string;
    if (input.isPackaged) {
        dir = path.join(input.resourcesPath, "ffmpeg");
    } else if (input.env.OPENNAN_FFMPEG && input.env.OPENNAN_FFPROBE) {
        const paths = { ffmpegPath: input.env.OPENNAN_FFMPEG, ffprobePath: input.env.OPENNAN_FFPROBE };
        return exists(paths.ffmpegPath) && exists(paths.ffprobePath) ? paths : null;
    } else {
        dir = path.join(input.appPath, "resources", "ffmpeg", `${input.platform}-${input.arch}`);
    }
    const paths = { ffmpegPath: path.join(dir, `ffmpeg${exe}`), ffprobePath: path.join(dir, `ffprobe${exe}`) };
    return exists(paths.ffmpegPath) && exists(paths.ffprobePath) ? paths : null;
}
