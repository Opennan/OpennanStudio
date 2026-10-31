// Tests only: the prototype's story (examples/story-film/rain-check.json), validated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoryFilm } from "./types";
import { parseStoryFilm } from "./validate";

export const RAIN_CHECK_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/story-film/rain-check.json");

export function rainCheck(): StoryFilm {
    const parsed = parseStoryFilm(JSON.parse(fs.readFileSync(RAIN_CHECK_PATH, "utf8")));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.story;
}
