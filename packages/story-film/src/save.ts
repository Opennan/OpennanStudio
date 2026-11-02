// Keep the audible timeline consistent when a saved line becomes silent or changes speaker/text/timing.
import type { CommandResult, ControllerSnapshot, EditorCommand } from "@opennan/timeline-core";
import type { StoryFilm } from "./types";
import { parseStoryFilm, readStoryJson, storyJson } from "./validate";

export async function persistStoryFilm(story: StoryFilm | null, host: {
    snapshot(): ControllerSnapshot | Promise<ControllerSnapshot>;
    execute(command: EditorCommand): Promise<CommandResult>;
}): Promise<void> {
    const snapshot = await host.snapshot();
    const previous = readStoryJson(snapshot.project?.storyFilmJson ?? null);
    const parsed = story ? parseStoryFilm(story) : null;
    if (parsed && !parsed.ok) throw new Error(parsed.errors.join("; "));
    const next = parsed?.ok ? parsed.story : null;
    const remove: string[] = [];
    for (const shot of previous?.shots ?? []) for (const line of shot.dialogue ?? []) {
        const newLine = next?.shots.find(s => s.id === shot.id)?.dialogue?.find(l => l.id === line.id);
        const voice = previous?.characters.find(c => c.id === line.characterId)?.voice;
        const newVoice = next?.characters.find(c => c.id === newLine?.characterId)?.voice;
        const sourceChanged = !newLine || line.characterId !== newLine.characterId || line.text !== newLine.text || JSON.stringify(voice) !== JSON.stringify(newVoice);
        if (newLine && sourceChanged) delete newLine.audio;
        const changed = sourceChanged || line.start !== newLine?.start || line.end !== newLine?.end;
        if (!changed) continue;
        if (!line.placedClipId) continue;
        const clip = snapshot.clips.find(c => c.id === line.placedClipId);
        if (clip) {
            if (clip.mediaUrl !== line.audio?.url || clip.locked || snapshot.tracks.some(t => t.type === clip.trackType && t.index === clip.trackIndex && t.locked)) throw new Error("A dialogue clip was changed or locked on the timeline. Review that clip before changing its speaker or marking the shot silent.");
            remove.push(clip.id);
        }
        if (newLine) delete newLine.placedClipId;
    }
    if (remove.length) {
        const deleted = await host.execute({ type: "clip.delete", clipIds: [...new Set(remove)] });
        if (!deleted.ok) throw new Error(deleted.error ?? "Previous dialogue could not be removed");
    }
    const result = await host.execute({ type: "project.update", patch: { storyFilmJson: next ? storyJson(next) : null } });
    if (!result.ok) throw new Error(result.error ?? "The story film could not be saved");
}
