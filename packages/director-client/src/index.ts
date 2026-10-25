// Public API of @opennan/director-client (OpenNan Community License): the client for OpenNan's project pipeline
// routes (story plan, storyboard, scene video, copy-video) and the script cue cutter. No Studio host uses the pipeline
// client since cloud projects were removed; see README.md.
export const DIRECTOR_CLIENT_VERSION = "0.3.0";

export {
    createProjectApi, ProjectApiError, isProjectApiError, isAbortError, isAllowedProjectApiBase,
    type ProjectApi, type ProjectApiMethod, type ProjectApiRequest, type ProjectApiResponse, type ProjectApiOptions, type ProjectApiErrorInit,
} from "./api";
export { parseQuote, isRecord, type Quote, type PipelineRequest } from "./director-types";
export {
    checkPipelineRequest, pipelineRequest, quoteBodyOf, projectVideoModels, videoQualities, PROJECT_TOOL_IDS, PROJECT_VIDEO_MODELS, AUTO_VIDEO_MODEL, VIDEO_QUALITIES, MAX_PIPELINE_BODY_CHARS,
    type ProjectToolId, type CheckedRequest,
} from "./director-pipelines";
export {
    createQuotes, formatUsdUp, formatUsdNear, formatUsdExact, TOOL_QUOTE_MS,
    type DirectorQuotes, type ToolQuote,
} from "./director-quotes";
export {
    createProjectTasks, parseTaskState, TASK_WAIT_SECONDS, MIN_POLL_MS, TASK_DEADLINE_MS, CANCEL_TOO_LATE, CANCEL_UNKNOWN,
    type ProjectTasks, type ProjectTaskHandle, type ProjectTaskState, type ProjectTaskOutcome, type ProjectTaskStatus, type CancelAnswer, type ProjectTasksOptions,
} from "./director-tasks";
export {
    cutScript, parseSrt, toSrt, sentencesOf, readingSeconds, MAX_CUES, MAX_SCRIPT_CHARS, MAX_SRT_CHARS, MIN_CUE_SECONDS, CUE_GAP_SECONDS,
    type Cue, type CueResult,
} from "./director-script";
