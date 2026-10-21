// The Share dialog's host for one cloud project (phase 9c): reads the project's view-only links, creates one (or
// rotates it: the old link stops at once), turns the active one off, copies its link (only the checked share URL, on a
// click), and remembers the expiry and download options per device (never a token or a URL). A project with nothing
// to show gets Export and share: the editor's export (the GPU path when it can run), uploaded with the project's id,
// set as the project's final video, then the link — each step shown, with one Cancel until the upload is done. Every
// refusal maps to a code the dialog words itself.
import {
    createShare, isAbortError, isCloudApiError, listShares, revokeShare, stopSharing, SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS, SHARE_MIN_DAYS,
    type CloudApi, type ShareLink, type ShareSite,
} from "@opennan/cloud-backend";
import type { ExportResult } from "@opennan/export";

export const SHARE_OPTIONS_KEY = "opennan-studio:share-options";
/** How long "Link copied" shows. */
export const COPIED_MS = 2_000;

export type ShareErrorCode =
    | "limit" | "nothing_to_show" | "rate_limited" | "signed_out" | "not_found" | "network" | "server" | "copy_failed" | "export_failed" | "upload_failed"
    | "storage_full" | "final_video_refused";

export interface ShareError {
    code: ShareErrorCode;
    retryAfterSeconds?: number;
    /** A short plain line (the exporter's own words) for export_failed. */
    detail?: string;
}

export interface ShareOptionsState {
    days: number;
    allowDownload: boolean;
}

export type ExportShareStep = "export" | "upload" | "saving" | "link";

export interface ShareState {
    status: "loading" | "ready" | "error";
    links: ShareLink[];
    active: ShareLink | null;
    options: ShareOptionsState;
    busy: null | "create" | "rotate" | "turn-off";
    error: ShareError | null;
    /** The last create said the project has nothing to show (offer Export and share). */
    nothingToShow: boolean;
    copied: boolean;
    exporting: { step: ExportShareStep; ratio: number | null; cancellable: boolean } | null;
}

export interface ShareHostDeps {
    api: CloudApi;
    /** The project's server id. */
    serverId: string;
    site: ShareSite;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    /** Writes the link to the clipboard (a click started it). */
    clipboard?(text: string): Promise<void>;
    isSignedIn(): boolean;
    openSignIn(): Promise<boolean>;
    /** Exports the timeline as a video; rejects with an AbortError when `signal` aborts. Absent: no Export and share. */
    exportVideo?(options: { signal: AbortSignal; onProgress(ratio: number): void }): Promise<ExportResult>;
    /** Uploads an export with the project's id (cloud media upload). */
    uploadExport?(result: ExportResult, serverId: string, options: { signal: AbortSignal; onProgress(ratio: number): void }): Promise<{ mediaUrl: string }>;
    /** Sets project.final_video_url in a changeset (resolves once OpenNan stored it). */
    setFinalVideo?(mediaUrl: string): Promise<void>;
    /** An Export and share run ended (success, failure or cancel): the exporter's result can be let go. */
    exportFinished?(): void;
    setTimeout?(callback: () => void, ms: number): unknown;
    clearTimeout?(handle: unknown): void;
}

function readOptions(storage: ShareHostDeps["storage"]): ShareOptionsState {
    try {
        const raw = JSON.parse(storage?.getItem(SHARE_OPTIONS_KEY) ?? "null") as { days?: unknown; allowDownload?: unknown } | null;
        const days = typeof raw?.days === "number" && Number.isInteger(raw.days) ? clampDays(raw.days) : SHARE_DEFAULT_DAYS;
        return { days, allowDownload: raw?.allowDownload === true };
    } catch {
        return { days: SHARE_DEFAULT_DAYS, allowDownload: false };
    }
}

function clampDays(days: number): number {
    if (!Number.isFinite(days)) return SHARE_DEFAULT_DAYS;
    return Math.max(SHARE_MIN_DAYS, Math.min(SHARE_MAX_DAYS, Math.round(days)));
}

const STORAGE_CODES = new Set(["storage_quota_exceeded", "storage_full", "free_storage_pool_full", "upload_daily_limit", "media_quota_exceeded"]);

