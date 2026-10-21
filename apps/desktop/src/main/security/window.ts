// The one window and its renderer: Electron's security checklist applied (spec §7.2). The renderer runs
// sandboxed with context isolation and no Node; it may not navigate away from the app, open windows,
// attach webviews, or get permissions beyond clipboard writes and fullscreen.
import type { BrowserWindowConstructorOptions } from "electron";
import { originOf } from "../ipc/handle";
import { APP_ORIGIN } from "../protocol/csp";

export function windowOptions(preload: string, extraArgs: string[] = []): BrowserWindowConstructorOptions {
    return {
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 700,
        show: false,
        backgroundColor: "#111214",
        title: "OpenNan Studio",
        webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            spellcheck: false,
            navigateOnDragDrop: false,
            safeDialogs: true,
            additionalArguments: extraArgs,
        },
    };
}

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

export function permissionAllowed(permission: string): boolean {
    return ALLOWED_PERMISSIONS.has(permission);
}

/** Links that may open in the user's browser: https only, no credentials. */
export function isSafeExternalUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

interface PreventableEvent {
    preventDefault(): void;
}

export interface WebContentsLike {
    on(event: "will-navigate" | "will-redirect", listener: (event: PreventableEvent, url: string) => void): unknown;
    on(event: "will-attach-webview", listener: (event: PreventableEvent) => void): unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" } | { action: "allow" }): void;
}

export function hardenContents(contents: WebContentsLike, openExternal: (url: string) => void, appOrigin = APP_ORIGIN): void {
    const keepInApp = (event: PreventableEvent, url: string) => {
        if (originOf(url) !== appOrigin) event.preventDefault();
    };
    contents.on("will-navigate", keepInApp);
    contents.on("will-redirect", keepInApp);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) openExternal(url);
        return { action: "deny" };
    });
}

export interface SessionLike {
    setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
    setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
}

export function lockPermissions(session: SessionLike): void {
    session.setPermissionRequestHandler((_contents, permission, callback) => callback(permissionAllowed(permission)));
    session.setPermissionCheckHandler((_contents, permission) => permissionAllowed(permission));
}

/** Debugging switches a packaged build refuses: the fuses stop --inspect, Chromium's remote debugging needs this. */
export function forbiddenDebugSwitches(argv: readonly string[], hasSwitch: (name: string) => boolean): string[] {
    const found = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"].filter((name) => hasSwitch(name));
    for (const arg of argv) if (/^--(inspect|inspect-brk|remote-debugging|js-flags)/.test(arg)) found.push(arg.split("=")[0]);
    return [...new Set(found)];
}
