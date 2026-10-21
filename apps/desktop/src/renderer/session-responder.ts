// Answers main's session requests with the open editor's controller, store, and backend, so MCP tools run on
// the same controller (and undo history) as the person (spec §5.1.1, §7.2). The UI-state mapping mirrors
// @opennan/mcp's createControllerSession (typed by its StudioUiState); importing that module here would put
// the MCP SDK and Ajv into the renderer bundle. Phase 9a: the cloud.* methods answer agents' cloud project tools from
// the runtime's cloud seam (list, Save to OpenNan of the open project, open, sync status), signed out → an error.
// Phase 9b: cloud.quote / cloud.run / cloud.edit / cloud.script answer the project pipeline tools (session-pipelines.ts).
// Phase 9c: cloud.shareCreate / cloud.shareList / cloud.shareRevoke answer the share link tools over the cloud API client
// (only the checked share URL goes back to main). Phase 9c.1: confirmShare asks the person before an agent's public link
// (main decides when to ask and counts no answer as no); links are built on the account's share_base_url.
import {
    createShare, isCloudApiError, listShares, revokeShare, stopSharing, type OpenNanCloudBackend, type ShareLink, type ShareSite, type SyncState,
} from "@opennan/cloud-backend";
import type { StudioUiState } from "@opennan/mcp/server";
import type { EditorCommand, EditorStore, LocalBackend, ProjectSummary, TimelineBackend, TimelineController, UploadedMedia } from "@opennan/timeline-core";
import type { DesktopBridge } from "../shared/bridge";
import { createResponderPipelines } from "./session-pipelines";

export interface ResponderCloud {
    /** The signed-in account's cloud backend (null while signed out). */
    backend(): OpenNanCloudBackend | null;
    /** Local projects (Save to OpenNan moves the open one from here). */
    local: LocalBackend;
    /** The sync chip's words (the shell's syncLabel); the state's kind without it. */
    syncLabel?(state: SyncState): string;
}

export interface SessionResponderOptions {
    bridge: Pick<DesktopBridge, "session">;
    projectId: string;
    controller: TimelineController;
    store: EditorStore;
    backend: TimelineBackend;
    cloud?: ResponderCloud;
    /** Shows a project in the editor (the hash route); runs after the answer is sent. */
    openProject?(projectId: string): void;
    /** Where share pages live: the account's share_base_url, read when a link is made (none: https://opennan.com/s). */
    shareSite?(): ShareSite;
    /** Tells the person something an agent did that they would want to know (a toast). */
    notify?(message: string): void;
    /**
     * Asks the person whether an agent may make a public link (9c.1): the editor's dialog. Closes when `signal` aborts
     * (no answer in time). Absent: every agent link is declined.
     */
    confirmShare?(question: ShareQuestion): Promise<"allow" | "allow-session" | "deny">;
    /** How long the question stays open (SHARE_CONFIRM_MS); tests shorten it. */
    shareConfirmMs?: number;
}

export interface ShareQuestion {
    projectName: string;
    signal: AbortSignal;
}

/**
 * The project's name as the question shows it: an agent can rename the project, so only plain words (no quotes, line
 * breaks or control characters), at most 80 characters.
 */
