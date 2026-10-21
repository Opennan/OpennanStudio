// Auto-update from GitHub Releases (spec §7.2), configured in electron-builder.config.cjs (publish: github)
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
    const check = () => void updater.checkForUpdatesAndNotify().catch((error: unknown) => log(`updates: ${String(error)}`));
    check();
    const timer = setInterval(check, UPDATE_INTERVAL_MS);
    return () => clearInterval(timer);
}
