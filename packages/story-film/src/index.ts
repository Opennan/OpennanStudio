// Public API of @opennan/story-film: the story film (types and validator), the recipe's prompts, drafts from a text
// model (write a story, copy a video), the pipeline over provider capabilities, and the reel layout of the result.
export const STORY_FILM_PACKAGE_VERSION = "0.1.0";

export { STORY_FILM_VERSION, STORY_MEDIUMS, STORY_STEPS, type StoryAsset, type StoryCastCheck, type StoryCharacter, type StoryFilm, type StoryMedium, type StorySettings, type StoryShot, type StorySource, type StoryStep } from "./types";
export { DEFAULT_SHOT_SECONDS, STORY_LIMITS, assetOf, castCheckOf, filmSeconds, parseStoryFilm, readStoryJson, shotSeconds, slugId, storyJson, type StoryParse } from "./validate";
export { castOf, keyframePrompt, motionPrompt, musicPrompt, redrawPrompt, sheetPrompt } from "./recipe";
export {
    CAST_CHECK_MAX_REDRAWS, CAST_CHECK_MAX_TOKENS, CAST_CHECK_REDRAWS, castCheckRequest, parseCastCheck, type CastCheckRequest, type CastVerdict,
} from "./check";
export {
    DRAFT_MAX_TOKENS, blankStory, copyDraftRequest, jsonObjectOf, parseDraftReply, writeDraftRequest,
    type CopyDraftInput, type DraftRequest, type WriteDraftInput,
} from "./draft";
export {
    STORY_DEFAULTS, STORY_VIDEO_MODELS, castCheckRedraws, defaultImageModel, defaultVideoModel, draftTextModel, estimateCastCheck, estimateStep, isFlagged, isStale, itemsToRun,
    requestKey, runStep, storyItem, storyItems, videoModelChoices, withAsset, withCheck,
    type ItemStatus, type ItemUpdate, type RunStepOptions, type StepEstimate, type StepOptions, type StepOutcome, type StoryFilmHost, type StoryItem, type StoryRunMedia,
    type StoryRunOptions, type StoryRunResult,
} from "./pipeline";
export { reelInputOf, withAssembled, type ReelInputResult } from "./assemble";
export { mergeStory, storyProgress, withNewerAssets, type StepProgress } from "./edit";
