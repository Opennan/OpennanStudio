// Auto-update from the platform's Cloudflare R2 feed, configured in electron-builder.config.cjs.
// but off unless a release build sets "opennanUpdates": true in its package.json (OPENNAN_RELEASE_UPDATES at
// package time). Never on in unpackaged runs, and OPENNAN_DISABLE_UPDATES=1 turns it off anywhere.
export interface UpdateGate {
    isPackaged: boolean;
    packageJson: { opennanUpdates?: unknown };
    env: Record<string, string | undefined>;
}

export function updatesEnabled({ isPackaged, packageJson, env }: UpdateGate): boolean {
    return isPackaged && packageJson.opennanUpdates === true && env.OPENNAN_DISABLE_UPDATES !== "1";
}

export interface UpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowPrerelease?: boolean;
    allowDowngrade?: boolean;
    on?(event: "error", listener: (error: Error) => void): unknown;
    removeListener?(event: "error", listener: (error: Error) => void): unknown;
    checkForUpdatesAndNotify(): Promise<unknown>;
}

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Starts update checks when enabled; returns a stop function. The updater module loads only when enabled. */
export function startUpdates(gate: UpdateGate, load: () => UpdaterLike, log: (message: string) => void = () => undefined): () => void {
    if (!updatesEnabled(gate)) return () => undefined;
    let updater: UpdaterLike;
    try {
        updater = load();
    } catch (error) {
        log(`updates: ${String(error)}`);
        return () => undefined;
    }
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    const onError = (error: unknown) => log(`updates: ${String(error)}`);
    updater.on?.("error", onError);
    let pending = false;
    const check = async () => {
        if (pending) return;
        pending = true;
        try { await updater.checkForUpdatesAndNotify(); }
        catch (error) { onError(error); }
        finally { pending = false; }
    };
    check();
    const timer = setInterval(check, UPDATE_INTERVAL_MS);
    return () => {
        clearInterval(timer);
        updater.removeListener?.("error", onError);
    };
}
