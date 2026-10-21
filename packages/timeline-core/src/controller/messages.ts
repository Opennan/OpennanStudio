// English failure toasts. Strings are the source's (FE/messages/en.json line noted);
// TimelineProvider replaces them with the host's localized TimelineMessages.
import type { EditorCommandType } from "./commands";

const SAVE_FAILED = "Could not save your edit";

export const DEFAULT_COMMAND_ERROR_MESSAGES: Partial<Record<EditorCommandType, string>> = {
    "clip.create": "Failed to create clip", // en.json:1856 timeline.clipCreateFailed
    "clip.update": "Failed to update clip", // en.json:1858 timeline.clipUpdateFailed
    "clip.updateMany": "Failed to update clip",
    "clip.move": "Failed to update clip",
    "clip.effect.add": "Failed to update clip",
    "clip.effect.update": "Failed to update clip",
    "clip.effect.remove": "Failed to update clip",
    "clip.effect.reorder": "Failed to update clip",
    "clip.split": "Failed to split clip",
    "clip.delete": "Failed to delete clip", // en.json:1857 timeline.deleteFailed
    "clip.batch": "Failed to update clips",
    "track.update": "Failed to update tracks",
    "transition.set": SAVE_FAILED,
    "transition.applyAll": SAVE_FAILED,
    "look.set": SAVE_FAILED,
    "attributes.paste": "Could not paste attributes",
    "scene.move": "Could not save timeline positions", // en.json:1853 timeline.couldNotSavePositions
    "scene.trim": "Could not save timeline positions",
    "scene.reorder": "Could not save timeline positions",
    "scene.split": "Failed to cut scene.", // en.json:1875 timeline.sceneSplitFailed
    "scene.add": "Failed to create clip", // nle-timeline.tsx:2550 reuses clipCreateFailed
    "scene.delete": "Failed to delete clip",
    "scene.duplicate": SAVE_FAILED,
    "scene.update": SAVE_FAILED,
    "shot.reorder": SAVE_FAILED,
    "shot.merge": SAVE_FAILED,
    "shot.delete": SAVE_FAILED,
    "shot.extract": SAVE_FAILED,
    "project.update": SAVE_FAILED,
    "history.undo": "Undo failed",
    "history.redo": "Redo failed",
    "ai.run": "Could not run the AI tool",
    "tracking.run": "Could not track the motion",
    "tracking.apply": "Could not apply the motion track",
    "analysis.run": "Could not analyse the audio",
    "analysis.fillers": "Could not find filler words",
    "cuts.apply": "Could not cut the clip",
    "beats.set": "Could not save the beats",
    "beats.autoCut": "Could not cut to the beat",
};

export const DEFAULT_LOAD_ERROR_MESSAGE = "Could not load the timeline";
export const DEFAULT_FALLBACK_ERROR_MESSAGE = SAVE_FAILED;
