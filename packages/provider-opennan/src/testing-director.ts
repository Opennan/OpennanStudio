// The fake OpenNan server's AI director and project pipelines (phase 9b), Node only, wired into startFakeOpenNan
// (testing.ts): POST/GET /v1/projects/{id}/director/turns[/{turn_id}[/cancel]] with named SSE events and scripted
// steps (/__test/director/script), the director-turn and project tool quotes, the project pipeline task routes
// (story plan, storyboard, scene video, copy-video detect / image edit / recreate) that write into the fake cloud
// project and bump its revision, and the GET /v1/tools rows of both. Shapes, codes and texts follow opennan.com's
// public API (the director turn routes and events, quotes, the project pipelines, tasks); the prices are a small
// hand-made mirror (fakeProjectToolHold), not the server's.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type http from "node:http";
import { bodyKinds, FakeCloudError, makeValidator, type BodyModel, type CloudAnswer, type FakeCloudServer, type FakeProjectFacts } from "./testing-cloud";

const { str, range, int, BOOL, lit, list, obj, opt, req, def, valueError } = bodyKinds;

// ── constants ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fake director-turn quote's hold (the most a turn charges): the server's figure for its Sonnet route. */
export const FAKE_DIRECTOR_HOLD_USD = 0.429;
/** A typical turn (the quote's priced.typical_usd and the GET /v1/tools row). */
export const FAKE_DIRECTOR_TYPICAL_USD = 0.078;
/** What one text round of a fake turn charges (a turn settles min(rounds x this, the hold)). */
export const FAKE_DIRECTOR_ROUND_USD = 0.026;
/** The limits a turn object reports. */
export const FAKE_DIRECTOR_LIMITS = Object.freeze({ rounds: 6, prompt_tokens: 16_000, output_tokens: 1_500, tool_calls: 10, paid_calls: 3, max_tool_usd: 25, seconds: 240 });
/** The device name the director's edits carry (and the project's last_edited_device after one). */
export const FAKE_DIRECTOR_DEVICE = "OpenNan director";
export const FAKE_DIRECTOR_HEARTBEAT_MS = 15_000;

export type FakeProjectToolId = "story-scenes" | "storyboard" | "smart-scene-video" | "copy-video-detect" | "copy-video-edit" | "copy-video-recreate";
export const FAKE_PROJECT_TOOL_IDS: readonly FakeProjectToolId[] = Object.freeze(["story-scenes", "storyboard", "smart-scene-video", "copy-video-detect", "copy-video-edit", "copy-video-recreate"]);
/** The fake's project tool prices (fakeProjectToolHold): what a quote answers, a run holds and its success charges. */
export const FAKE_PROJECT_TOOL_PRICES = Object.freeze({
    "story-scenes": { usd: 0.2, per: "batch of 30 cues" },
    storyboard: { usd: 0.31, per: "scene" },
    "smart-scene-video": { usd: 0.1, per: "second", min_seconds: 5, quality_factors: { "480p": 0.6, "720p": 1, "1080p": 1.5 }, audio_usd: 0.05 },
    "copy-video-detect": { usd: 0.05, per: "run" },
    "copy-video-edit": { usd: 0.04, per: "image" },
    "copy-video-recreate": { usd: 0.12, per: "second", min_seconds: 5 },
});

/** The director's paid tools: name -> tool id, scene, shot index, REST path, label (the director's paid tools as its events name them). */
const PAID_TOOLS = {
    plan_scenes: ["story-scenes", false, false, "/v1/projects/{project}/story/plan", "Plan the scenes"],
    generate_storyboard: ["storyboard", true, false, "/v1/projects/{project}/scenes/{scene}/storyboard", "Draw a storyboard"],
    generate_scene_videos_smart: ["smart-scene-video", true, false, "/v1/projects/{project}/scenes/{scene}/videos", "Render the scene video"],
    detect_copy_video_shots: ["copy-video-detect", true, false, "/v1/projects/{project}/scenes/{scene}/copy-video/detections", "Find the copied video's shots"],
    edit_copy_video_shot_image: ["copy-video-edit", true, true, "/v1/projects/{project}/scenes/{scene}/shots/{index}/image-edits", "Redraw a shot's panel"],
    generate_video_from_panels: ["copy-video-recreate", true, false, "/v1/projects/{project}/scenes/{scene}/copy-video/recreate", "Recreate the copied scene"],
} as const satisfies Record<string, readonly [FakeProjectToolId, boolean, boolean, string, string]>;
export type FakeDirectorPaidTool = keyof typeof PAID_TOOLS;

/** Each project tool's fixed stage list (as its tasks report them), its summary and its GET /v1/tools row bits. */
const PROJECT_TOOLS: Record<FakeProjectToolId, { stages: string[]; summary: string; path: string; mcp: string; price: Record<string, unknown> }> = {
    "story-scenes": {
        stages: ["planning", "saving"], path: "/v1/projects/{project_id}/story/plan", mcp: "plan_scenes",
        summary: "Plan the scenes of a project from its lyrics or subtitles: what happens, where and with whom",
        price: { unit: "scene_batch", per: "30 scenes", usd: 0.2 },
    },
    storyboard: {
        stages: ["drawing", "cutting"], path: "/v1/projects/{project_id}/scenes/{scene_id}/storyboard", mcp: "generate_storyboard",
        summary: "A storyboard sheet for one scene, cut into one panel per shot", price: { unit: "scene", per: "scene", usd: 0.31 },
    },
    "smart-scene-video": {
        stages: ["planning", "rendering", "joining"], path: "/v1/projects/{project_id}/scenes/{scene_id}/videos", mcp: "generate_scene_videos_smart",
        summary: "Render a scene's shots as video, grouping shots that belong together",
        price: { unit: "video_second", per: "second", usd: 0.1, min_seconds: 5, quality_factors: { "480p": 0.6, "720p": 1, "1080p": 1.5 }, audio_usd: 0.05 },
    },
    "copy-video-detect": {
        stages: ["reading", "detecting", "checking"], path: "/v1/projects/{project_id}/scenes/{scene_id}/copy-video/detections", mcp: "detect_copy_video_shots",
        summary: "Find the shots, actions, camera moves and characters of a video (paid per started minute)", price: { unit: "run", per: "run", usd: 0.05 },
    },
    "copy-video-edit": {
        stages: ["editing"], path: "/v1/projects/{project_id}/scenes/{scene_id}/shots/{index}/image-edits", mcp: "edit_copy_video_shot_image",
        summary: "Redraw the image of one copied shot from an instruction", price: { unit: "image", per: "image", usd: 0.04 },
    },
    "copy-video-recreate": {
        stages: ["drawing", "rendering", "joining"], path: "/v1/projects/{project_id}/scenes/{scene_id}/copy-video/recreate", mcp: "generate_video_from_panels",
        summary: "Recreate a copied scene as a new video, shot by shot", price: { unit: "video_second", per: "second", usd: 0.12, min_seconds: 5 },
    },
};

const FINISH_STATUS: Record<string, FakeTurnStatus> = {
    stop: "completed", rounds: "limit", tool_calls: "limit", time: "limit", prompt: "limit", cancelled: "cancelled", refused: "refused", failed: "failed",
};
const FINISH_TEXT: Record<string, string> = {
    rounds: "I stopped after the most steps one message allows. Say \"continue\" to go on.",
    tool_calls: "I stopped after the most steps one message allows. Say \"continue\" to go on.",
    time: "I ran out of time for this message. Say \"continue\" to go on.",
    prompt: "This project is too big for me to read in one message. Select the scenes you mean and ask again.",
    cancelled: "Stopped.",
    failed: "Something went wrong on our side. You were charged only for what ran.",
};
const REFUSED_TEXT = "Sorry, I can't answer that one. Try asking another way.";
const ERRORS = {
    turn_in_progress: "The director is still working on this project: wait for it or stop it.",
    turn_already_finished: "This turn has already finished.",
    too_many_turns: "Too many director turns are running on this account: wait for one to finish.",
};
const UNAVAILABLE = "This tool is temporarily unavailable. You were not charged.";
const SCENE_NOT_FOUND = "No such scene in this project. You were not charged.";
const SHOT_NOT_FOUND = "No such shot in this scene. You were not charged.";
const SCENE_NOT_READY = "This scene isn't ready for this step yet. You were not charged.";
/** How long a director proposal can run, and its refusals (phase 9c: proposals run by id). */
export const FAKE_PROPOSAL_MINUTES = 15;
const PROPOSAL_EXPIRED = "This proposal has expired: ask the director again to see the price now.";
const NO_PROPOSAL = "No such proposal on this director turn.";
const PRICE_CHANGED = "This step costs more now than when it was proposed: nothing ran and nothing was held. Ask the director again to see the new price.";
const STORYBOARD_READY = "This scene already has a storyboard: send regenerate true to draw a new one. You were not charged.";
const LOW_BALANCE = "Your balance is too low for this request.";

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const round6 = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;
/** The server's _iso: seconds, then Z. */
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
/** The server's money.usd_up: cents, read at the millionth, rounded up (card summaries never show under the hold). */
const money = (usd: number) => (Math.ceil(Math.round(usd * 1_000_000) / 10_000) / 100).toFixed(2);
const err = (status: number, type: string, message: string, code: string, details?: Record<string, unknown>, headers?: Record<string, string>) =>
    new FakeCloudError(status, type, message, code, details, headers);
