// Persistent series identities and priced dubbing. Every run uses the exact saved voice, never a fallback.
import { assetOf, castForSeries, parseSeriesCast, parseStoryFilm, requestKey, speechContext, type StoryDialogue, type StoryFilm } from "@opennan/story-film";
import { displayedUsd } from "@opennan/provider-sdk";
import { sceneSpan } from "../args";
import { failure, success, unavailable } from "../outcome";
import type { ToolHandler } from "./types";
import { readStory, saveStory } from "./story-film";
import { createPlacedClip, updateClip } from "./clips";

const NO_LIBRARY = "Open Studio and connect to its MCP server to use the shared series library.";
const lineKey = (story: StoryFilm, line: StoryDialogue) => requestKey({ ...speechInput(story, line), providerId: story.characters.find(c => c.id === line.characterId)!.voice!.providerId });
const data = (story: StoryFilm) => ({ story, speech: story.shots.map(shot => ({ shotId: shot.id, ...speechContext(story, shot) })) });
const speechInput = (story: StoryFilm, line: StoryDialogue) => {
    const voice = story.characters.find(c => c.id === line.characterId)?.voice;
    if (!voice) throw new Error(`Assign a voice to ${line.characterId} before dubbing. Nothing was generated.`);
    return { text: line.text, voice: voice.id, ...(voice.language ? { language: voice.language } : {}), ...(voice.model ? { model: voice.model } : {}) };
};

