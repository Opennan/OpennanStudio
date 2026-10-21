// OpenNan project pipelines for agents (phase 9b): the renderer's answers to main's cloud.quote / cloud.run /
// cloud.edit / cloud.script, behind @opennan/mcp's StudioCloud.pipelines. They run over the runtime's CloudApi (the
// IPC proxy: the key stays in main) with @opennan/director-client, like the AI tab's board and wizard: a priced step
// is quoted, submitted once with a fresh Idempotency-Key and followed to its end; its result arrives through sync and
// is recorded as one undo step ("AI: Storyboard of scene 2") on the editor's controller. Main is trusted but every
// payload is still checked here before anything is sent.
import type { OpenNanCloudBackend } from "@opennan/cloud-backend";
import {
    createProjectTasks, createQuotes, pipelineRequest, PROJECT_TOOL_IDS,
    type CheckedRequest, type DirectorQuotes, type ProjectTasks, type ProjectTasksOptions, type ProjectToolId, type ToolQuote,
} from "@opennan/director-client";
import type { SceneData, TimelineClip, TimelineController, TimelineTrack } from "@opennan/timeline-core";

export type PipelineBackend = Pick<OpenNanCloudBackend, "api" | "serverId" | "revision" | "waitForRevision" | "setAiActive" | "beginRemoteGroup" | "endRemoteGroup" | "recordRemoteGroup">;

export interface ResponderPipelinesOptions {
    /** Studio's id of the open project ("cloud-<id>" for a cloud project). */
    projectId: string;
    /** The signed-in account's cloud backend; throws the sign-in message while signed out. */
    backend(): PipelineBackend;
    controller: Pick<TimelineController, "recordExternalStep">;
    /** Test seams for the task follower (its sleep). */
    tasks?: ProjectTasksOptions;
    /** How long a finished step waits for the editor to hold its revision (default 30 s). */
    waitMs?: number;
}

/** The answer of cloud.run (@opennan/mcp's StudioPipelineResult). */
export interface PipelineRunAnswer {
    taskId: string;
    status: "succeeded" | "failed" | "cancelled";
    chargedUsd: number | null;
    projectRevision: number | null;
    synced: boolean;
    undoable: boolean;
    error: { message: string; code: string | null; refunded: boolean } | null;
}

export const NOT_A_CLOUD_PROJECT = "This needs an OpenNan cloud project: save it to OpenNan first.";
export const PRICE_UNAVAILABLE = "OpenNan can't price this right now, so it didn't run.";
/** A finished step waits this long for the editor to hold its revision. */
export const STEP_SYNC_WAIT_MS = 30_000;
/** A no-charge edit waits this long for the editor to pull it. */
export const EDIT_SYNC_WAIT_MS = 5_000;

const CLOUD_ID = /^cloud-[A-Za-z0-9_-]{1,36}$/;
const SCENE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 200;
const MAX_TEXT = 4_000;
const MAX_SCRIPT_TEXT = 20_000;
const MAX_SRT = 200_000;
const INVALID = "Invalid cloud request";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (): never => {
    throw new Error(INVALID);
};

interface Step {
    tool: ProjectToolId;
    sceneId?: string;
    index?: number;
    body: Record<string, unknown>;
    label: string;
}

