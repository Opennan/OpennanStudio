// The paid OpenNan project pipelines (story plan, storyboard, scene video, copy-video steps): their REST routes under
// /v1/projects/{id}, the request for one step, the quote body of a request, and the allowlist every request must pass
// before it is sent (POSTs to these routes of one project, with a JSON object body of bounded size, nothing else).
// No Studio host runs these since cloud projects were removed: they need a project on OpenNan's server. Kept so the
// routes stay documented until OpenNan offers them as project-free tools (see the package README).
import { isRecord, type PipelineRequest } from "./director-types";

export type ProjectToolId = "story-scenes" | "storyboard" | "smart-scene-video" | "copy-video-detect" | "copy-video-edit" | "copy-video-recreate";

export const PROJECT_TOOL_IDS: readonly ProjectToolId[] = ["story-scenes", "storyboard", "smart-scene-video", "copy-video-detect", "copy-video-edit", "copy-video-recreate"];

/** Video models a project tool renders with ("auto" first) and the qualities each takes (as the routes take them). */
export const PROJECT_VIDEO_MODELS: Readonly<Record<string, { qualities: readonly string[]; tools: readonly ProjectToolId[] }>> = {
    "seedance-2": { qualities: ["480p", "720p", "1080p"], tools: ["storyboard", "copy-video-recreate", "smart-scene-video"] },
    "kling-o3": { qualities: ["720p", "1080p"], tools: ["storyboard", "smart-scene-video"] },
    "kling-3": { qualities: ["720p", "1080p"], tools: ["smart-scene-video"] },
};
export const AUTO_VIDEO_MODEL = "seedance-2";
export const VIDEO_QUALITIES = ["480p", "720p", "1080p"] as const;

export function projectVideoModels(tool: ProjectToolId): string[] {
    return ["auto", ...Object.entries(PROJECT_VIDEO_MODELS).filter(([, info]) => info.tools.includes(tool)).map(([id]) => id)];
}

export function videoQualities(model: string): readonly string[] {
    return PROJECT_VIDEO_MODELS[model === "auto" ? AUTO_VIDEO_MODEL : model]?.qualities ?? VIDEO_QUALITIES;
}

/** A pipeline request with what it runs on (read from its path). */
export interface CheckedRequest extends PipelineRequest {
    tool: ProjectToolId;
    projectId: string;
    sceneId?: string;
    index?: number;
}

const ID = "([A-Za-z0-9_-]{1,64})";
const ROUTES: Array<{ tool: ProjectToolId; pattern: RegExp; fields: readonly string[] }> = [
    { tool: "story-scenes", pattern: new RegExp(`^/v1/projects/${ID}/story/plan$`), fields: ["style", "concept", "direction"] },
    { tool: "storyboard", pattern: new RegExp(`^/v1/projects/${ID}/scenes/${ID}/storyboard$`), fields: ["model", "regenerate"] },
    { tool: "smart-scene-video", pattern: new RegExp(`^/v1/projects/${ID}/scenes/${ID}/videos$`), fields: ["model", "quality", "generate_audio"] },
    { tool: "copy-video-detect", pattern: new RegExp(`^/v1/projects/${ID}/scenes/${ID}/copy-video/detections$`), fields: [] },
    { tool: "copy-video-edit", pattern: new RegExp(`^/v1/projects/${ID}/scenes/${ID}/shots/(\\d{1,3})/image-edits$`), fields: ["instruction"] },
    { tool: "copy-video-recreate", pattern: new RegExp(`^/v1/projects/${ID}/scenes/${ID}/copy-video/recreate$`), fields: ["model", "quality", "generate_audio"] },
];

/** A request body is small (style and direction texts): anything bigger is refused. */
export const MAX_PIPELINE_BODY_CHARS = 16 * 1024;

/**
 * The request, if it is one of the pipeline routes of `projectId` (the server id) with a body of that route's fields
 * only; null otherwise (nothing is sent).
 */
export function checkPipelineRequest(projectId: string, request: unknown): CheckedRequest | null {
    if (!isRecord(request) || request.method !== "POST" || typeof request.path !== "string") return null;
    const body = request.body === undefined ? {} : request.body;
    if (!isRecord(body)) return null;
    let size: number;
    try {
        size = JSON.stringify(body).length;
    } catch {
        return null;
    }
    if (size > MAX_PIPELINE_BODY_CHARS) return null;
    for (const route of ROUTES) {
        const match = route.pattern.exec(request.path);
        if (!match) continue;
        if (match[1] !== projectId) return null;
        if (Object.keys(body).some((key) => !route.fields.includes(key))) return null;
        const checked: CheckedRequest = { method: "POST", path: request.path, body: { ...body }, tool: route.tool, projectId };
        if (match[2] !== undefined) checked.sceneId = match[2];
        if (match[3] !== undefined) {
            const index = Number(match[3]);
            if (!(index >= 0 && index <= 999)) return null;
            checked.index = index;
        }
        return checked;
    }
    return null;
}

/** The request for one pipeline step. */
export function pipelineRequest(tool: ProjectToolId, projectId: string, target: { sceneId?: string; index?: number; body?: Record<string, unknown> } = {}): CheckedRequest {
    const scene = target.sceneId !== undefined ? encodeURIComponent(target.sceneId) : "";
    const base = `/v1/projects/${encodeURIComponent(projectId)}`;
    const path = tool === "story-scenes" ? `${base}/story/plan`
        : tool === "storyboard" ? `${base}/scenes/${scene}/storyboard`
        : tool === "smart-scene-video" ? `${base}/scenes/${scene}/videos`
        : tool === "copy-video-detect" ? `${base}/scenes/${scene}/copy-video/detections`
        : tool === "copy-video-edit" ? `${base}/scenes/${scene}/shots/${target.index ?? 0}/image-edits`
        : `${base}/scenes/${scene}/copy-video/recreate`;
    const checked = checkPipelineRequest(projectId, { method: "POST", path, body: target.body ?? {} });
    if (!checked) throw new Error("This pipeline step can't run on this project.");
    return checked;
}

/** POST /v1/quotes body of a pipeline request (the route's body as `inputs`). */
export function quoteBodyOf(request: CheckedRequest): Record<string, unknown> {
    return {
        tool: request.tool, project_id: request.projectId,
        ...(request.sceneId !== undefined ? { scene_id: request.sceneId } : {}),
        ...(request.index !== undefined ? { index: request.index } : {}),
        ...(Object.keys(request.body).length > 0 ? { inputs: request.body } : {}),
    };
}