/** A refusal as the dialog's code. */
export function shareErrorOf(error: unknown, fallback: ShareErrorCode = "server"): ShareError {
    if (!isCloudApiError(error)) return { code: fallback };
    switch (error.code) {
        case "share_limit_reached": return { code: "limit" };
        case "share_nothing_to_show": return { code: "nothing_to_show" };
        case "rate_limit_exceeded": case "rate_limited":
            return { code: "rate_limited", ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
        case "signed_out": case "invalid_api_key": case "unauthorized": return { code: "signed_out" };
        case "not_found": case "project_not_found": return { code: "not_found" };
        case "network": return { code: "network" };
        default:
            if (STORAGE_CODES.has(error.code)) return { code: "storage_full" };
            if (error.status === 401) return { code: "signed_out" };
            if (error.status === 404) return { code: "not_found" };
            if (error.status === 429) return { code: "rate_limited", ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
            if (error.status === 0) return { code: "network" };
            return { code: fallback };
    }
}

/** One short plain line of the exporter's own words (never a path or a log). */
function plainDetail(error: unknown): string | undefined {
    const text = error instanceof Error ? error.message.trim() : "";
    if (!text || text.length > 160 || /[\n\r<>]|\/|\\|https?:/.test(text)) return undefined;
    return text;
}

export class ShareHost {
    private state: ShareState;
    private readonly listeners = new Set<() => void>();
    private run: AbortController | null = null;
    private copiedTimer: unknown = null;
    private disposed = false;

    constructor(private readonly deps: ShareHostDeps) {
        this.state = { status: "loading", links: [], active: null, options: readOptions(deps.storage), busy: null, error: null, nothingToShow: false, copied: false, exporting: null };
    }

    snapshot(): ShareState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private set(patch: Partial<ShareState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }

    private withLinks(links: ShareLink[]): Partial<ShareState> {
        return { links, active: links.find((l) => l.status === "active") ?? null };
    }

    private async signedIn(): Promise<boolean> {
        if (this.deps.isSignedIn()) return true;
        return this.deps.openSignIn();
    }

    canExportAndShare(): boolean {
        return Boolean(this.deps.exportVideo && this.deps.uploadExport && this.deps.setFinalVideo);
    }

    async load(): Promise<void> {
        if (!this.deps.isSignedIn()) {
            this.set({ status: "error", error: { code: "signed_out" } });
            return;
        }
        this.set({ status: "loading" });
        try {
            const links = await listShares(this.deps.api, this.deps.serverId, this.deps.site);
            this.set({ status: "ready", error: null, ...this.withLinks(links) });
        } catch (error) {
            this.set({ status: "error", error: shareErrorOf(error) });
        }
    }

    /** Reads the links again after a failure (signing in first when that was the reason). */
    async retry(): Promise<boolean> {
        if (!this.deps.isSignedIn() && !(await this.deps.openSignIn())) return false;
        await this.load();
        return this.state.status === "ready";
    }

    setOptions(patch: Partial<ShareOptionsState>): void {
        const options = { ...this.state.options, ...patch };
        options.days = clampDays(options.days);
        options.allowDownload = options.allowDownload === true;
        try {
            this.deps.storage?.setItem(SHARE_OPTIONS_KEY, JSON.stringify(options));
        } catch {
            // not remembered
        }
        this.set({ options });
    }

    /** Creates the project's link with the chosen options. */
    create(): Promise<boolean> {
        return this.make("create");
    }

    /** A new link with the chosen options: the current one stops working at once. */
    rotate(): Promise<boolean> {
        return this.make("rotate");
    }

    private async make(kind: "create" | "rotate"): Promise<boolean> {
        if (this.state.busy) return false;
        if (!(await this.signedIn())) return false;
        this.set({ busy: kind, error: null, copied: false });
        try {
            const { link, replaced } = await createShare(this.deps.api, this.deps.serverId, { expiresInDays: this.state.options.days, allowDownload: this.state.options.allowDownload }, this.deps.site);
            const at = Date.now();
            const older = this.state.links.filter((l) => l.id !== link.id).map((l) => (replaced.includes(l.id) || l.status === "active" ? { ...l, status: "revoked" as const, url: null, revokedAt: l.revokedAt ?? at } : l));
            this.set({ busy: null, nothingToShow: false, ...this.withLinks([link, ...older]) });
            return true;
        } catch (error) {
            const failure = shareErrorOf(error);
            this.set({ busy: null, error: failure, nothingToShow: failure.code === "nothing_to_show" });
            if (failure.code === "signed_out") void this.deps.openSignIn();
            return false;
        }
    }

    /** Turns the active link off (views stop at once). */
    async turnOff(): Promise<boolean> {
        const active = this.state.active;
        if (!active || this.state.busy) return false;
        if (!(await this.signedIn())) return false;
        this.set({ busy: "turn-off", error: null, copied: false });
        try {
            const actives = this.state.links.filter((l) => l.status === "active");
            if (actives.length > 1) {
                // OpenNan answers exactly the links it changed (9c.1). One shown active that it left alone changed some other
                // way meanwhile (expired, or turned off elsewhere): the list is read again rather than guessed.
                const changed = new Map((await stopSharing(this.deps.api, this.deps.serverId, this.deps.site)).map((l) => [l.id, l]));
                const links = actives.every((l) => changed.has(l.id))
                    ? this.state.links.map((l) => changed.get(l.id) ?? l)
                    : await listShares(this.deps.api, this.deps.serverId, this.deps.site);
                this.set({ busy: null, ...this.withLinks(links) });
            } else {
                const revoked = await revokeShare(this.deps.api, this.deps.serverId, active.id, this.deps.site);
                this.set({ busy: null, ...this.withLinks(this.state.links.map((l) => (l.id === revoked.id ? revoked : l))) });
            }
            return true;
        } catch (error) {
            this.set({ busy: null, error: shareErrorOf(error) });
            return false;
        }
    }

    /** Copies the active link (the checked share URL). */
    async copy(): Promise<boolean> {
        const url = this.state.active?.url;
        if (!url) return false;
        try {
            if (!this.deps.clipboard) throw new Error("no clipboard");
            await this.deps.clipboard(url);
        } catch {
            this.set({ error: { code: "copy_failed" }, copied: false });
            return false;
        }
        this.set({ copied: true, error: null });
        const setTimer = this.deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
        const clearTimer = this.deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        if (this.copiedTimer !== null) clearTimer(this.copiedTimer);
        this.copiedTimer = setTimer(() => {
            this.copiedTimer = null;
            this.set({ copied: false });
        }, COPIED_MS);
        return true;
    }

    /** Export and share: export → upload (with the project's id) → final video → link. */
    async exportAndShare(): Promise<boolean> {
        const { exportVideo, uploadExport, setFinalVideo } = this.deps;
        if (!exportVideo || !uploadExport || !setFinalVideo || this.state.exporting || this.state.busy) return false;
        if (!(await this.signedIn())) return false;
        const run = new AbortController();
        this.run = run;
        this.set({ error: null, exporting: { step: "export", ratio: 0, cancellable: true } });
        let step: ExportShareStep = "export";
        try {
            const result = await exportVideo({ signal: run.signal, onProgress: (ratio) => this.progress("export", ratio, run) });
            if (run.signal.aborted) throw abortError();
            step = "upload";
            this.set({ exporting: { step, ratio: 0, cancellable: true } });
            const { mediaUrl } = await uploadExport(result, this.deps.serverId, { signal: run.signal, onProgress: (ratio) => this.progress("upload", ratio, run) });
            if (run.signal.aborted) throw abortError();
            // From here nothing is left to cancel: the export is OpenNan's, the link follows.
            step = "saving";
            this.set({ exporting: { step, ratio: null, cancellable: false } });
            await setFinalVideo(mediaUrl);
            // Closed meanwhile: the export is the project's now; no link is made behind the person's back.
            if (this.disposed) return false;
            step = "link";
            this.set({ exporting: { step, ratio: null, cancellable: false } });
            this.set({ exporting: null });
            return await this.create();
        } catch (error) {
            if (isAbortError(error) || run.signal.aborted) {
                this.set({ exporting: null, error: null });
                return false;
            }
            const failure: ShareError = step === "export"
                ? { code: "export_failed", ...(plainDetail(error) ? { detail: plainDetail(error)! } : {}) }
                : step === "upload" ? shareErrorOf(error, "upload_failed")
                : shareErrorOf(error, "final_video_refused");
            this.set({ exporting: null, error: failure });
            return false;
        } finally {
            if (this.run === run) this.run = null;
            this.deps.exportFinished?.();
        }
    }

    private progress(step: "export" | "upload", ratio: number, run: AbortController): void {
        if (this.run !== run || run.signal.aborted) return;
        this.set({ exporting: { step, ratio: Math.max(0, Math.min(1, ratio)), cancellable: true } });
    }

    /** Stops the export or the upload (no effect once the export is being set on the project). */
    cancelExport(): void {
        if (!this.state.exporting?.cancellable) return;
        this.run?.abort();
    }

    dismissError(): void {
        this.set({ error: null });
    }

    dispose(): void {
        if (this.state.exporting?.cancellable) this.run?.abort();
        if (this.copiedTimer !== null) (this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.copiedTimer);
        this.disposed = true;
        this.listeners.clear();
    }
}

function abortError(): Error {
    const error = new Error("Cancelled.");
    error.name = "AbortError";
    return error;
}