function stepOf(value: unknown): Step {
    if (!isRecord(value)) return fail();
    const { tool, sceneId, index, body, label } = value;
    if (!(PROJECT_TOOL_IDS as readonly unknown[]).includes(tool)) return fail();
    if (!isRecord(body) || typeof label !== "string" || label.length === 0 || label.length > MAX_LABEL) return fail();
    const step: Step = { tool: tool as ProjectToolId, body, label };
    if (tool === "story-scenes") {
        if (sceneId !== undefined || index !== undefined) return fail();
        return step;
    }
    if (typeof sceneId !== "string" || !SCENE_ID.test(sceneId)) return fail();
    step.sceneId = sceneId;
    if (tool === "copy-video-edit") {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 999) return fail();
        step.index = index;
    } else if (index !== undefined) {
        return fail();
    }
    return step;
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function createResponderPipelines(options: ResponderPipelinesOptions) {
    const { projectId, controller } = options;
    const waitMs = options.waitMs ?? STEP_SYNC_WAIT_MS;
    let clients: { api: unknown; quotes: DirectorQuotes; tasks: ProjectTasks } | null = null;

    const backendOf = (): PipelineBackend => {
        if (!CLOUD_ID.test(projectId)) throw new Error(NOT_A_CLOUD_PROJECT);
        return options.backend();
    };
    // One quote cache and task follower per API client (a new sign-in builds a new backend).
    const clientsOf = (backend: PipelineBackend) => {
        if (!clients || clients.api !== backend.api) clients = { api: backend.api, quotes: createQuotes(backend.api), tasks: createProjectTasks(backend.api, options.tasks) };
        return clients;
    };
    const requestOf = (backend: PipelineBackend, step: Step): CheckedRequest => pipelineRequest(step.tool, backend.serverId(projectId), {
        ...(step.sceneId !== undefined ? { sceneId: step.sceneId } : {}), ...(step.index !== undefined ? { index: step.index } : {}), body: step.body,
    });
    const argument = (args: unknown): Record<string, unknown> => (isRecord(args) ? args : fail());

    /** Pulls (at the AI floor) until the editor's project holds `revision`; false after `limitMs`. */
    const reach = (backend: PipelineBackend, revision: number, limitMs: number) => backend.waitForRevision(projectId, revision, limitMs).catch(() => false);
    const snapshotOf = (doc: { tracks: TimelineTrack[]; clips: TimelineClip[]; scenes: SceneData[] }) => ({ tracks: doc.tracks, clips: doc.clips, scenes: doc.scenes });

    return {
        async quote(args: unknown): Promise<ToolQuote> {
            const step = stepOf(argument(args).step);
            const backend = backendOf();
            return clientsOf(backend).quotes.tool(requestOf(backend, step));
        },

        async run(args: unknown): Promise<PipelineRunAnswer> {
            const { step: rawStep, maxHoldUsd } = argument(args);
            const step = stepOf(rawStep);
            if (maxHoldUsd !== undefined && (typeof maxHoldUsd !== "number" || !Number.isFinite(maxHoldUsd) || maxHoldUsd < 0)) return fail();
            const backend = backendOf();
            const request = requestOf(backend, step);
            const { quotes, tasks } = clientsOf(backend);
            if (typeof maxHoldUsd === "number") {
                // The handler checked a quote already; a fresh one (never the cache) guards the submit itself.
                const quote = await quotes.tool(request, { fresh: true });
                if (quote.kind === "refused") throw new Error(`OpenNan won't run this: ${quote.message}`);
                if (quote.kind !== "quote") throw new Error(PRICE_UNAVAILABLE);
                if (Math.max(quote.priceUsd, quote.holdUsd) > maxHoldUsd + 1e-9) throw new Error(`OpenNan now quotes above accept_max_usd ($${maxHoldUsd}): nothing ran.`);
            }
            const group = await backend.beginRemoteGroup(projectId).catch(() => null);
            backend.setAiActive(projectId, 1);
            try {
                // The server prices the step again when it is sent: above the limit, it is taken back at once (refunded).
                let repriced = false;
                const handle = tasks.start(request, {
                    onUpdate: (state) => {
                        if (!repriced && typeof maxHoldUsd === "number" && state.priceUsd !== undefined && state.priceUsd > maxHoldUsd + 1e-9 && state.status !== "succeeded") {
                            repriced = true;
                            void Promise.resolve().then(() => handle.cancel());
                        }
                    },
                });
                const outcome = await handle.done;
                const succeeded = outcome.status === "succeeded";
                const revision = succeeded && outcome.projectRevision !== undefined ? outcome.projectRevision : null;
                let undoable = false;
                let synced = false;
                if (revision !== null) {
                    // The result reaches this device first, then the step is recorded in one go (as the AI tab does), so no
                    // edit of the person's slips between the backend's history entry and the controller's.
                    synced = await reach(backend, revision, waitMs);
                    if (synced && group !== null) {
                        undoable = await controller.recordExternalStep(async () => {
                            const recorded = await backend.recordRemoteGroup(projectId, group, {
                                label: `AI: ${step.label}`, toRevision: revision,
                                entities: step.tool === "story-scenes"
                                    ? { scenes: "all", clips: [], tracks: false, project: true }
                                    : { scenes: step.sceneId ? [step.sceneId] : "all", clips: [], tracks: false, project: false },
                            }, { timeoutMs: 0 });
                            return recorded ? { before: snapshotOf(recorded.before), after: snapshotOf(recorded.after) } : null;
                        }).catch(() => false);
                    }
                }
                const refunded = outcome.error?.refunded ?? false;
                return {
                    taskId: outcome.id, status: outcome.status,
                    chargedUsd: succeeded ? (outcome.priceUsd ?? null) : refunded ? 0 : null,
                    projectRevision: revision, synced, undoable,
                    error: repriced && !succeeded
                        ? { message: `OpenNan priced it above $${maxHoldUsd} when it was sent, so it was stopped and not charged.`, code: "price_changed", refunded: true }
                        : outcome.error ? { message: outcome.error.message, code: outcome.error.code ?? null, refunded } : null,
                };
            } finally {
                if (group !== null) await backend.endRemoteGroup(projectId, group).catch(() => undefined);
                backend.setAiActive(projectId, -1);
            }
        },

        async edit(args: unknown): Promise<{ synced: boolean }> {
            const edit = argument(args);
            if (typeof edit.sceneId !== "string" || !SCENE_ID.test(edit.sceneId)) return fail();
            let method: "PUT" | "PATCH";
            let suffix: string;
            let body: Record<string, unknown>;
            if (edit.kind === "copy-video-source") {
                if (typeof edit.videoUrl !== "string" || !/^https:\/\/\S+$/i.test(edit.videoUrl) || edit.videoUrl.length > 2_000) return fail();
                const trim = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
                if (!trim(edit.trimStart) || !trim(edit.trimEnd)) return fail();
                method = "PUT";
                suffix = "copy-video/source";
                body = { video_url: edit.videoUrl, ...(edit.trimStart !== undefined ? { trim_start: edit.trimStart } : {}), ...(edit.trimEnd !== undefined ? { trim_end: edit.trimEnd } : {}) };
            } else if (edit.kind === "shot-text") {
                if (typeof edit.index !== "number" || !Number.isInteger(edit.index) || edit.index < 0 || edit.index > 999 || !text(edit.action, MAX_TEXT)) return fail();
                method = "PATCH";
                suffix = `shots/${edit.index}`;
                body = { action: edit.action };
            } else {
                return fail();
            }
            const backend = backendOf();
            const before = await backend.revision(projectId).catch(() => null);
            const path = `/v1/projects/${encodeURIComponent(backend.serverId(projectId))}/scenes/${encodeURIComponent(edit.sceneId)}/${suffix}`;
            await backend.api.request(method, path, { body });
            return { synced: before !== null && await reach(backend, before + 1, Math.min(EDIT_SYNC_WAIT_MS, waitMs)) };
        },

        async script(args: unknown): Promise<null> {
            const texts = argument(args);
            const body: Record<string, unknown> = {};
            for (const [key, field, max] of [["scriptText", "script_text", MAX_SCRIPT_TEXT], ["srtContent", "srt_content", MAX_SRT]] as const) {
                const value = texts[key];
                if (value === undefined) continue;
                if (value !== null && (typeof value !== "string" || value.length > max)) return fail();
                body[field] = value;
            }
            if (Object.keys(body).length === 0) return fail();
            const backend = backendOf();
            await backend.api.request("PATCH", `/v1/projects/${encodeURIComponent(backend.serverId(projectId))}`, { body });
            return null;
        },
    };
}
