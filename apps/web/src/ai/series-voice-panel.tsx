// Saved character references are private to this device; takes stay with their episode.
import { useEffect, useMemo, useState } from "react";
import { castForSeries, parseSeriesCast, parseStoryFilm, type SeriesCast, type StoryDialogue, type StoryFilm } from "@opennan/story-film";
import type { ProviderVoice } from "@opennan/provider-sdk";
import { useTimelineMessages } from "@opennan/timeline-react";
import { useStudioRuntime } from "../platform/runtime-context";
import type { StoryFilmSession } from "./story-film-host";
import { createSeriesLibrary } from "./series-library";

export function SeriesVoicePanel({ story, session, disabled }: { story: StoryFilm; session: StoryFilmSession; disabled: boolean }) {
    const t = useTimelineMessages("storyFilm");
    const { providers } = useStudioRuntime();
    const library = useMemo(() => createSeriesLibrary(), []);
    const [casts, setCasts] = useState<SeriesCast[]>([]);
    const [selected, setSelected] = useState("");
    const [seriesId, setSeriesId] = useState(story.series?.id ?? "");
    const [name, setName] = useState(story.series?.name ?? "");
    const [draft, setDraft] = useState(() => structuredClone(story));
    const [voices, setVoices] = useState<ProviderVoice[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    // Keep typing/focus intact if an agent changes the project. Saving detects the conflict instead of overwriting it.
    const [base, setBase] = useState(() => JSON.stringify(story));
    const dirty = JSON.stringify(draft) !== base;
    useEffect(() => {
        if (dirty) return;
        setDraft(structuredClone(story)); setBase(JSON.stringify(story));
    }, [story, dirty]);
    const perform = async (fn: () => Promise<void>) => {
        setBusy(true); setError(""); setStatus("");
        try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    const refresh = async () => {
        // Clear old account voices before attempting a new request; a failed refresh must not show stale clones.
        setVoices([]);
        const provider = providers.route("audio.tts");
        const found = await provider?.voices?.() ?? [];
        setVoices(found.map(v => ({ ...v, providerId: provider!.info.id })));
    };
    useEffect(() => { void perform(async () => { setCasts(library.list()); await refresh(); }); }, [library, providers]); // eslint-disable-line react-hooks/exhaustive-deps
    const edit = (next: StoryFilm) => { setDraft(next); setStatus(""); };
    const checked = () => {
        if (JSON.stringify(session.story()) !== base) throw new Error(t("voicesConflict"));
        const parsed = parseStoryFilm(draft);
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        return parsed.story;
    };
    const saved = () => { const next = session.story()!; setDraft(structuredClone(next)); setBase(JSON.stringify(next)); setStatus(t("voicesSaved")); };
    const save = () => perform(async () => { await session.save(checked()); saved(); });
    const saveSeries = () => perform(async () => {
        const next = checked();
        const cast = parseSeriesCast(castForSeries(next, seriesId, name));
        await session.save({ ...next, series: { id: cast.id, name: cast.name } });
        saved(); library.save(cast); setCasts(library.list()); setSelected(cast.id);
    });
    const apply = () => perform(async () => {
        const next = checked();
        const cast = library.list().find(c => c.id === selected);
        if (!cast) throw new Error(t("voicesChooseSeries"));
        const parsed = parseStoryFilm({ ...next, series: { id: cast.id, name: cast.name }, characters: cast.characters.map(c => ({ ...c, sheet: next.characters.find(old => old.id === c.id)?.sheet })) });
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        await session.save(parsed.story); setSeriesId(cast.id); setName(cast.name); saved();
    });
    const lines = (shotId: string, dialogue: StoryDialogue[] | undefined) => edit({ ...draft, shots: draft.shots.map(s => s.id === shotId ? { ...s, dialogue } : s) });
    const voiceKey = (v: { providerId?: string; id: string }) => `${v.providerId}:${v.id}`;
    const locked = busy || disabled;
    return <section className="story-film-body" data-testid="series-voices" onKeyDown={e => e.stopPropagation()}>
        <p className="muted story-film-intro">{t("voicesIntro")}</p>
        {error && <p className="story-film-error" role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <fieldset disabled={locked} className="series-voice-fields">
            <legend className="story-film-subhead">{t("voicesSeries")}</legend>
            <div className="story-film-fields">
                <label className="field"><span>{t("voicesSeriesId")}</span><input className="text-input" value={seriesId} maxLength={32} placeholder="rain-check" onChange={e => setSeriesId(e.target.value)} /></label>
                <label className="field"><span>{t("voicesSeriesName")}</span><input className="text-input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
            </div>
            <div className="story-film-actions"><button className="button small" type="button" onClick={() => void saveSeries()}>{t("voicesSaveSeries")}</button></div>
            <div className="story-film-fields">
                <label className="field"><span>{t("voicesSavedSeries")}</span><select className="text-input" value={selected} onChange={e => setSelected(e.target.value)}><option value="">{t("voicesChooseSeries")}</option>{casts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                <button className="button small" type="button" disabled={!selected} onClick={() => void apply()}>{t("voicesApply")}</button>
            </div>
            <p className="muted small">{t("voicesPrivate")}</p>
        </fieldset>
        <fieldset disabled={locked} className="series-voice-fields">
            <legend className="story-film-subhead">{t("voicesCast")}</legend>
            {draft.characters.map(c => <label className="field story-film-field" key={c.id}><span>{c.name} · {c.id}</span>
                <select aria-label={`${t("voicesVoice")} ${c.name}`} className="text-input" value={c.voice ? voiceKey(c.voice) : ""} onChange={e => {
                    const v = voices.find(v => voiceKey(v) === e.target.value);
                    edit({ ...draft, characters: draft.characters.map(old => old.id === c.id ? { ...old, voice: v ? { providerId: v.providerId!, id: v.id, ...(v.language ? { language: v.language } : {}), ...(v.model ? { model: v.model } : {}) } : null } : old) });
                }}>
                    <option value="">{t("voicesUnassigned")}</option>
                    {c.voice && !voices.some(v => voiceKey(v) === voiceKey(c.voice!)) && <option value={voiceKey(c.voice)}>{t("voicesUnavailable")} · {c.voice.id}</option>}
                    {voices.map(v => <option key={voiceKey(v)} value={voiceKey(v)}>{v.name}{v.kind === "clone" ? ` · ${t("voicesClone")}` : ""}{v.language ? ` (${v.language})` : ""}</option>)}
                </select>
            </label>)}
            <div className="story-film-actions"><button className="button ghost small" type="button" onClick={() => void perform(refresh)}>{t("voicesRefresh")}</button><a className="button ghost small" href="https://opennan.com/products/voice/clone" target="_blank" rel="noreferrer">{t("voicesCreateClone")}</a></div>
            <p className="muted small">{t("voicesAccount")}</p>
        </fieldset>
        <fieldset disabled={locked} className="series-voice-fields">
            <legend className="story-film-subhead">{t("voicesDialogue")}</legend>
            {draft.shots.map(shot => <div key={shot.id} className="series-shot" data-testid={`dialogue-${shot.id}`}>
                <h3>{shot.id} · {shot.seconds ?? 5}s</h3><p className="muted small">{shot.frame}</p>
                <label className="field"><span>{t("voicesSpeech")}</span><select className="text-input" value={shot.dialogue === undefined ? "unassigned" : shot.dialogue.length ? "dialogue" : "silent"} onChange={e => lines(shot.id, e.target.value === "unassigned" ? undefined : e.target.value === "silent" ? [] : [{ id: "line1", characterId: shot.cast[0] ?? draft.characters[0]!.id, text: "", start: 0, end: shot.seconds ?? 5 }])}>
                    <option value="unassigned">{t("voicesUnassigned")}</option><option value="silent">{t("voicesSilent")}</option><option value="dialogue">{t("voicesDialogue")}</option>
                </select></label>
                {shot.dialogue?.map((line, i) => {
                    const change = (patch: Partial<StoryDialogue>) => lines(shot.id, shot.dialogue!.map((old, n) => n === i ? { ...old, ...patch } : old));
                    return <div className="series-line" key={line.id}>
                        <div className="story-film-fields">
                            <label className="field"><span>{t("voicesSpeaker")}</span><select className="text-input" value={line.characterId} onChange={e => change({ characterId: e.target.value })}>{draft.characters.map(c => <option key={c.id} value={c.id}>{c.name}{shot.cast.includes(c.id) ? "" : ` · ${t("voicesOffscreen")}`}</option>)}</select></label>
                            <label className="field"><span>{t("voicesStart")}</span><input className="text-input" type="number" step="0.1" min="0" max={shot.seconds ?? 5} value={line.start} onChange={e => change({ start: Number(e.target.value) })} /></label>
                            <label className="field"><span>{t("voicesEnd")}</span><input className="text-input" type="number" step="0.1" min="0" max={shot.seconds ?? 5} value={line.end} onChange={e => change({ end: Number(e.target.value) })} /></label>
                        </div>
                        <label className="field"><span>{t("voicesLine")}</span><textarea className="text-input story-film-textarea" rows={3} maxLength={3000} value={line.text} onChange={e => change({ text: e.target.value })} /></label>
                        <button className="button ghost small" type="button" onClick={() => lines(shot.id, shot.dialogue!.filter((_, n) => n !== i))}>{t("voicesRemove")}</button>
                    </div>;
                })}
                {!!shot.dialogue?.length && <button className="button ghost small" type="button" disabled={shot.dialogue.length >= 24} onClick={() => { const start = shot.dialogue!.at(-1)!.end; lines(shot.id, [...shot.dialogue!, { id: `l-${crypto.randomUUID().slice(0, 8)}`, characterId: draft.characters[0]!.id, text: "", start, end: shot.seconds ?? 5 }]); }}>{t("voicesAdd")}</button>}
            </div>)}
        </fieldset>
        <p className="muted small">{t("voicesAgent")}</p>
        <div className="story-film-actions"><button className="button primary small" disabled={locked} type="button" onClick={() => void save()}>{busy ? t("voicesSaving") : t("voicesSave")}</button><button className="button ghost small" disabled={locked} type="button" onClick={() => { setDraft(structuredClone(story)); setBase(JSON.stringify(story)); setError(""); setStatus(""); }}>{t("voicesReload")}</button></div>
    </section>;
}