const invalid = (message: string) => err(400, "invalid_request_error", message, "invalid_request");

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}
const hashOf = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** A card's shown arguments: plain values, long text cut short, scenes / clips as counts. */
function shownArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args).slice(0, 12)) {
        if ((key === "scenes" || key === "clips") && value && typeof value === "object" && !Array.isArray(value)) {
            out[key] = Object.fromEntries(Object.entries(value).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length]));
        } else if (typeof value === "string") {
            out[key] = value.length <= 300 ? value : `${value.slice(0, 300)}...`;
        } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
            out[key] = value;
        }
    }
    return out;
}

// ── bodies (strict, like the server's pydantic models) ───────────────────────────────────────────────────────────

const VIDEO_MODELS = ["auto", "seedance-2", "kling-o3", "kling-3"] as const;
const PROJECT_VIDEO_MODELS: Record<string, { qualities: string[]; tools: string[] }> = {
    "seedance-2": { qualities: ["480p", "720p", "1080p"], tools: ["storyboard", "copy-video-recreate", "smart-scene-video"] },
    "kling-o3": { qualities: ["720p", "1080p"], tools: ["storyboard", "smart-scene-video"] },
    "kling-3": { qualities: ["720p", "1080p"], tools: ["smart-scene-video"] },
};

/** project_pipelines_router._offered: the model and quality a project tool renders with. */
function offered(tool: string, model: unknown, quality: unknown): void {
    const models = ["auto", ...Object.entries(PROJECT_VIDEO_MODELS).filter(([, info]) => info.tools.includes(tool)).map(([id]) => id)];
    if (typeof model === "string" && !models.includes(model)) valueError([], `model must be one of ${models.join(", ")}`);
    const publicModel = model == null || model === "auto" ? "seedance-2" : (model as string);
    let qualities = PROJECT_VIDEO_MODELS[publicModel]!.qualities;
    if (tool === "copy-video-recreate") qualities = qualities.filter((q) => q === "480p" || q === "720p");
    if (typeof quality === "string" && !qualities.includes(quality)) valueError([], `${(model as string | null) ?? "auto"} takes the qualities ${qualities.join(", ")}`);
}

const httpsUrl = (value: Record<string, unknown>, loc: Array<string | number>) => {
    if (typeof value.callback_url === "string" && !value.callback_url.startsWith("https://")) valueError([...loc, "callback_url"], "must be an https URL");
};
const CALLBACK = { callback_url: opt(str(2_048)) };
const RENDER = { model: opt(lit(...VIDEO_MODELS)), quality: opt(lit("480p", "720p", "1080p")), generate_audio: opt(BOOL), ...CALLBACK };
const BODIES: Record<FakeProjectToolId, BodyModel> = {
    "story-scenes": { fields: { style: opt(str(200)), concept: opt(str(2_000)), direction: opt(str(2_000)), ...CALLBACK }, after: httpsUrl },
    storyboard: {
        fields: { model: opt(lit(...VIDEO_MODELS)), regenerate: def(BOOL), ...CALLBACK },
        after(value, loc) {
            httpsUrl(value, loc);
            offered("storyboard", value.model, null);
        },
    },
    "smart-scene-video": {
        fields: RENDER,
        after(value, loc) {
            httpsUrl(value, loc);
            offered("smart-scene-video", value.model, value.quality);
        },
    },
    "copy-video-detect": { fields: { ...CALLBACK }, after: httpsUrl },
    "copy-video-edit": { fields: { instruction: req(str(2_000, undefined, 1)), ...CALLBACK }, after: httpsUrl },
    "copy-video-recreate": {
        fields: RENDER,
        after(value, loc) {
            httpsUrl(value, loc);
            offered("copy-video-recreate", value.model, value.quality);
        },
    },
};

/** A pipeline request's inputs: the validated body without callback_url and without nulls (defaults kept). */
function inputsFor(tool: FakeProjectToolId, parsed: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(BODIES[tool].fields)) {
        if (name === "callback_url") continue;
        const value = parsed[name] ?? (tool === "storyboard" && name === "regenerate" ? false : undefined);
        if (value !== undefined && value !== null) out[name] = value;
    }
    return out;
}

const SELECTION: BodyModel = { fields: { scene_ids: def(list(str(), 50)), clip_ids: def(list(str(), 200)), time_seconds: opt(range(0, 86_400)) } };
const TURN_BODY: BodyModel = {
    fields: {
        message: req(str(4_000, undefined, 1)), max_tool_usd: def(range(0, 25)), stream: def(BOOL), selection: opt(obj(SELECTION)), client_revision: opt(int(0)),
    },
};

// ── the pricing mirror ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The hold of a paid project tool run on this project now (what a quote answers, the run holds and its success
 * charges): story-scenes $0.20 per started batch of 30 cues; storyboard $0.31 a scene; smart-scene-video $0.10 a
 * second of the scene (at least 5) x the quality's factor (480p 0.6, 720p 1, 1080p 1.5; the project's quality when
 * none is sent) + $0.05 with generate_audio; copy-video-detect $0.05; copy-video-edit $0.04; copy-video-recreate
 * $0.12 a second (at least 5). Throws the server's refusals: 404 for a scene or shot the project lacks, 409 for a
 * plan without subtitles or a storyboard over one without regenerate.
 */
export function fakeProjectToolHold(tool: FakeProjectToolId, project: FakeProjectFacts, inputs: Record<string, unknown>): number {
    const prices = FAKE_PROJECT_TOOL_PRICES;
    if (tool === "story-scenes") {
        const cues = project.cues?.length ?? 0;
        if (cues === 0) throw err(409, "conflict", SCENE_NOT_READY, "conflict");
        return round6(prices["story-scenes"].usd * Math.ceil(cues / 30));
    }
    const scene = project.scenes.find((s) => s.id === inputs.scene_id);
    if (!scene) throw err(404, "not_found", SCENE_NOT_FOUND, "not_found");
    const seconds = (min: number) => Math.max(min, scene.duration);
    switch (tool) {
        case "storyboard":
            if (inputs.regenerate !== true && scene.shots.some((s) => s.image_url)) throw err(409, "conflict", STORYBOARD_READY, "conflict");
            return prices.storyboard.usd;
        case "smart-scene-video": {
            const p = prices["smart-scene-video"];
            const asked = (inputs.quality as string | undefined) ?? project.default_video_quality;
            const factor = (p.quality_factors as Record<string, number>)[asked] ?? (asked === "4K" ? 1.5 : 1);
            return round6(p.usd * seconds(p.min_seconds) * factor + (inputs.generate_audio === true ? p.audio_usd : 0));
        }
        case "copy-video-detect":
            return prices["copy-video-detect"].usd;
        case "copy-video-edit": {
            const index = inputs.index as number;
            if (!Number.isInteger(index) || index < 0 || index >= scene.shots.length) throw err(404, "not_found", SHOT_NOT_FOUND, "not_found");
            return prices["copy-video-edit"].usd;
        }
        case "copy-video-recreate":
            return round6(prices["copy-video-recreate"].usd * seconds(prices["copy-video-recreate"].min_seconds));
    }
}

/** POST /v1/quotes {tool: "director-turn"}: one turn's hold. */
export function fakeDirectorTurnQuote(): Record<string, unknown> {
    return {
        object: "quote", model: null, tool: "director-turn", currency: "usd", price_usd: FAKE_DIRECTOR_HOLD_USD, hold_usd: FAKE_DIRECTOR_HOLD_USD,
        priced: { ...FAKE_DIRECTOR_LIMITS, typical_usd: FAKE_DIRECTOR_TYPICAL_USD },
    };
}

// ── public types ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One step of a scripted turn (POST /__test/director/script, FakeDirector.script). */
export type FakeDirectorStep =
    /** One round: turn.thinking, then message (appended to the reply). */
    | { text: string }
    /** A free tool call: tool.started then tool.finished (ok true and summary "Done" unless given). */
    | { tool: { name: string; label: string; args?: Record<string, unknown>; ok?: boolean; summary?: string } }
    /** edit_project_timeline: the changeset applied to the cloud project as "OpenNan director", then project.revision. */
    | { edit: { label: string; changes: Record<string, unknown> } }
    /** A paid tool: run as a task inside max_tool_usd (at most 3 a turn), else a proposal with its quote and request. */
    | { proposal: { tool: FakeDirectorPaidTool; scene_id?: string; index?: number; args?: Record<string, unknown> } }
    /** Waits (a cancel is seen within 50 ms). */
    | { delay: number }
    /** Ends the turn failed with this error code. */
    | { fail: string }
    /** Ends the turn refused. */
    | { refuse: true };

export type FakeTurnStatus = "running" | "completed" | "limit" | "cancelled" | "refused" | "failed";

export interface FakeDirectorTurnState extends Record<string, unknown> {
    id: string;
    project_id: string;
    status: FakeTurnStatus;
    reply: string;
    charged_usd: number;
    /** Every event the turn emitted, in order (a stream sends these). */
    events: Array<{ event: string; data: Record<string, unknown> }>;
}

