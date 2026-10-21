// opennan-studio login opens the approval page in the default browser: an argv (never a shell string) for the
// platform's opener, only for https (or this machine's loopback) URLs, and not over SSH or without a display.
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

export function shouldOpenBrowser(env: Record<string, string | undefined>, platform: NodeJS.Platform, noBrowser = false): boolean {
    if (noBrowser) return false;
    if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
    if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    return true;
}

export function isOpenableUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) return false;
        if (parsed.protocol === "https:") return true;
        return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

export function browserCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
    if (platform === "darwin") return { command: "open", args: [url] };
    // start's first quoted argument is the window title; the URL is one argv entry, never parsed by a shell string.
    if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "\"\"", url.replace(/[&^|<>"]/g, (c) => `^${c}`)] };
    return { command: "xdg-open", args: [url] };
}

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => { on(event: "error", listener: () => void): unknown; unref(): void };

export function openBrowser(url: string, options: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {}): boolean {
    if (!isOpenableUrl(url)) return false;
    const { command, args } = browserCommand(url, options.platform ?? process.platform);
    try {
        const child = (options.spawn ?? (nodeSpawn as unknown as SpawnLike))(command, args, { stdio: "ignore", detached: true, shell: false, windowsVerbatimArguments: command === "cmd.exe" });
        child.on("error", () => undefined);
        child.unref();
        return true;
    } catch {
        return false;
    }
}
