// Where the desktop app keeps its data. Everything lives under Electron's userData folder except exports,
// which go to the user's Videos folder. Tests and the Playwright smoke point both elsewhere with
// OPENNAN_STUDIO_USER_DATA and OPENNAN_STUDIO_EXPORTS_DIR (absolute paths only).
import fs from "node:fs";
import path from "node:path";
import { caseSafeName } from "../shared/cloud-policy";
import { isProjectRef } from "../shared/ids";

export interface DesktopPaths {
    userData: string;
    database: string;
    media: string;
    projects: string;
    mcp: string;
    tokenFile: string;
    /** Whisper models, downloaded on first use (provider-local's model store). */
    models: string;
    /** OpenNan cloud projects' state files and download temp folder (phase 9a). */
    cloud: string;
    exports: string;
}

export interface PathInputs {
    userData: string;
    videos: string;
    env: Record<string, string | undefined>;
}

const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? path.resolve(value) : null);

export function desktopPaths({ userData, videos, env }: PathInputs): DesktopPaths {
    const data = absolute(env.OPENNAN_STUDIO_USER_DATA) ?? userData;
    const mcp = path.join(data, "mcp");
    return {
        userData: data,
        database: path.join(data, "opennan-studio.sqlite"),
        media: path.join(data, "media"),
        projects: path.join(data, "projects"),
        mcp,
        tokenFile: path.join(mcp, "token"),
        models: path.join(data, "models", "whisper"),
        cloud: path.join(data, "cloud"),
        exports: absolute(env.OPENNAN_STUDIO_EXPORTS_DIR) ?? path.join(videos, "OpenNan Studio"),
    };
}

/**
 * A project's folder (terminal working directory, agent configs). Only ids LocalBackend creates, and cloud project ids
 * (spelled case-safely: server ids are case-sensitive, disks often are not).
 */
export function projectDir(paths: Pick<DesktopPaths, "projects">, projectId: string): string {
    if (!isProjectRef(projectId)) throw new Error("invalid project id");
    return path.join(paths.projects, caseSafeName(projectId));
}

/** Creates the private folders (0700); the exports folder is created by the first export. */
export function ensureDirs(paths: DesktopPaths): void {
    for (const dir of [paths.userData, paths.media, paths.projects, paths.mcp, paths.models, paths.cloud]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