export const SERIES_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    async series_cast_list(_args, { session }) {
        const library = session.host?.seriesLibrary;
        if (!library) return unavailable(NO_LIBRARY);
        const series = (await library.list()).map(parseSeriesCast);
        return success(`${series.length} saved series. Reuse the listed character and voice ids; do not substitute another voice.`, { series });
    },
    async series_cast_save(args, { session }) {
        const library = session.host?.seriesLibrary;
        if (!library) return unavailable(NO_LIBRARY);
        const story = await readStory(session);
        if (!story) return failure("Create a story film first.");
        const cast = parseSeriesCast(castForSeries(story, String(args.series_id), String(args.name)));
        await library.save(cast);
        await saveStory(session, { ...story, series: { id: cast.id, name: cast.name } });
        return success(`Saved ${cast.name}. The same cast and voices are available in other episodes on this device.`, { series: cast });
    },
    async series_cast_apply(args, { session }) {
        const library = session.host?.seriesLibrary;
        if (!library) return unavailable(NO_LIBRARY);
        const cast = (await library.list()).map(parseSeriesCast).find(s => s.id === args.series_id);
        if (!cast) return failure("That series is not in the shared library. Call series_cast_list.");
        const story = await readStory(session);
        if (!story) return failure("Create the next episode with story_film_create first, using the saved character ids.");
        const parsed = parseStoryFilm({ ...story, series: { id: cast.id, name: cast.name }, characters: cast.characters.map(c => ({ ...c, sheet: story.characters.find(old => old.id === c.id)?.sheet })) });
        if (!parsed.ok) return failure(parsed.errors.join("; "));
        await saveStory(session, parsed.story);
        return success(`Applied ${cast.name}. Assign each shot's dialogue or explicitly mark it silent before dubbing.`, data((await readStory(session))!));
    },
    async story_film_set_dialogue(args, { session }) {
        const story = await readStory(session);
        if (!story || !story.shots.some(s => s.id === args.shot_id)) return failure("Unknown story shot.");
        // Preserve a cached take only for unchanged speaker/text; timing edits do not require paying for it again.
        const parsed = parseStoryFilm({ ...story, shots: story.shots.map(shot => shot.id === args.shot_id ? { ...shot, dialogue: args.dialogue } : shot) });
        if (!parsed.ok) return failure(parsed.errors.join("; "));
        const shot = parsed.story.shots.find(s => s.id === args.shot_id)!;
        shot.dialogue = shot.dialogue?.map(line => {
            const old = story.shots.find(s => s.id === shot.id)?.dialogue?.find(l => l.id === line.id && l.characterId === line.characterId && l.text === line.text);
            return old ? { ...line, audio: old.audio, placedClipId: old.placedClipId } : line;
        });
        await saveStory(session, parsed.story);
        return success(shot.dialogue?.length ? "Dialogue and speaker timing saved." : "Shot marked silent. No voices will be generated.", data((await readStory(session))!));
    },
    async story_film_dub(args, context) {
        const { session, signal } = context;
        let story = await readStory(session);
        const shot = story?.shots.find(s => s.id === args.shot_id);
        if (!story || !shot) return failure("Unknown story shot.");
        if (shot.dialogue === undefined) return failure("This shot's speakers are unassigned. Use story_film_set_dialogue first; use [] only for deliberate silence.");
        if (!shot.dialogue.length) return success("This shot is silent. No audio was generated or charged.", { speech: speechContext(story, shot) });
        const voices = await session.voices?.();
        for (const line of shot.dialogue) {
            const voice = story.characters.find(c => c.id === line.characterId)?.voice;
            if (!voice || !voices?.some(v => v.id === voice.id && v.providerId === voice.providerId)) return failure(`The saved voice for ${line.characterId} is unavailable in the active provider/account. Restore it or explicitly choose another voice; nothing was generated.`);
        }
        const plans = shot.dialogue.map(line => { const input = speechInput(story!, line); return { line, input, key: lineKey(story!, line), estimate: 0 }; });
        let total = 0;
        for (const plan of plans.filter(p => p.line.audio?.key !== p.key)) {
            const price = await session.estimate?.({ capability: "audio.tts", input: plan.input, units: { characters: [...plan.line.text].length } });
            if (price?.kind !== "estimate" && price?.kind !== "free") return failure("The dialogue price could not be verified. Nothing was generated.");
            plan.estimate = price.kind === "free" ? 0 : displayedUsd(price.estimate.microUsd);
            total += plan.estimate;
        }
        if (args.estimate_only === true) return success(`Dialogue estimate: $${total.toFixed(6)}. Cached takes are free to reuse.`, { estimateUsd: total, speech: speechContext(story, shot) });
        if (total > 0 && (typeof args.accept_max_usd !== "number" || !Number.isFinite(args.accept_max_usd) || args.accept_max_usd < total - 1e-9)) return failure(`Dialogue needs accept_max_usd of at least ${total}. Nothing was generated.`, { estimateUsd: total });
        const results = [];
        for (const plan of plans) {
            if (signal.aborted) return failure("Dubbing stopped. Completed takes are saved; retry reuses them.", { results });
            let audio = plan.line.audio?.key === plan.key ? plan.line.audio : null;
            if (!audio) {
                const run = await session.execute({ type: "ai.run", capability: "audio.tts", input: { ...plan.input, expectedMaxUsd: plan.estimate } }, { signal });
                if (!run.ok) return failure(run.error ?? "Dialogue generation failed. Completed takes are saved.", { results });
                const output = run.output as { media?: Array<{ url?: string; durationSeconds?: number }>; costUsd?: number } | undefined;
                audio = assetOf({ ...output?.media?.[0], key: plan.key, costUsd: output?.costUsd, at: new Date().toISOString() });
                if (!audio) return failure("The provider returned no usable dialogue audio.", { results });
            }
            const current = await readStory(session);
            const currentShot = current?.shots.find(s => s.id === shot.id);
            const line = currentShot?.dialogue?.find(l => l.id === plan.line.id);
            if (!current || !line || lineKey(current, line) !== plan.key) return failure("Dialogue changed during generation. The new audio remains in the media library; review it before retrying.", { results });
            if (line.audio?.key !== audio.key) current.spentUsd = (current.spentUsd ?? 0) + (audio.costUsd ?? 0);
            line.audio = audio;
            await saveStory(session, current);
            story = current;
            let placement = "Saved in the media library";
            if (args.place_on_timeline !== false) {
                const snapshot = await session.snapshot();
                const sceneId = story.assembled?.sceneIds[story.assembled.shotIds?.indexOf(shot.id) ?? -1];
                const scene = snapshot.scenes.find(s => s.id === sceneId);
                if (!scene) placement = "Assemble the story, then run dubbing again to place the saved take";
                else if (!audio.durationSeconds || audio.durationSeconds > line.end - line.start + 0.05) placement = "Take needs timing review; it was not truncated or placed";
                else {
                    const span = sceneSpan(snapshot, scene);
                    if (line.start + audio.durationSeconds > span.duration + 0.05) placement = "Take exceeds the scene; review timing before placement";
                    else {
                        const input = { trackType: "audio" as const, startTime: span.start + line.start, endTime: span.start + line.start + audio.durationSeconds, mediaUrl: audio.url, sceneId, label: `${line.characterId}: ${line.text.slice(0, 60)}` };
                        const previous = snapshot.clips.find(c => c.id === line.placedClipId);
                        if (previous && (previous.locked || snapshot.tracks.some(t => t.type === previous.trackType && t.index === previous.trackIndex && t.locked) || previous.mediaUrl !== audio.url)) return failure("The placed dialogue was edited or locked. Review it before retrying.", { results });
                        const placed = previous ? await updateClip(session, previous, input) : await createPlacedClip(session, input);
                        if (placed.ok && typeof placed.data?.clipId === "string") {
                            const latest = await readStory(session);
                            const latestLine = latest?.shots.find(s => s.id === shot.id)?.dialogue?.find(l => l.id === line.id);
                            if (!latest || !latestLine || lineKey(latest, latestLine) !== plan.key || latestLine.start !== line.start || latestLine.end !== line.end) {
                                await session.execute({ type: "clip.delete", clipIds: [placed.data.clipId] });
                                return failure("Dialogue changed while placing audio. The take is saved; review the new plan before retrying.", { results });
                            }
                            latestLine.placedClipId = placed.data.clipId; await saveStory(session, latest); story = latest;
                        }
                        placement = placed.text;
                    }
                }
            }
            results.push({ lineId: line.id, characterId: line.characterId, audio, placement });
        }
        return success("Dialogue takes are saved with their character identities. Review the audio timing and generated mouth movements before export.", { results, speech: speechContext(story, story.shots.find(s => s.id === shot.id)!) });
    },
};