export interface FakeDirectorState {
    /** Every turn (the turn object plus its events), oldest first. */
    turns: FakeDirectorTurnState[];
    /** Ids of the turns still running. */
    running: string[];
    /** Scripts queued for the next turns (a repeat script counts once). */
    scripts: number;
    unavailable: boolean;
    heartbeatMs: number;
    holdTasks: boolean;
    /** The project pipeline tasks. */
    tasks: Array<{ id: string; tool: FakeProjectToolId; project_id: string; status: string; hold_usd: number; project_revision: number | null }>;
}

/** The fake's director and project pipelines, in process (FakeOpenNan.director): every /__test/director knob typed. */
export interface FakeDirector {
    /** Queues a script for the next turn (default when none is queued: one text step "Done."); repeat keeps it for every turn. */
    script(steps: FakeDirectorStep[], options?: { repeat?: boolean }): void;
    /** On: turns and the director-turn quote answer 503 director_unavailable, its tool row is unavailable. */
    setUnavailable(on: boolean): void;
    /** The SSE heartbeat (": ping") after this many idle milliseconds (default 15,000). */
    setHeartbeat(ms: number): void;
    /** The next `count` turn POSTs answer 429 rate_limit_exceeded. */
    rateLimit(count: number): void;
    /** Starts a turn on the project as another device; it runs until cancelled or released. Answers its id. */
    hold(projectId: string): string;
    /** Ends every held turn (completed). */
    release(): void;
    /** On: project tasks stay running until finishTask (then succeed on the next GET). */
    holdTasks(on: boolean): void;
    /** Lets a held project task finish; false when there is no such task. */
    finishTask(taskId: string): boolean;
    state(): FakeDirectorState;
}

export interface DirectorDeps {
    base(): string;
    cloud: FakeCloudServer;
    balance(): number;
    /** Takes money from the balance (a settled turn, a succeeded project task). */
    charge(usd: number): void;
    nextTaskId(): string;
    taskSteps(): number;
    /** The fail-next knob for a tool id (consumed). */
    takeFail(tool: string): string | undefined;
    /** The paid-started knob for a tool id. */
    paidStarted(tool: string): boolean;
    /** The cancel-busy knob (consumes one). */
    takeCancelBusy(): boolean;
    publicErrors: Readonly<Record<string, string>>;
    texts: { cancelled: string; cancelConflict: string; cancelBusy: string };
}

export interface DirectorRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: http.IncomingHttpHeaders;
    /** The parsed JSON body; undefined when none came. */
    body: unknown;
    /** The key's scopes (the caller checked the key). */
    scopes: readonly string[];
    req: http.IncomingMessage;
    res: http.ServerResponse;
    cors: Record<string, string>;
}

export interface FakeDirectorServer {
    readonly director: FakeDirector;
    /** The director turn and project pipeline routes; null when the path is not one; "streamed" when it answered itself. */
    api(request: DirectorRequest): CloudAnswer | Promise<CloudAnswer> | "streamed" | null;
    /** GET /v1/tasks/{id} and its cancel for a project task; null for another task. */
    task(id: string, cancel: boolean): CloudAnswer | null;
    /** POST /v1/quotes for director-turn and the project tools; null for any other target. */
    quote(body: Record<string, unknown>, scopes: readonly string[] | null): CloudAnswer | null;
    /** GET /v1/tools rows of the director and the project tools. */
    toolRows(): Array<Record<string, unknown>>;
    /** /__test/director/* and /__test/tasks/finish; null for another path. */
    knob(path: string, query: URLSearchParams, body: unknown): CloudAnswer | null;
    reset(): void;
}

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface TaskEntry { id: string; tool: FakeProjectToolId; status: string; hold_usd: number }

interface Turn {
    id: string;
    projectId: string;
    message: string;
    maxToolUsd: number;
    hash: string;
    key: string | null;
    status: FakeTurnStatus;
    reply: string[];
    cards: Array<Record<string, unknown>>;
    proposals: Array<Record<string, unknown>>;
    changes: Array<Record<string, unknown>>;
    tasks: TaskEntry[];
    revisionStart: number;
    revisionEnd: number | null;
    revision: number;
    charged: number;
    finish: string | null;
    cancelRequested: boolean;
    error: { code: string; message: string } | null;
    createdAt: number;
    finishedAt: number | null;
    seq: number;
    rounds: number;
    toolCalls: number;
    paidCalls: number;
    paidHolds: number;
    callsMade: number;
    events: Array<{ event: string; data: Record<string, unknown> }>;
    listeners: Set<(event: string, data: Record<string, unknown>) => void>;
    done: Promise<void>;
    resolve: () => void;
    held: boolean;
    released: boolean;
    generation: number;
}

interface ProjectTask {
    id: string;
    tool: FakeProjectToolId;
    projectId: string;
    inputs: Record<string, unknown>;
    hold: number;
    step: number;
    queuedSteps: number;
    cancelled: boolean;
    fail?: string;
    paidStarted: boolean;
    held: boolean;
    released: boolean;
    settled: boolean;
    projectRevision: number | null;
    result: unknown;
    key: string | null;
    hash: string;
    createdAt: number;
    finishedAt: number | null;
}

