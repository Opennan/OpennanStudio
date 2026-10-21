// Public API of @opennan/director-client (OpenNan Community License, as cloud-backend): the OpenNan AI director for
// OpenNan Studio over the cloud projects API client.
export const DIRECTOR_CLIENT_VERSION = "0.2.0";

export { readSse, SseIdleError, SSE_IDLE_MS, type SseEvent, type ReadSseOptions } from "./director-sse";
export {
    parseTurn, parseEvent, parseProposal, parseChange, parseToolResult, parseToolCard, parseLimits, parseQuote, parseTask, eventsOfTurn, isRecord,
    DEFAULT_TURN_LIMITS, MAX_MESSAGE_CHARS, MAX_SELECTION_CLIPS, MAX_SELECTION_SCENES, TURN_STATUSES,
    type DirectorEvent, type DirectorTurn, type TurnStatus, type TurnLimits, type TurnCard, type ToolCard, type ToolResult, type TurnTask, type TurnError,
    type TurnChange, type Proposal, type Quote, type PipelineRequest,
} from "./director-types";
export {
    streamTurn, listTurns, getTurn, cancelTurn, turnBody, MAX_TOOL_USD, STREAM_INTERRUPTED, FINAL_TURN_READS,
    type TurnBody, type TurnSelection, type StreamTurnOptions, type TurnPage,
} from "./director-turns";
export {
    checkPipelineRequest, pipelineRequest, proposalToolId, quoteBodyOf, projectVideoModels, videoQualities, PROJECT_TOOL_IDS, PROJECT_VIDEO_MODELS, AUTO_VIDEO_MODEL, VIDEO_QUALITIES, MAX_PIPELINE_BODY_CHARS,
    type ProjectToolId, type CheckedRequest,
} from "./director-pipelines";
export {
    createQuotes, formatUsdUp, formatUsdNear, formatUsdExact, TURN_QUOTE_MS, TOOL_QUOTE_MS, QUOTE_UNSUPPORTED_MS, QUOTE_RETRY_MS,
    type DirectorQuotes, type TurnQuote, type ToolQuote,
} from "./director-quotes";
export {
    createProjectTasks, parseTaskState, TASK_WAIT_SECONDS, MIN_POLL_MS, TASK_DEADLINE_MS, CANCEL_TOO_LATE, CANCEL_UNKNOWN,
    type ProjectTasks, type ProjectTaskHandle, type ProjectTaskState, type ProjectTaskOutcome, type ProjectTaskStatus, type CancelAnswer, type ProjectTasksOptions,
} from "./director-tasks";
export {
    cutScript, parseSrt, toSrt, sentencesOf, readingSeconds, MAX_CUES, MAX_SCRIPT_CHARS, MAX_SRT_CHARS, MIN_CUE_SECONDS, CUE_GAP_SECONDS,
    type Cue, type CueResult,
} from "./director-script";
