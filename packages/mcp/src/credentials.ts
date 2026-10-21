// The CLI's OpenNan credentials (opennan-studio login): ~/.config/opennan-studio/credentials.json
// ($XDG_CONFIG_HOME honoured; %APPDATA%\opennan-studio\credentials.json on Windows), folder 0700, file 0600.
// OPENNAN_API_KEY overrides the file. The key is never printed.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CredentialStore, StoredCredential } from "@opennan/provider-opennan";
import { writePrivateFile } from "./private-file";

export const API_KEY_ENV = "OPENNAN_API_KEY";
export const API_BASE_ENV = "OPENNAN_API_BASE";

export interface CliCredential extends StoredCredential {
    /** The API this key belongs to, when not api.opennan.com (login --api). */
    apiBase?: string;
}

export function credentialsPath(env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "opennan-studio", "credentials.json");
    const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
    return path.join(config, "opennan-studio", "credentials.json");
}

export async function readCredentials(file: string): Promise<CliCredential | null> {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf8");
    } catch {
        return null;
    }
    try {
        const value = JSON.parse(raw) as CliCredential;
        if (typeof value?.apiKey !== "string" || typeof value.keyId !== "string") return null;
        return value;
    } catch {
        return null;
    }
}

export async function writeCredentials(file: string, credential: CliCredential): Promise<void> {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a new folder: an existing one is made private too, and must not be a symlink.
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} must be a folder, not a symlink`);
    if (process.platform !== "win32") await fs.chmod(dir, 0o700);
    await writePrivateFile(file, `${JSON.stringify(credential, null, 2)}\n`);
}

export async function deleteCredentials(file: string): Promise<boolean> {
    try {
        await fs.unlink(file);
        return true;
    } catch {
        return false;
    }
}

/** A CredentialStore over the file (OpenNanSession for login/logout/whoami and mcp serve). */
export function fileCredentialStore(file: string, apiBase?: string): CredentialStore {
    return {
        get: () => readCredentials(file),
        set: (credential) => writeCredentials(file, { ...credential, ...(apiBase ? { apiBase } : {}) }),
        clear: async () => {
            await deleteCredentials(file);
        },
        persistence: () => "persistent",
    };
}

/** A read-only store over OPENNAN_API_KEY: sign-out cannot delete an environment variable. */
export function envCredentialStore(apiKey: string): CredentialStore {
    return {
        get: async () => ({ apiKey: apiKey.trim(), keyId: "env" }),
        set: async () => undefined,
        clear: async () => undefined,
        persistence: () => "session",
    };
}