export function createFakeDirector(deps: DirectorDeps): FakeDirectorServer {
    const validator = makeValidator(deps.base);
    let turns: Turn[] = [];
    let scripts: Array<{ steps: FakeDirectorStep[]; repeat: boolean }> = [];
    let unavailable = false;
    let heartbeatMs = FAKE_DIRECTOR_HEARTBEAT_MS;
    let rateLimited = 0;
    let holdTasks = false;
    let tasks = new Map<string, ProjectTask>();
    let seq = 0;
    let generation = 0;
    /** Proposals as the server stores them: the step, its price, its expiry, the task once run. */
    let proposals = new Map<string, { id: string; turnId: string; projectId: string; tool: FakeProjectToolId; inputs: Record<string, unknown>; price: number; expiresAt: number; taskId: string | null }>();
    /** The proposal-price knob: what a run's re-price adds (a price that rose since the proposal). */
    let proposalBump = 0;
    /** The server's run keys: a run's Idempotency-Key names one run request (project, turn, proposal, body) for good. */
    let runKeys = new Map<string, string>();

    // A scene is busy while a project task of it runs (ps.scene_busy: its status says a tool writes it).
    deps.cloud.setSceneBusyProbe((projectId, sceneId) => [...tasks.values()].some((task) => task.projectId === projectId && task.inputs.scene_id === sceneId
        && !task.settled && !task.cancelled && (statusOf(task) === "queued" || statusOf(task) === "running")));

    const running = () => turns.filter((t) => t.status === "running");
    const facts = (projectId: string) => deps.cloud.facts(projectId);

    // ── turns ──

    function view(t: Turn): Record<string, unknown> {
        return {
            object: "director_turn", id: t.id, project_id: t.projectId, status: t.status, message: t.message,
            reply: t.reply.filter(Boolean).join("\n\n").trim(), cards: t.cards,
            // _proposals_shown: each proposal with the task its run made (null until run).
            proposals: t.proposals.map((p) => (typeof p.id === "string" ? { ...p, task_id: proposals.get(p.id)?.taskId ?? null } : p)), changes: t.changes, tasks: t.tasks,
            revision_start: t.revisionStart, revision_end: t.revisionEnd, hold_usd: FAKE_DIRECTOR_HOLD_USD, charged_usd: round6(t.charged),
            limits: { ...FAKE_DIRECTOR_LIMITS }, finish: t.finish, cancel_requested: t.cancelRequested,
            error: t.error ? { ...t.error } : null, created_at: iso(t.createdAt), finished_at: t.finishedAt === null ? null : iso(t.finishedAt),
        };
    }

    const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    function emit(t: Turn, event: string, data: Record<string, unknown>): void {
        const frozen = json(data);
        t.events.push({ event, data: frozen });
        for (const listener of [...t.listeners]) listener(event, frozen);
    }

    function newTurn(projectId: string, message: string, maxToolUsd: number, hash: string, key: string | null, revision: number, held: boolean): Turn {
        let resolve!: () => void;
        const done = new Promise<void>((r) => {
            resolve = r;
        });
        const t: Turn = {
            id: `turn_${randomBytes(12).toString("hex")}`, projectId, message, maxToolUsd, hash, key, status: "running", reply: [], cards: [], proposals: [],
            changes: [], tasks: [], revisionStart: revision, revisionEnd: null, revision, charged: 0, finish: null, cancelRequested: false, error: null,
            createdAt: Date.now(), finishedAt: null, seq: ++seq, rounds: 0, toolCalls: 0, paidCalls: 0, paidHolds: 0, callsMade: 0, events: [],
            listeners: new Set(), done, resolve, held, released: false, generation,
        };
        turns.push(t);
        return t;
    }

    /** Waits up to `ms` (Infinity for a held turn), seeing a cancel or a release within 50 ms. */
    async function wait(t: Turn, ms: number): Promise<void> {
        const until = Date.now() + ms;
        while (!t.cancelRequested && !t.released && t.generation === generation) {
            const left = until - Date.now();
            if (left <= 0) return;
            await new Promise((r) => setTimeout(r, Math.min(50, left)));
        }
    }

    function openRound(t: Turn): void {
        t.rounds += 1;
        emit(t, "turn.thinking", { round: t.rounds });
    }

    async function drive(t: Turn, steps: FakeDirectorStep[]): Promise<void> {
        emit(t, "turn.started", { turn_id: t.id, hold_usd: FAKE_DIRECTOR_HOLD_USD, limits: { ...FAKE_DIRECTOR_LIMITS }, revision_start: t.revisionStart });
        try {
            if (t.held) {
                await wait(t, Number.POSITIVE_INFINITY);
                t.finish = t.cancelRequested ? "cancelled" : "stop";
            }
            for (const step of t.held ? [] : steps) {
                if (t.cancelRequested) {
                    t.finish = "cancelled";
                    break;
                }
                if (Date.now() - t.createdAt > FAKE_DIRECTOR_LIMITS.seconds * 1000) {
                    t.finish = "time";
                    break;
                }
                if ("text" in step) {
                    if (t.rounds >= FAKE_DIRECTOR_LIMITS.rounds) {
                        t.finish = "rounds";
                        break;
                    }
                    openRound(t);
                    const text = String(step.text ?? "").trim();
                    if (text) {
                        emit(t, "message", { round: t.rounds, text });
                        t.reply.push(text);
                    }
                } else if ("delay" in step) {
                    await wait(t, Math.max(0, Number(step.delay) || 0));
                    if (t.cancelRequested) {
                        t.finish = "cancelled";
                        break;
                    }
                } else if ("fail" in step) {
                    t.finish = "failed";
                    t.error = { code: String(step.fail || "server_error"), message: FINISH_TEXT.failed! };
                    break;
                } else if ("refuse" in step) {
                    t.finish = "refused";
                    t.reply = [REFUSED_TEXT];
                    break;
                } else {
                    // A tool call always comes from a round: the first one opens round 1.
                    if (t.rounds === 0) openRound(t);
                    // Over the per-turn cap the server answers the model "Not run" with no event.
                    if (t.toolCalls >= FAKE_DIRECTOR_LIMITS.tool_calls) continue;
                    t.toolCalls += 1;
                    t.callsMade += 1;
                    toolStep(t, `c${t.callsMade}`, step);
                }
            }
            if (t.finish === null) t.finish = "stop";
        } catch {
            t.finish = "failed";
            t.error = { code: "server_error", message: FINISH_TEXT.failed! };
        }
        end(t);
    }

    function toolStep(t: Turn, callId: string, step: Exclude<FakeDirectorStep, { text: string } | { delay: number } | { fail: string } | { refuse: true }>): void {
        let card: Record<string, unknown>;
        let finished: Record<string, unknown>;
        if ("tool" in step) {
            const { name, label, args, ok, summary } = step.tool;
            card = { call_id: callId, tool: name, label, args: shownArgs(args ?? {}) };
            emit(t, "tool.started", card);
            finished = { call_id: callId, tool: name, ok: ok ?? true, summary: summary ?? "Done" };
        } else if ("edit" in step) {
            const label = String(step.edit.label ?? "Edit").slice(0, 120);
            const changes = (step.edit.changes ?? {}) as Record<string, Record<string, unknown[]> | undefined>;
            card = { call_id: callId, tool: "edit_project_timeline", label: `Edit: ${label.slice(0, 80)}`, args: shownArgs({ label, ...changes }) };
            emit(t, "tool.started", card);
            finished = { call_id: callId, tool: "edit_project_timeline", ...edit(t, label, changes) };
        } else {
            const name = step.proposal.tool;
            const spec = PAID_TOOLS[name];
            const args: Record<string, unknown> = {
                ...(step.proposal.scene_id !== undefined ? { scene_id: step.proposal.scene_id } : {}),
                ...(step.proposal.index !== undefined ? { index: step.proposal.index } : {}), ...(step.proposal.args ?? {}),
            };
            card = { call_id: callId, tool: name, label: spec ? spec[4] : name, args: shownArgs(args) };
            emit(t, "tool.started", card);
            finished = { call_id: callId, tool: name, ...paid(t, callId, name, args, card) };
        }
        emit(t, "tool.finished", finished);
        const { call_id: _call, tool: _tool, ...rest } = finished;
        t.cards.push({ ...card, ...rest });
    }

    function failure(error: unknown): Record<string, unknown> {
        if (error instanceof FakeCloudError) return { ok: false, summary: error.message, error: { code: error.code, message: error.message } };
        return { ok: false, summary: "This step could not run", error: { code: "invalid_request", message: "This step could not run." } };
    }

    /** _t_edit_project_timeline: the changeset through the cloud's own path, the revision event, the summary. */
    function edit(t: Turn, label: string, changes: Record<string, Record<string, unknown[]> | undefined>): Record<string, unknown> {
        const groups = { scenes: { ...(changes.scenes ?? {}) }, clips: { ...(changes.clips ?? {}) } };
        for (const group of Object.values(groups)) {
            if (Array.isArray(group.create)) group.create = group.create.map((row) => (row && typeof row === "object" && !(row as { id?: unknown }).id ? { ...row, id: randomUUID() } : row));
        }
        const items = Object.values(groups).reduce((n, g) => n + ["create", "patch", "delete"].reduce((m, k) => m + (Array.isArray(g[k]) ? g[k]!.length : 0), 0), 0)
            + (changes.tracks ? 1 : 0) + (changes.project ? 1 : 0);
        if (items === 0) return { ok: false, summary: "Nothing to change" };
        if (items > 50) return { ok: false, summary: "Too many changes at once" };
        let answer: Record<string, unknown>;
        try {
            answer = deps.cloud.change(t.projectId, { ...changes, ...groups, label: `AI: ${label}` }, FAKE_DIRECTOR_DEVICE);
        } catch (error) {
            const refused = failure(error);
            if (error instanceof FakeCloudError && error.status === 400 && error.code === "invalid_request") refused.summary = "The change was refused";
            return refused;
        }
        const deleted = answer.deleted as { scenes: string[]; clips: string[] };
        const sceneIds = [...new Set([...(answer.scenes as Array<{ id: string }>).map((s) => s.id), ...deleted.scenes])].sort();
        const clipIds = [...new Set([...(answer.clips as Array<{ id: string }>).map((c) => c.id), ...deleted.clips])].sort();
        const revision = answer.revision as number;
        const change = { revision, label: `AI: ${label}`, scenes: sceneIds, clips: clipIds, tracks: answer.tracks !== null, project: answer.project !== null };
        t.changes.push(change);
        t.revision = Math.max(t.revision, revision);
        emit(t, "project.revision", { revision, change });
        return { ok: true, summary: `${sceneIds.length} scenes and ${clipIds.length} clips changed`, revision };
    }

    /** _paid / _propose: quote, then submit inside the budget (at most 3 a turn) or propose. */
    function paid(t: Turn, callId: string, name: FakeDirectorPaidTool, raw: Record<string, unknown>, card: Record<string, unknown>): Record<string, unknown> {
        const spec = PAID_TOOLS[name];
        if (!spec) return { ok: false, summary: "This step could not run", error: { code: "invalid_request", message: "This step could not run." } };
        const [toolId, needsScene, needsIndex, template, label] = spec;
        const args = { ...raw };
        const ids: Record<string, unknown> = {};
        if (needsScene) {
            const sceneId = args.scene_id;
            delete args.scene_id;
            if (typeof sceneId !== "string" || !sceneId) return { ok: false, summary: "No scene" };
            ids.scene_id = sceneId;
        }
        if (needsIndex) {
            const index = args.index;
            delete args.index;
            if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 999) return { ok: false, summary: "No shot" };
            ids.index = index;
        }
        let parsed: Record<string, unknown>;
        try {
            parsed = validator.body(BODIES[toolId], args);
        } catch {
            return { ok: false, summary: "The request was refused" };
        }
        const body = inputsFor(toolId, parsed);
        const inputs = { ...ids, ...body };
        let hold: number;
        try {
            hold = fakeProjectToolHold(toolId, facts(t.projectId), inputs);
        } catch (error) {
            return failure(error);
        }
        const quote = { price_usd: hold, hold_usd: hold };
        const budget = round6(t.maxToolUsd - t.paidHolds);
        if (t.paidCalls < FAKE_DIRECTOR_LIMITS.paid_calls && hold <= budget + 1e-9) {
            let task: ProjectTask;
            try {
                task = submit(toolId, t.projectId, inputs, `${t.id}:${callId}`.slice(0, 64));
            } catch (error) {
                return failure(error);
            }
            t.paidCalls += 1;
            t.paidHolds = round6(t.paidHolds + task.hold);
            const entry: TaskEntry = { id: task.id, tool: toolId, status: statusOf(task), hold_usd: task.hold };
            t.tasks.push(entry);
            return { ok: true, summary: `Started (holds $${money(task.hold)})`, task: { ...entry }, quote };
        }
        const path = template.replace("{project}", t.projectId).replace("{scene}", String(ids.scene_id)).replace("{index}", String(ids.index));
        const proposalId = `prop_${randomBytes(12).toString("hex")}`;
        const expiresAt = Date.now() + FAKE_PROPOSAL_MINUTES * 60_000;
        proposals.set(proposalId, { id: proposalId, turnId: t.id, projectId: t.projectId, tool: toolId, inputs, price: hold, expiresAt, taskId: null });
        const proposal = {
            id: proposalId, call_id: callId, tool: name, label, args: card.args, quote, expires_at: iso(expiresAt), request: { method: "POST", path, body },
            run: { method: "POST", body: {}, path: `/v1/projects/${t.projectId}/director/turns/${t.id}/proposals/${proposalId}/run` },
        };
        emit(t, "proposal", proposal);
        t.proposals.push(json(proposal));
        return { ok: true, summary: `Proposed (≈ $${money(hold)})`, proposal: true, quote };
    }

    function end(t: Turn): void {
        // A turn of a state that reset() discarded only closes its streams: no charge, no task cancels.
        const stale = t.generation !== generation;
        if (stale) t.finish = "cancelled";
        if (t.finish === "cancelled" && !stale) {
            for (const entry of t.tasks) {
                const task = tasks.get(entry.id);
                if (!task) continue;
                const status = statusOf(task);
                if (status === "queued" || (status === "running" && !task.paidStarted && !deps.paidStarted(task.tool))) {
                    task.cancelled = true;
                    task.finishedAt = Date.now();
                    entry.status = "cancelled";
                } else {
                    entry.status = status === "succeeded" || status === "failed" || status === "cancelled" ? status : "running";
                }
            }
        }
        t.charged = t.rounds === 0 ? 0 : round6(Math.min(t.rounds * FAKE_DIRECTOR_ROUND_USD, FAKE_DIRECTOR_HOLD_USD));
        if (t.charged > 0 && !stale) deps.charge(t.charged);
        const finish = t.finish ?? "stop";
        if (t.reply.filter(Boolean).length === 0 && FINISH_TEXT[finish]) t.reply = [FINISH_TEXT[finish]!];
        try {
            t.revisionEnd = facts(t.projectId).revision;
        } catch {
            t.revisionEnd = t.revision;
        }
        t.status = FINISH_STATUS[finish] ?? "failed";
        t.finishedAt = Date.now();
        emit(t, "turn.finished", view(t));
        t.listeners.clear();
        t.resolve();
    }

    function scriptFor(): FakeDirectorStep[] {
        const next = scripts[0];
        if (!next) return [{ text: "Done." }];
        if (!next.repeat) scripts.shift();
        return next.steps.map((s) => json(s));
    }

    function checkTurnScopes(scopes: readonly string[]): void {
        if (!scopes.includes("api:project")) throw err(403, "permission_error", "This API key is not allowed to use cloud projects (scope api:project).", "permission_denied");
        for (const [category, what] of [["opennan", "the video tools"], ["text", "text models"]] as const) {
            if (!scopes.includes(`api:${category}`)) throw err(403, "permission_error", `This API key is not allowed to use ${what} (scope api:${category}).`, "permission_denied");
        }
    }

    function ownedTurn(projectId: string, turnId: string): Turn {
        const t = turns.find((x) => x.id === turnId);
        if (!t || t.projectId !== projectId) throw err(404, "not_found", "No such director turn on this project.", "not_found");
        return t;
    }

    const inProgress = (turnId: string) => err(409, "conflict", ERRORS.turn_in_progress, "turn_in_progress", { turn_id: turnId });

    /** The SSE answer: every event as `event: <name>\ndata: <json>\n\n`, `: ping` while idle, an error event before a failed turn's end. */
    function stream(request: DirectorRequest, t: Turn | null, replay?: Record<string, unknown>): "streamed" {
        const { req, res } = request;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...request.cors });
        res.flushHeaders?.();
        const write = (text: string) => {
            if (!res.writableEnded && !res.destroyed) res.write(text);
        };
        const frame = (event: string, data: Record<string, unknown>) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (replay) {
            frame("turn.finished", replay);
            res.end();
            return "streamed";
        }
        const turn = t!;
        let over = false;
        let beat: ReturnType<typeof setTimeout> | null = null;
        const arm = () => {
            if (beat) clearTimeout(beat);
            beat = over ? null : setTimeout(() => {
                write(": ping\n\n");
                arm();
            }, heartbeatMs);
        };
        const listener = (event: string, data: Record<string, unknown>) => {
            if (event === "turn.finished" && data.error) frame("error", data.error as Record<string, unknown>);
            frame(event, data);
            if (event === "turn.finished") {
                over = true;
                if (beat) clearTimeout(beat);
                res.end();
            } else {
                arm();
            }
        };
        turn.listeners.add(listener);
        const dropped = () => {
            if (over) return;
            over = true;
            if (beat) clearTimeout(beat);
            turn.listeners.delete(listener);
            if (turn.status === "running") turn.cancelRequested = true; // the client went away: stop, settle what ran
        };
        res.on("close", dropped);
        req.on("aborted", dropped);
        arm();
        return "streamed";
    }

    function createTurn(request: DirectorRequest, projectId: string): CloudAnswer | Promise<CloudAnswer> | "streamed" {
        if (request.body === undefined) throw invalid("body: Field required");
        const body = validator.body(TURN_BODY, request.body);
        checkTurnScopes(request.scopes);
        const header = request.headers["idempotency-key"];
        const key = typeof header === "string" ? header : null;
        if (key !== null && (key.length < 1 || key.length > 64)) throw invalid("Idempotency-Key must be 1-64 characters.");
        if (rateLimited > 0) {
            rateLimited -= 1;
            throw err(429, "rate_limit_error", "Too many director turns: at most 10 a minute and 200 an hour. Try again in 30 seconds.", "rate_limit_exceeded", undefined, { "retry-after": "30" });
        }
        const selection = body.selection as Record<string, unknown> | null | undefined;
        const hash = hashOf({
            message: body.message, max_tool_usd: Number(body.max_tool_usd ?? 0), client_revision: body.client_revision ?? null,
            selection: selection ? { scene_ids: selection.scene_ids ?? [], clip_ids: selection.clip_ids ?? [], time_seconds: selection.time_seconds ?? null } : null,
        });
        const wantsStream = body.stream !== false;
        if (key !== null) {
            const earlier = turns.find((x) => x.key === key);
            if (earlier) {
                if (earlier.hash !== hash || earlier.projectId !== projectId) throw err(409, "idempotency_error", "Idempotency-Key was already used for a different request.", "idempotency_key_reused");
                if (earlier.status === "running") throw inProgress(earlier.id);
                return wantsStream ? stream(request, null, view(earlier)) : { status: 200, json: view(earlier) };
            }
        }
        const revision = facts(projectId).revision;
        if (unavailable) throw err(503, "unavailable", UNAVAILABLE, "director_unavailable");
        const live = running();
        const here = live.find((x) => x.projectId === projectId);
        if (here) throw inProgress(here.id);
        if (live.length >= 2) throw err(429, "rate_limit_error", ERRORS.too_many_turns, "rate_limit_exceeded", undefined, { "retry-after": "30" });
        if (deps.balance() < FAKE_DIRECTOR_HOLD_USD) throw err(402, "insufficient_balance", LOW_BALANCE, "insufficient_balance");
        const t = newTurn(projectId, body.message as string, Number(body.max_tool_usd ?? 0), hash, key, revision, false);
        const steps = scriptFor();
        if (wantsStream) {
            const answered = stream(request, t);
            void drive(t, steps);
            return answered;
        }
        void drive(t, steps);
        return t.done.then(() => ({ status: 200, json: view(t) }));
    }

    function listTurns(projectId: string, query: URLSearchParams): CloudAnswer {
        const limitText = query.get("limit");
        const limit = limitText === null ? 20 : Number(limitText);
        if (!Number.isInteger(limit)) throw invalid("query.limit: Input should be a valid integer, unable to parse string as an integer");
        if (limit < 1) throw invalid("query.limit: Input should be greater than or equal to 1");
        if (limit > 50) throw invalid("query.limit: Input should be less than or equal to 50");
        const cursor = query.get("cursor");
        if (cursor !== null && !/^turn_[0-9a-f]{24}$/.test(cursor)) throw invalid("query.cursor: String should match pattern '^turn_[0-9a-f]{24}$'");
        facts(projectId);
        let rows = turns.filter((t) => t.projectId === projectId).sort((a, b) => b.seq - a.seq);
        if (cursor !== null) {
            const before = turns.find((t) => t.id === cursor);
            if (!before || before.projectId !== projectId) throw invalid("cursor is not a turn of this project.");
            rows = rows.filter((t) => t.seq < before.seq);
        }
        const page = rows.slice(0, limit);
        const more = rows.length > limit;
        return { status: 200, json: { object: "list", data: page.map(view), has_more: more, next_cursor: more && page.length ? page[page.length - 1]!.id : null } };
    }

    // ── project tasks ──

    function statusOf(task: ProjectTask): "queued" | "running" | "succeeded" | "failed" | "cancelled" {
        if (task.cancelled) return "cancelled";
        if (task.step < task.queuedSteps) return "queued";
        const stages = PROJECT_TOOLS[task.tool].stages.length;
        if (task.step < task.queuedSteps + stages || (task.held && !task.released)) return "running";
        return task.fail !== undefined ? "failed" : "succeeded";
    }

    function taskBody(task: ProjectTask): Record<string, unknown> {
        const status = statusOf(task);
        const stages = PROJECT_TOOLS[task.tool].stages;
        const index = Math.max(0, task.step - task.queuedSteps);
        const body: Record<string, unknown> = {
            id: task.id, object: "task", model: task.tool, status,
            progress: status === "succeeded" ? 100 : status === "running" ? Math.min(99, Math.round((100 * (index + 1)) / (stages.length + 1))) : 0,
            outputs: [], price_usd: task.hold, created_at: iso(task.createdAt),
            finished_at: task.finishedAt === null ? null : iso(task.finishedAt), error: null, project_id: task.projectId,
        };
        if (status === "failed") {
            const kind = task.fail ?? "internal";
            // As the server's task view: the refund wording only (no code), the price it held kept.
            body.error = { message: deps.publicErrors[kind] ?? deps.publicErrors.internal, refunded: true };
        }
        if (status === "cancelled") body.error = { message: deps.texts.cancelled, refunded: true };
        if (status === "queued" || status === "running") body.stage = stages[Math.min(stages.length - 1, index)];
        if (status === "succeeded") {
            body.result = task.result;
            if (task.projectRevision !== null) body.project_revision = task.projectRevision;
        }
        return body;
    }

    function submit(tool: FakeProjectToolId, projectId: string, inputs: Record<string, unknown>, key: string | null): ProjectTask {
        const hash = hashOf({ tool, project_id: projectId, inputs });
        if (key !== null) {
            const earlier = [...tasks.values()].find((x) => x.key === key);
            if (earlier) {
                if (earlier.hash !== hash) throw err(409, "idempotency_error", "Idempotency-Key was already used for a different request.", "idempotency_key_reused");
                return earlier;
            }
        }
        const hold = round6(fakeProjectToolHold(tool, facts(projectId), inputs) + proposalBump);
        if (deps.balance() < hold) throw err(402, "insufficient_balance", LOW_BALANCE, "insufficient_balance");
        const failNext = deps.takeFail(tool);
        const task: ProjectTask = {
            id: deps.nextTaskId(), tool, projectId, inputs, hold, step: 0, queuedSteps: deps.taskSteps(), cancelled: false, paidStarted: false, held: holdTasks,
            released: false, settled: false, projectRevision: null, result: null, key, hash, createdAt: Date.now(), finishedAt: null,
            ...(failNext !== undefined ? { fail: failNext } : {}),
        };
        tasks.set(task.id, task);
        return task;
    }

    const shotsOf = (scene: FakeProjectFacts["scenes"][number]) => scene.shots.map((s) => ({ ...s }) as Record<string, unknown>);
    const thirds = (duration: number) => {
        const third = Math.round((duration / 3) * 1000) / 1000;
        return [third, third, Math.round((duration - 2 * third) * 1000) / 1000];
    };

    /** What a succeeded run writes into the project (one revision), and its result. */
    function write(task: ProjectTask): { revision: number; result: unknown } {
        const base = deps.base();
        const project = facts(task.projectId);
        const png = `${base}/files/generated.png`;
        const webm = `${base}/files/generated.webm`;
        const label = `AI: ${Object.values(PAID_TOOLS).find((p) => p[0] === task.tool)![4]}`;
        if (task.tool === "story-scenes") {
            const cues = project.cues ?? [];
            if (cues.length === 0) throw err(409, "conflict", SCENE_NOT_READY, "conflict");
            const answer = deps.cloud.change(task.projectId, {
                label,
                scenes: {
                    delete: project.scenes.map((s) => s.id),
                    create: cues.map((cue, order) => ({
                        id: randomUUID(), order, caption: cue.text, card_type: "ai_video", start_time: cue.start, end_time: cue.end,
                        timeline_position_seconds: cue.start_seconds, duration: Math.max(0.1, Math.round((cue.end_seconds - cue.start_seconds) * 1000) / 1000),
                    })),
                },
            }, FAKE_DIRECTOR_DEVICE);
            return { revision: answer.revision as number, result: { scenes: answer.scenes } };
        }
        const scene = project.scenes.find((s) => s.id === task.inputs.scene_id);
        if (!scene) throw err(404, "not_found", SCENE_NOT_FOUND, "not_found");
        const videoPatch = () => deps.cloud.change(task.projectId, { label, scenes: { patch: [{ id: scene.id, video_url: webm }] } }, FAKE_DIRECTOR_DEVICE).revision as number;
        switch (task.tool) {
            case "storyboard": {
                const shots = scene.shots.length > 0
                    ? shotsOf(scene).map((s) => ({ ...s, image_url: png }))
                    : thirds(scene.duration).map((duration, i) => ({ description: `${scene.caption || "Scene"}: shot ${i + 1}`, duration, image_url: png }));
                // One sheet cut into one panel per shot (the shots' images are the panels).
                const sheets = [{ image_url: `${png}?sheet=${task.id}`, panels: shots.map((_, i) => ({ index: i, shot_index: i, image_url: png })) }];
                deps.cloud.cloud.setShots(task.projectId, scene.id, shots, sheets);
                const revision = deps.cloud.cloud.bump(task.projectId).revision;
                return { revision, result: { sheets } };
            }
            case "smart-scene-video": {
                const revision = videoPatch();
                const model = typeof task.inputs.model === "string" && task.inputs.model !== "auto" ? task.inputs.model : "seedance-2";
                const indexes = scene.shots.length > 0 ? scene.shots.map((_, i) => i) : [0];
                return { revision, result: { video_url: webm, model, chunks: [{ shot_indexes: indexes, duration: scene.duration, video_url: webm }] } };
            }
            case "copy-video-detect": {
                const shots = thirds(scene.duration).map((duration, i) => ({ description: `Detected shot ${i + 1}`, duration }));
                deps.cloud.cloud.setShots(task.projectId, scene.id, shots);
                const revision = deps.cloud.cloud.bump(task.projectId).revision;
                return { revision, result: { shots: shots.map((s, i) => ({ index: i, ...s })) } };
            }
            case "copy-video-edit": {
                const index = task.inputs.index as number;
                const shots = shotsOf(scene);
                if (!shots[index]) throw err(404, "not_found", SHOT_NOT_FOUND, "not_found");
                const image = `${png}?edit=${task.id}`;
                shots[index] = { ...shots[index], image_url: image };
                deps.cloud.cloud.setShots(task.projectId, scene.id, shots);
                const revision = deps.cloud.cloud.bump(task.projectId).revision;
                return { revision, result: { image_url: image } };
            }
            case "copy-video-recreate": {
                const revision = videoPatch();
                return { revision, result: { video_url: webm, shots_rendered: Math.max(1, scene.shots.length) } };
            }
        }
        throw new Error(`no writer for ${task.tool}`);
    }

    function settle(task: ProjectTask): void {
        task.settled = true;
        task.finishedAt = Date.now();
        try {
            const written = write(task);
            task.projectRevision = written.revision;
            task.result = written.result;
            deps.charge(task.hold);
        } catch (error) {
            if (!(error instanceof FakeCloudError)) throw error;
            task.fail = "pipeline_failed";
        }
    }

    function getTask(task: ProjectTask): CloudAnswer {
        const before = statusOf(task);
        if (before === "queued" || before === "running") task.step += 1;
        const now = statusOf(task);
        if (now === "running" && deps.paidStarted(task.tool)) task.paidStarted = true;
        if (now === "succeeded" && !task.settled) settle(task);
        if (now === "failed" && task.finishedAt === null) {
            task.settled = true;
            task.finishedAt = Date.now();
        }
        return { status: 200, json: taskBody(task) };
    }

    function cancelTask(task: ProjectTask): CloudAnswer {
        const status = statusOf(task);
        if (status === "cancelled") return { status: 200, json: taskBody(task) };
        if (status === "succeeded" || status === "failed") throw err(409, "conflict", deps.texts.cancelConflict, "task_already_finished");
        if (deps.takeCancelBusy()) throw err(409, "conflict", deps.texts.cancelBusy, "task_busy_retry", undefined, { "retry-after": "1" });
        if (status === "running" && (task.paidStarted || deps.paidStarted(task.tool))) throw err(409, "conflict", deps.texts.cancelConflict, "task_not_cancellable");
        task.cancelled = true;
        task.finishedAt = Date.now();
        return { status: 200, json: taskBody(task) };
    }

    // ── pipeline routes ──

    const PIPELINE_ROUTES: Array<[RegExp, FakeProjectToolId]> = [
        [/^\/v1\/projects\/([^/]+)\/story\/plan$/, "story-scenes"],
        [/^\/v1\/projects\/([^/]+)\/scenes\/([^/]+)\/storyboard$/, "storyboard"],
        [/^\/v1\/projects\/([^/]+)\/scenes\/([^/]+)\/videos$/, "smart-scene-video"],
        [/^\/v1\/projects\/([^/]+)\/scenes\/([^/]+)\/copy-video\/detections$/, "copy-video-detect"],
        [/^\/v1\/projects\/([^/]+)\/scenes\/([^/]+)\/shots\/([^/]+)\/image-edits$/, "copy-video-edit"],
        [/^\/v1\/projects\/([^/]+)\/scenes\/([^/]+)\/copy-video\/recreate$/, "copy-video-recreate"],
    ];

    /**
     * run_proposal: once, within 15 minutes, never above the proposal's price; the step route's scopes. An
     * Idempotency-Key (1-64 characters) names this run request (the ids and the body, which must be {}) for good: the
     * same key answers the same task, the key on another request is 409 idempotency_key_reused (checked first); a run
     * refused before a task leaves its key unused.
     */
    function runProposal(request: DirectorRequest, projectId: string, turnId: string, proposalId: string): CloudAnswer {
        if (!/^turn_[0-9a-f]{24}$/.test(turnId)) throw invalid("path.turn_id: String should match pattern '^turn_[0-9a-f]{24}$'");
        if (!/^prop_[0-9a-f]{24}$/.test(proposalId)) throw invalid("path.proposal_id: String should match pattern '^prop_[0-9a-f]{24}$'");
        const header = request.headers["idempotency-key"];
        const key = typeof header === "string" ? header : null;
        if (key !== null && (key.length < 1 || key.length > 64)) throw invalid("Idempotency-Key must be 1-64 characters.");
        const body = request.body === undefined || request.body === null ? {} : request.body;
        const hash = hashOf({ projectId, turnId, proposalId, body });
        const known = key !== null ? runKeys.get(key) : undefined;
        if (known !== undefined && known !== hash) throw err(409, "idempotency_error", "This Idempotency-Key was already used for another run request.", "idempotency_key_reused");
        if (typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).length > 0) throw invalid("Send the proposal's run request as it is: its body is {} (the proposal holds the step).");
        const stored = proposals.get(proposalId);
        if (!stored || stored.projectId !== projectId || stored.turnId !== turnId) throw err(404, "not_found", NO_PROPOSAL, "not_found");
        if (!request.scopes.includes("api:project")) throw err(403, "permission_error", "This API key is not allowed to use cloud projects (scope api:project).", "permission_denied");
        if (!request.scopes.includes("api:opennan")) throw err(403, "permission_error", "This API key is not allowed to use opennan tools (scope api:opennan).", "permission_denied");
        const claim = () => {
            if (key !== null) runKeys.set(key, hash);
        };
        if (stored.taskId) {
            claim();
            return { status: 200, json: taskBody(tasks.get(stored.taskId)!) };
        }
        if (Date.now() >= stored.expiresAt) throw err(410, "gone", PROPOSAL_EXPIRED, "proposal_expired");
        const now = round6(fakeProjectToolHold(stored.tool, facts(projectId), stored.inputs) + proposalBump);
        if (now > stored.price + 1e-9) throw err(409, "conflict", PRICE_CHANGED, "proposal_price_changed", { price_usd: now });
        const task = submit(stored.tool, projectId, stored.inputs, `${proposalId}:run`);
        stored.taskId = task.id;
        claim();
        return { status: 202, json: taskBody(task) };
    }

    function pipeline(request: DirectorRequest, tool: FakeProjectToolId, match: RegExpExecArray): CloudAnswer {
        const projectId = decodeURIComponent(match[1]!);
        const ids: Record<string, unknown> = {};
        if (match[2] !== undefined) ids.scene_id = decodeURIComponent(match[2]);
        if (match[3] !== undefined) {
            const index = Number(match[3]);
            if (!/^\d+$/.test(match[3]) || !Number.isInteger(index)) throw invalid("path.index: Input should be a valid integer, unable to parse string as an integer");
            if (index > 999) throw invalid("path.index: Input should be less than or equal to 999");
            ids.index = index;
        }
        if (request.body === undefined) throw invalid("body: Field required");
        const parsed = validator.body(BODIES[tool], request.body);
        if (!request.scopes.includes("api:project")) throw err(403, "permission_error", "This API key is not allowed to use cloud projects (scope api:project).", "permission_denied");
        if (!request.scopes.includes("api:opennan")) throw err(403, "permission_error", "This API key is not allowed to use opennan tools (scope api:opennan).", "permission_denied");
        const header = request.headers["idempotency-key"];
        const key = typeof header === "string" && header.length > 0 ? header : null;
        if (key !== null && key.length > 255) throw invalid("Idempotency-Key must be at most 255 characters.");
        const task = submit(tool, projectId, { ...ids, ...inputsFor(tool, parsed) }, key);
        return { status: 202, json: taskBody(task) };
    }

    // ── quotes ──

    function projectQuote(tool: FakeProjectToolId, body: Record<string, unknown>, scopes: readonly string[] | null): CloudAnswer {
        const allowed = ["index", "inputs", "project_id", "scene_id"];
        const extra = Object.keys(body).filter((k) => k !== "model" && k !== "tool" && !allowed.includes(k)).sort();
        if (extra.length > 0) throw invalid(`${extra.join(", ")}: not a field of ${tool}. It takes: ${allowed.join(", ")}.`);
        if (body.project_id != null && (typeof body.project_id !== "string" || !/^[A-Za-z0-9_-]{1,36}$/.test(body.project_id))) throw invalid("project_id: String should match pattern '^[A-Za-z0-9_-]{1,36}$'");
        if (body.scene_id != null && (typeof body.scene_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.scene_id))) throw invalid("scene_id: String should match pattern '^[A-Za-z0-9_-]{1,64}$'");
        if (body.index != null && (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0 || body.index > 999)) throw invalid("index: Input should be an integer from 0 to 999");
        if (body.inputs != null && (typeof body.inputs !== "object" || Array.isArray(body.inputs))) throw invalid("inputs: Input should be a valid dictionary");
        if (!body.project_id) throw invalid(`project_id: ${tool} works on a cloud project: send its id.`);
        const [, needsScene, needsIndex] = Object.values(PAID_TOOLS).find((p) => p[0] === tool)!;
        if (needsScene && !body.scene_id) throw invalid(`scene_id: ${tool} works on a scene: send its id.`);
        if (!needsScene && body.scene_id != null) throw invalid(`scene_id: ${tool} works on the whole project.`);
        if (needsIndex && body.index == null) throw invalid(`index: ${tool} works on one shot: send its index.`);
        if (!needsIndex && body.index != null) throw invalid(`index: ${tool} takes no shot index.`);
        let parsed: Record<string, unknown>;
        try {
            parsed = validator.body(BODIES[tool], body.inputs ?? {});
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const unknown = /^Unknown field ([^:]+):/.exec(message);
            if (unknown) throw invalid(`inputs.${unknown[1]}: not a field of this tool's body`);
            if (message.startsWith("Value error, ")) throw invalid(`inputs.inputs: ${message.slice("Value error, ".length)}`);
            const at = /^([^:]+): (.*)$/.exec(message);
            throw invalid(at ? `inputs.${at[1]}: ${at[2]!.replace(/^Value error, /, "")}` : `inputs.inputs: ${message}`);
        }
        if (scopes === null) throw err(401, "authentication_error", "Invalid or revoked API key.", "invalid_api_key");
        if (!scopes.includes("api:project")) throw err(403, "permission_error", "This API key is not allowed to use cloud projects (scope api:project).", "permission_denied");
        if (!scopes.includes("api:opennan")) throw err(403, "permission_error", "This API key is not allowed to use opennan tools (scope api:opennan).", "permission_denied");
        const ids: Record<string, unknown> = needsScene ? { scene_id: body.scene_id } : {};
        if (needsIndex) ids.index = body.index;
        const inputs = { ...ids, ...inputsFor(tool, parsed) };
        const hold = fakeProjectToolHold(tool, facts(body.project_id as string), inputs);
        return {
            status: 200,
            json: { object: "quote", model: null, tool, currency: "usd", price_usd: hold, hold_usd: hold, priced: { project_id: body.project_id, ...inputs } },
        };
    }

    // ── the handle ──

    const director: FakeDirector = {
        script(steps, options) {
            scripts.push({ steps: json(steps), repeat: options?.repeat === true });
        },
        setUnavailable(on) {
            unavailable = on;
        },
        setHeartbeat(ms) {
            heartbeatMs = Number.isFinite(ms) && ms > 0 ? ms : FAKE_DIRECTOR_HEARTBEAT_MS;
        },
        rateLimit(count) {
            rateLimited = Math.max(0, Math.floor(count));
        },
        hold(projectId) {
            const revision = facts(projectId).revision;
            const busy = running().find((t) => t.projectId === projectId);
            if (busy) throw inProgress(busy.id);
            const t = newTurn(projectId, "Working on another device", 0, hashOf({ held: randomUUID() }), null, revision, true);
            void drive(t, []);
            return t.id;
        },
        release() {
            for (const t of running()) if (t.held) t.released = true;
        },
        holdTasks(on) {
            holdTasks = on;
        },
        finishTask(taskId) {
            const task = tasks.get(taskId);
            if (!task) return false;
            task.released = true;
            task.step = Math.max(task.step, task.queuedSteps + PROJECT_TOOLS[task.tool].stages.length - 1);
            return true;
        },
        state() {
            return {
                turns: turns.map((t) => ({ ...(view(t) as FakeDirectorTurnState), events: json(t.events) })),
                running: running().map((t) => t.id),
                scripts: scripts.length,
                unavailable,
                heartbeatMs,
                holdTasks,
                tasks: [...tasks.values()].map((task) => ({
                    id: task.id, tool: task.tool, project_id: task.projectId, status: statusOf(task), hold_usd: task.hold, project_revision: task.projectRevision,
                })),
            };
        },
    };

    const guard = <T>(work: () => T): T | CloudAnswer => {
        try {
            return work();
        } catch (error) {
            if (error instanceof FakeCloudError) return error.answer();
            throw error;
        }
    };

    function api(request: DirectorRequest): CloudAnswer | Promise<CloudAnswer> | "streamed" | null {
        const { method, path } = request;
        const turnRoute = /^\/v1\/projects\/([^/]+)\/director\/turns(?:\/([^/]+)(\/cancel)?)?$/.exec(path);
        if (turnRoute) {
            const projectId = decodeURIComponent(turnRoute[1]!);
            const turnId = turnRoute[2] === undefined ? null : decodeURIComponent(turnRoute[2]);
            return guard((): CloudAnswer | Promise<CloudAnswer> | "streamed" | null => {
                if (turnId === null && method === "POST") return createTurn(request, projectId);
                if (turnId === null && method === "GET") {
                    checkTurnScopes(request.scopes);
                    return listTurns(projectId, request.query);
                }
                if (turnId !== null && !turnRoute[3] && method === "GET") {
                    checkTurnScopes(request.scopes);
                    return { status: 200, json: view(ownedTurn(projectId, turnId)) };
                }
                if (turnId !== null && turnRoute[3] && method === "POST") {
                    checkTurnScopes(request.scopes);
                    const t = ownedTurn(projectId, turnId);
                    if (t.status !== "running") throw err(409, "conflict", ERRORS.turn_already_finished, "turn_already_finished");
                    t.cancelRequested = true;
                    return { status: 200, json: view(t) };
                }
                return null;
            });
        }
        const runRoute = /^\/v1\/projects\/([^/]+)\/director\/turns\/([^/]+)\/proposals\/([^/]+)\/run$/.exec(path);
        if (runRoute && method === "POST") return guard(() => runProposal(request, decodeURIComponent(runRoute[1]!), decodeURIComponent(runRoute[2]!), decodeURIComponent(runRoute[3]!)));
        if (method !== "POST") return null;
        for (const [pattern, tool] of PIPELINE_ROUTES) {
            const match = pattern.exec(path);
            if (match) return guard(() => pipeline(request, tool, match));
        }
        return null;
    }

    const ok = (json: unknown): CloudAnswer => ({ status: 200, json });
    const bad = (error: string): CloudAnswer => ({ status: 400, json: { ok: false, error } });

    function checkSteps(raw: unknown): FakeDirectorStep[] | string {
        if (!Array.isArray(raw)) return "steps: send an array of steps";
        for (const [i, step] of raw.entries()) {
            if (!step || typeof step !== "object") return `steps[${i}]: not a step`;
            const kinds = Object.keys(step).filter((k) => ["text", "tool", "edit", "proposal", "delay", "fail", "refuse"].includes(k));
            if (kinds.length !== 1) return `steps[${i}]: one of text, tool, edit, proposal, delay, fail, refuse`;
            const s = step as Record<string, any>;
            if (kinds[0] === "text" && typeof s.text !== "string") return `steps[${i}].text: a string`;
            if (kinds[0] === "tool" && (typeof s.tool?.name !== "string" || typeof s.tool?.label !== "string")) return `steps[${i}].tool: {name, label, args?, ok?, summary?}`;
            if (kinds[0] === "edit" && (typeof s.edit?.label !== "string" || typeof s.edit?.changes !== "object")) return `steps[${i}].edit: {label, changes}`;
            if (kinds[0] === "proposal" && !(s.proposal?.tool in PAID_TOOLS)) return `steps[${i}].proposal.tool: one of ${Object.keys(PAID_TOOLS).join(", ")}`;
            if (kinds[0] === "delay" && !(typeof s.delay === "number" && s.delay >= 0)) return `steps[${i}].delay: milliseconds`;
            if (kinds[0] === "fail" && typeof s.fail !== "string") return `steps[${i}].fail: an error code`;
        }
        return raw as FakeDirectorStep[];
    }

    function knob(path: string, query: URLSearchParams, body: unknown): CloudAnswer | null {
        const on = () => query.get("on") !== "0" && query.get("on") !== "false";
        switch (path) {
            case "/__test/director/script": {
                const b = (body ?? {}) as { steps?: unknown; repeat?: unknown };
                const steps = checkSteps(b.steps);
                if (typeof steps === "string") return bad(steps);
                director.script(steps, { repeat: b.repeat === true });
                return ok({ ok: true, scripts: scripts.length });
            }
            case "/__test/director/unavailable":
                director.setUnavailable(on());
                return ok({ ok: true, unavailable });
            case "/__test/director/heartbeat":
                director.setHeartbeat(Number(query.get("ms") ?? FAKE_DIRECTOR_HEARTBEAT_MS));
                return ok({ ok: true, ms: heartbeatMs });
            case "/__test/director/rate-limit":
                director.rateLimit(Number(query.get("n") ?? "1"));
                return ok({ ok: true, n: rateLimited });
            case "/__test/director/hold": {
                const projectId = query.get("project_id") ?? "";
                try {
                    return ok({ ok: true, turn_id: director.hold(projectId) });
                } catch (error) {
                    if (error instanceof FakeCloudError && error.status === 409) return { status: 409, json: { ok: false, error: error.message, turn_id: error.details?.turn_id } };
                    return { status: 404, json: { ok: false, error: `no project ${projectId}` } };
                }
            }
            case "/__test/director/release":
                director.release();
                return ok({ ok: true });
            case "/__test/director/hold-tasks":
                director.holdTasks(on());
                return ok({ ok: true, holdTasks });
            case "/__test/tasks/finish": {
                const id = query.get("id") ?? "";
                return director.finishTask(id) ? ok({ ok: true }) : { status: 404, json: { ok: false, error: `no project task ${id}` } };
            }
            case "/__test/director/state":
                return ok(director.state());
            case "/__test/director/proposal-price": {
                const b = (body ?? {}) as { bump_usd?: unknown };
                if (typeof b.bump_usd !== "number" || !Number.isFinite(b.bump_usd) || b.bump_usd < 0) return bad("bump_usd is a non-negative number of dollars");
                proposalBump = b.bump_usd;
                return ok({ ok: true, bump_usd: proposalBump });
            }
            case "/__test/director/proposal-expire": {
                const b = (body ?? {}) as { proposal_id?: unknown };
                for (const stored of proposals.values()) if (b.proposal_id === undefined || stored.id === b.proposal_id) stored.expiresAt = Date.now() - 1000;
                return ok({ ok: true });
            }
            default:
                return null;
        }
    }

    return {
        director,
        api,
        task(id, cancel) {
            const task = tasks.get(id);
            if (!task) return null;
            return guard(() => (cancel ? cancelTask(task) : getTask(task)));
        },
        quote(body, scopes) {
            if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.tool !== "string" || typeof body.model === "string") return null;
            const tool = body.tool.trim().toLowerCase();
            if (tool === "director-turn") {
                const extra = Object.keys(body).filter((k) => k !== "model" && k !== "tool").sort();
                if (extra.length > 0) return invalid(`${extra.join(", ")}: not a field of director-turn. It takes: .`).answer();
                if (unavailable) return err(503, "unavailable", UNAVAILABLE, "director_unavailable").answer();
                return ok(fakeDirectorTurnQuote());
            }
            if (!(FAKE_PROJECT_TOOL_IDS as readonly string[]).includes(tool)) return null;
            return guard(() => projectQuote(tool as FakeProjectToolId, body, scopes));
        },
        toolRows() {
            const director = {
                id: "director-turn", object: "tool", kind: "pipeline", category: "opennan", method: "POST", path: "/v1/projects/{project_id}/director/turns",
                status: unavailable ? "unavailable" : "live", mcp_tool: null, free: false,
                price: unavailable ? null : { unit: "turn", max_usd: FAKE_DIRECTOR_HOLD_USD, typical_usd: FAKE_DIRECTOR_TYPICAL_USD, limits: { ...FAKE_DIRECTOR_LIMITS } },
                limits: null, summary: "Edit a cloud project by chat; paid video steps run or are proposed",
            };
            const project = FAKE_PROJECT_TOOL_IDS.map((id) => ({
                id, object: "tool", kind: "pipeline", category: "opennan", method: "POST", path: PROJECT_TOOLS[id].path, status: "live", mcp_tool: PROJECT_TOOLS[id].mcp,
                free: false, price: { ...PROJECT_TOOLS[id].price }, limits: null, summary: PROJECT_TOOLS[id].summary,
            }));
            return [...project, director];
        },
        knob,
        reset() {
            generation += 1;
            for (const t of turns) t.cancelRequested = true;
            turns = [];
            scripts = [];
            unavailable = false;
            heartbeatMs = FAKE_DIRECTOR_HEARTBEAT_MS;
            rateLimited = 0;
            holdTasks = false;
            tasks = new Map();
            proposals = new Map();
            proposalBump = 0;
            runKeys = new Map();
        },
    };
}