export function shownName(name: string | null | undefined): string {
    const plain = (name ?? "").replace(/[\u0000-\u001f\u007f-\u009f"\u201c\u201d\u2018\u2019'`\u00ab\u00bb\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
    if (!plain) return "this project";
    return plain.length > 80 ? `${plain.slice(0, 79)}\u2026` : plain;
}

/** The person has 2 minutes to answer an agent's public link; no answer counts as no. */
export const SHARE_CONFIRM_MS = 2 * 60_000;

/** @opennan/mcp's StudioCloudProject (the row main checks and copies field by field). */
export interface CloudProjectRow {
    id: string;
    name: string;
    aspectRatio: string;
    durationSeconds: number;
    mediaBytes: number;
    updatedAt: number;
    lastEditedDevice: string | null;
    origin: "studio" | "web";
    deletedAt: number | null;
}

export const CLOUD_SIGN_IN = "Sign in with OpenNan to use cloud projects.";
const CLOUD_ID = /^cloud-[A-Za-z0-9_-]{1,36}$/;
const MAX_CURSOR = 500;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function cloudProjectOf(summary: ProjectSummary): CloudProjectRow {
    return {
        id: summary.id, name: summary.name, aspectRatio: summary.aspectRatio, durationSeconds: summary.durationSeconds, mediaBytes: summary.mediaBytes ?? 0,
        updatedAt: summary.updatedAt, lastEditedDevice: summary.lastEditedDevice ?? null, origin: summary.origin ?? "web", deletedAt: summary.deletedAt ?? null,
    };
}

export function uiStateOf(store: EditorStore): StudioUiState {
    const s = store.getState();
    return {
        currentTime: s.currentTime,
        isPlaying: s.isPlaying,
        shuttleSpeed: s.shuttleSpeed,
        zoom: s.timelineZoom,
        toolMode: s.toolMode,
        snapEnabled: s.snapEnabled,
        selection: {
            clipIds: [...s.selectedClipIds],
            sceneId: s.selectedSceneId,
            transition: s.selectedTransition,
            audioTarget: s.selectedAudioTarget,
            markerId: s.selectedMarkerId,
        },
        markers: s.timelineMarkers.map((marker) => ({ ...marker })),
        canUndo: s.canUndo,
        canRedo: s.canRedo,
        activePanel: null,
    };
}

/** Plain data for IPC (structured clone): drops anything a snapshot might carry that is not JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** OpenNan's share refusals in an agent's words (phase 9c). */
function shareRefusal(error: unknown): Error {
    if (!isCloudApiError(error)) return error instanceof Error ? error : new Error(String(error));
    switch (error.code) {
        case "share_nothing_to_show": return new Error("This project has nothing to show yet: export it in OpenNan Studio (Share → Export and share) or add a scene with a video or picture first.");
        case "share_limit_reached": return new Error("The account has 50 active share links: turn one off first (revoke_share_link on that project).");
        case "rate_limit_exceeded": case "rate_limited": return new Error(`Too many share links made: try again${error.retryAfterSeconds ? ` in ${error.retryAfterSeconds} s` : " later"}.`);
        case "not_found": return new Error("This project is no longer on OpenNan, or that link is not this project's.");
        default: return new Error(error.message || "OpenNan refused it.");
    }
}

const SHARE_ID = /^shr_[0-9a-f]{24}$/;

export const AGENT_SHARED = "An agent made a view-only share link of this project. Share shows it and can turn it off.";
export const AGENT_UNSHARED = "An agent turned off this project's share link.";

export function createSessionResponder({ projectId, controller, store, backend, cloud, openProject, shareSite, notify, confirmShare, shareConfirmMs }: Omit<SessionResponderOptions, "bridge">) {
    const site = (): ShareSite => shareSite?.() ?? {};
    const shareable = (): OpenNanCloudBackend => {
        if (!CLOUD_ID.test(projectId)) throw new Error("Share links need a cloud project: save it to OpenNan first.");
        return cloudBackend();
    };
    const sharing = async <T>(run: (api: OpenNanCloudBackend["api"], serverId: string) => Promise<T>): Promise<T> => {
        const built = shareable();
        try {
            return await run(built.api, built.serverId(projectId));
        } catch (error) {
            throw shareRefusal(error);
        }
    };
    const shareView = (link: ShareLink) => ({
        id: link.id, url: link.url, status: link.status, allowDownload: link.allowDownload, expiresAt: link.expiresAt, createdAt: link.createdAt, revokedAt: link.revokedAt,
        views: link.views, lastViewedAt: link.lastViewedAt,
    });
    // Agent share questions open in the editor: main's "cancelConfirmShare" (the agent's call ended) closes them.
    const openQuestions = new Set<AbortController>();
    // Agent ai.run commands in flight: main's "cancelAiRun" (a cancelled or timed-out MCP call) aborts them.
    const agentRuns = new Set<AbortController>();
    const cloudBackend = (): OpenNanCloudBackend => {
        const built = cloud?.backend() ?? null;
        if (!built) throw new Error(CLOUD_SIGN_IN);
        return built;
    };
    const argument = (args: unknown[]): Record<string, unknown> => {
        const value = args[0] ?? {};
        if (!isRecord(value)) throw new Error("Invalid cloud request");
        return value;
    };
    // After the answer has gone back to main: the editor then leaves this project (and this session detaches).
    const show = (id: string) => void setTimeout(() => openProject?.(id), 0);
    const pipelines = createResponderPipelines({ projectId, backend: cloudBackend, controller });
    return async (method: string, args: unknown[]): Promise<unknown> => {
        switch (method) {
            case "execute": {
                const command = args[0] as EditorCommand;
                if (command?.type !== "ai.run") return plain(await controller.execute(command));
                const abort = new AbortController();
                agentRuns.add(abort);
                try {
                    return plain(await controller.execute(command, { signal: abort.signal }));
                } finally {
                    agentRuns.delete(abort);
                }
            }
            case "cancelAiRun":
                for (const abort of agentRuns) abort.abort();
                return undefined;
            case "snapshot":
                return plain(controller.snapshot());
            case "describeTimeline":
                return controller.describeTimeline();
            case "uiState":
                return plain(uiStateOf(store));
            case "historyDepth":
                return controller.historyDepth();
            case "listEffects":
                return backend.listEffects ? plain(await backend.listEffects(args[0] === "transition" ? "transition" : "effect")) : [];
            case "saveToLibrary":
                await backend.saveToLibrary?.(projectId, args[0] as UploadedMedia);
                return undefined;
            case "cloud.list": {
                const { trash, cursor } = argument(args);
                if ((trash !== undefined && typeof trash !== "boolean") || (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || cursor.length > MAX_CURSOR))) throw new Error("Invalid cloud request");
                const page = await cloudBackend().listCloudProjects({ state: trash ? "deleted" : "active", cursor: (cursor as string | null | undefined) ?? null });
                return plain({ projects: page.projects.map(cloudProjectOf), nextCursor: page.nextCursor });
            }
            case "cloud.save": {
                argument(args);
                if (CLOUD_ID.test(projectId)) throw new Error("The open project is already an OpenNan cloud project.");
                const built = cloudBackend();
                const saved = await built.saveLocalProject(cloud!.local, projectId);
                show(saved.id);
                return { projectId: saved.id, name: saved.name };
            }
            case "cloud.open": {
                const { projectId: target } = argument(args);
                if (typeof target !== "string" || !CLOUD_ID.test(target)) throw new Error("project_id must be a cloud project id (\"cloud-…\").");
                const built = cloudBackend();
                if (!(await built.hasProject(target))) throw new Error("There is no such OpenNan cloud project (or it is in the trash).");
                const meta = await built.loadProject(target);
                show(target);
                return { projectId: target, name: meta.name };
            }
            case "cloud.status": {
                const { projectId: asked } = argument(args);
                if (asked !== undefined && typeof asked !== "string") throw new Error("Invalid cloud request");
                const target = (asked as string | undefined) ?? projectId;
                if (!CLOUD_ID.test(target)) return null;
                const state = cloudBackend().syncState(target);
                if (!state) return { projectId: target, state: "closed", label: "Not open in the editor on this device.", pending: 0, conflicts: [] };
                return {
                    projectId: target, state: state.kind, label: cloud?.syncLabel?.(state) ?? state.kind, pending: "pending" in state ? state.pending : 0,
                    conflicts: state.kind === "conflict" ? state.items.map((item) => item.message) : [],
                };
            }
            case "cloud.quote":
                return plain(await pipelines.quote(args[0]));
            case "cloud.run":
                return plain(await pipelines.run(args[0]));
            case "cloud.edit":
                return plain(await pipelines.edit(args[0]));
            case "cloud.script":
                return pipelines.script(args[0]);
            case "cloud.shareCreate": {
                const { expiresInDays, allowDownload } = argument(args);
                if ((expiresInDays !== undefined && !(typeof expiresInDays === "number" && Number.isInteger(expiresInDays))) || (allowDownload !== undefined && typeof allowDownload !== "boolean")) throw new Error("Invalid cloud request");
                const link = await sharing(async (api, serverId) => shareView((await createShare(api, serverId, {
                    ...(expiresInDays !== undefined ? { expiresInDays: expiresInDays as number } : {}), allowDownload: allowDownload === true,
                }, site())).link));
                notify?.(AGENT_SHARED);
                return link;
            }
            case "cloud.shareList":
                argument(args);
                return sharing(async (api, serverId) => (await listShares(api, serverId, site())).map(shareView));
            case "cloud.shareRevoke": {
                const { shareId } = argument(args);
                if (shareId !== undefined && (typeof shareId !== "string" || !SHARE_ID.test(shareId))) throw new Error("Invalid cloud request");
                const revoked = await sharing(async (api, serverId) => (shareId ? [await revokeShare(api, serverId, shareId as string, site())] : await stopSharing(api, serverId, site())).map(shareView));
                if (revoked.length > 0) notify?.(AGENT_UNSHARED);
                return revoked;
            }
            case "confirmShare": {
                argument(args);
                // A link that could not be made is never asked about (a local project, signed out).
                shareable();
                if (!confirmShare) return "deny";
                const abort = new AbortController();
                openQuestions.add(abort);
                let timer: ReturnType<typeof setTimeout> | undefined;
                const unanswered = new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), shareConfirmMs ?? SHARE_CONFIRM_MS);
                });
                // Main stopped waiting (the agent's call ended): no, whatever the dialog says afterwards.
                const cancelled = new Promise<"deny">((resolve) => abort.signal.addEventListener("abort", () => resolve("deny"), { once: true }));
                try {
                    return await Promise.race([
                        cancelled, unanswered,
                        confirmShare({ projectName: shownName(controller.snapshot().project?.name), signal: abort.signal })
                            .then((answer) => (abort.signal.aborted ? "deny" : answer === "allow" || answer === "allow-session" ? answer : "deny"), () => "deny" as const),
                    ]);
                } finally {
                    clearTimeout(timer);
                    openQuestions.delete(abort);
                    // The question closes whatever ended it.
                    abort.abort();
                }
            }
            case "cancelConfirmShare":
                for (const abort of [...openQuestions]) abort.abort();
                return undefined;
            default:
                throw new Error(`Unknown session method: ${method}`);
        }
    };
}

/** Serves the editor to main's MCP host until the returned function runs. */
export async function startSessionResponder(options: SessionResponderOptions): Promise<() => Promise<void>> {
    return options.bridge.session.attach(options.projectId, createSessionResponder(options));
}
