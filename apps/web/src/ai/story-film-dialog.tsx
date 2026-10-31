// Story film (AI library → Story film): Story (write, or copy a video) → Cast (sheets) → Shots (keyframes) → Animate →
// Music → Timeline (the reel layout), in one window. The story is stored on the project and always editable; every paid
// button shows its price first ("≈ $x · Draw 2", never under what it settles at) and makes only what is missing; each
// item can be made again on its own, and a running step can be cancelled. Closing the window cancels what runs (what
// was made stays on the story). On Shots, the cast check (on by default) looks at each new keyframe beside its cast's
// sheets and redraws it once when a character is off; a shot still off says "Check this shot".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { formatUsdEstimate, type PriceAnswer, type ProviderModel } from "@opennan/provider-sdk";
import {
    LAYOUT_PRESETS,
} from "@opennan/timeline-core";
import {
    STORY_DEFAULTS, STORY_LIMITS, STORY_MEDIUMS, blankStory, copyDraftRequest, draftTextModel, isFlagged, isStale, mergeStory, parseStoryFilm, readStoryJson, sameVideoModel,
    shotSheetTimes, storyItems, videoModelChoices, withShotSources, withVideoModel, writeDraftRequest, type DraftRequest, type ItemUpdate, type ShotRange, type StepEstimate,
    type StepOptions, type StoryFilm, type StoryItem, type StoryMedium, type StoryStep,
} from "@opennan/story-film";
import { useEditorStore, useTimelineController, useTimelineMedia, useTimelineMessages } from "@opennan/timeline-react";
import { useAccount } from "../account/account-context";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import { AlertIcon, CheckIcon } from "../ui/icons";
import { accountHold } from "./hold-check";
import { LIBRARY_CHANGED_EVENT } from "./import-generated";
import { StoryFilmSession, type StoryFilmState } from "./story-film-host";
import { createStoryShots, type StoryShots } from "./story-shots";
import { createStorySheet } from "./story-sheet";
import "./story-film.css";

type T = (key: string, values?: Record<string, string | number>) => string;

const STEPS = ["story", "cast", "shots", "animate", "music", "timeline"] as const;
type WizardStep = (typeof STEPS)[number];
const STEP_KEYS: Record<WizardStep, string> = { story: "stepStory", cast: "stepCast", shots: "stepShots", animate: "stepAnimate", music: "stepMusic", timeline: "stepTimeline" };
const MEDIUM_KEYS: Record<StoryMedium, string> = { "2d": "medium2d", "3d": "medium3d", "stop-motion": "mediumStopMotion", anime: "mediumAnime" };
const PRICE_SETTLE_MS = 300;

/** "≈ $0.10", "Free", "Billed by <provider>", or null while it is not known. */
function priceText(t: T, answer: PriceAnswer | null | undefined): string | null {
    if (!answer) return null;
    if (answer.kind === "estimate") return answer.estimate.label;
    if (answer.kind === "free") return t("free");
    if (answer.kind === "billed-elsewhere") return t("billedBy", { by: answer.by });
    return null;
}

function useSessionState(session: StoryFilmSession): StoryFilmState {
    useSyncExternalStore(session.subscribe, session.version);
    return session.state();
}

/** The project's story film, re-read whenever it is stored. */
function useStory(): StoryFilm | null {
    const json = useEditorStore((s) => s.projectMeta?.storyFilmJson ?? null);
    return useMemo(() => readStoryJson(json), [json]);
}

/** A step's estimate for these options, asked again once the story stops changing (null while it loads). */
function useEstimate(session: StoryFilmSession, story: StoryFilm | null, step: StoryStep, options: StepOptions = {}): StepEstimate | null {
    const [estimate, setEstimate] = useState<StepEstimate | null>(null);
    const key = story ? JSON.stringify([step, options, story]) : null;
    useEffect(() => {
        setEstimate(null);
        if (!story) return;
        let live = true;
        const timer = window.setTimeout(() => void session.estimate(story, step, options).then((e) => live && setEstimate(e)), PRICE_SETTLE_MS);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, session]);
    return estimate;
}

export function StoryFilmDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
    const t = useTimelineMessages("storyFilm") as T;
    const controller = useTimelineController();
    const { providers, backend } = useStudioRuntime();
    const media = useTimelineMedia();
    const { account, requireOpenNan } = useAccount();
    const session = useMemo(() => new StoryFilmSession({
        controller, providers, requireOpenNan, account: accountHold(account),
        refreshAccount: () => void account.refresh(),
    }), [controller, providers, requireOpenNan, account]);
    useEffect(() => () => session.dispose(), [session]);
    const sheet = useMemo(() => createStorySheet({ backend, projectId, resolveMediaUrl: (url) => media.resolveMediaUrl(url) }), [backend, projectId, media]);
    const shots = useMemo(() => createStoryShots({ backend, projectId, resolveMediaUrl: (url) => media.resolveMediaUrl(url) }), [backend, projectId, media]);
    const story = useStory();
    const state = useSessionState(session);
    const [step, setStep] = useState<WizardStep>("story");
    const [castCheck, setCastCheck] = useState(true);
    const index = STEPS.indexOf(step);
    const close = () => {
        session.cancel();
        onClose();
    };
    return (
        <Dialog title={t("title")} onClose={close} className="story-film-dialog">
            <div className="story-film" data-testid="story-film-wizard">
                <div className="story-film-head">
                    <ol className="story-film-steps" aria-label={t("title")}>
                        {STEPS.map((id, i) => (
                            <li key={id} aria-current={id === step ? "step" : undefined} data-done={i < index || undefined}>
                                <button type="button" className="story-film-step" disabled={id !== "story" && !story} onClick={() => setStep(id)}>{t(STEP_KEYS[id])}</button>
                            </li>
                        ))}
                    </ol>
                    <span className="muted small">{t("stepOf", { n: index + 1, count: STEPS.length })}</span>
                </div>
                {state.running && (
                    <div className="story-film-banner" role="status" data-testid="story-film-running">
                        <span className="story-film-spinner" aria-hidden="true" /> <span>{state.running.label}</span>
                        <button type="button" className="button ghost small" onClick={() => session.cancel()}>{t("cancel")}</button>
                    </div>
                )}
                {state.error && (
                    <div className="story-film-error" role="alert">
                        <AlertIcon /> <span>{state.error}</span>
                        {state.error.startsWith("Not enough credits") && <button type="button" className="button ghost small" onClick={() => account.openConsole("billing")}>{t("buyCredits")}</button>}
                    </div>
                )}
                {step === "story" && <StoryStepView session={session} story={story} sheet={sheet} shots={shots} state={state} onNext={() => setStep("cast")} />}
                {story && step === "cast" && <ItemsStep session={session} story={story} state={state} step="cast" intro={t("castIntro")} />}
                {story && step === "shots" && (
                    <ItemsStep session={session} story={story} state={state} step="frames" intro={t("shotsIntro")} castCheck={castCheck} onCastCheck={setCastCheck} />
                )}
                {story && step === "animate" && <AnimateStep session={session} story={story} state={state} />}
                {story && step === "music" && <MusicStep session={session} story={story} state={state} />}
                {story && step === "timeline" && <TimelineStep session={session} story={story} state={state} />}
            </div>
            <div className="dialog-footer story-film-footer">
                <button type="button" className="button ghost" disabled={index === 0} onClick={() => setStep(STEPS[index - 1]!)}>{t("back")}</button>
                <span className="story-film-footer-gap" />
                <button type="button" className="button ghost" onClick={close}>{t("close")}</button>
                {index < STEPS.length - 1 && <button type="button" className="button" disabled={!story} onClick={() => setStep(STEPS[index + 1]!)}>{t("next")}</button>}
            </div>
        </Dialog>
    );
}

// ── Story ────────────────────────────────────────────────────────────────────

function StoryStepView({ session, story, sheet, shots, state, onNext }: {
    session: StoryFilmSession; story: StoryFilm | null; sheet: ReturnType<typeof createStorySheet>; shots: StoryShots; state: StoryFilmState; onNext(): void;
}) {
    const t = useTimelineMessages("storyFilm") as T;
    const [mode, setMode] = useState<"write" | "copy" | "edit">(story ? "edit" : "write");
    const [blank, setBlank] = useState<Record<string, unknown> | null>(null);
    useEffect(() => {
        if (story) setMode("edit");
    }, [story]);
    const file = useRef<HTMLInputElement>(null);
    const load = async (event: ChangeEvent<HTMLInputElement>) => {
        const chosen = event.target.files?.[0];
        event.target.value = "";
        if (!chosen) return;
        try {
            setBlank(JSON.parse(await chosen.text()) as Record<string, unknown>);
            setMode("edit");
        } catch {
            setBlank({ ...blankStory() });
            setMode("edit");
        }
    };
    return (
        <section className="story-film-body">
            <p className="muted story-film-intro">{t("storyIntro")}</p>
            <div className="story-film-modes" role="radiogroup" aria-label={t("stepStory")}>
                {(["write", "copy", "edit"] as const).map((id) => (
                    <button key={id} type="button" role="radio" aria-checked={mode === id} className="story-film-mode" disabled={id === "edit" && !story && !blank} onClick={() => setMode(id)}>
                        {t(id === "write" ? "startWrite" : id === "copy" ? "startCopy" : "startEdit")}
                    </button>
                ))}
            </div>
            {mode === "write" && <WriteForm session={session} state={state} onDrafted={() => setMode("edit")} />}
            {mode === "copy" && <CopyForm session={session} sheet={sheet} shots={shots} state={state} onDrafted={() => setMode("edit")} />}
            {state.draftErrors.length > 0 && (
                <div className="story-film-error" role="alert"><AlertIcon /> <span>{t("draftProblems")} {state.draftErrors.slice(0, 4).join("; ")}</span></div>
            )}
            {mode !== "edit" && (
                <div className="story-film-actions">
                    <button type="button" className="button ghost small" onClick={() => { setBlank(blankStory()); setMode("edit"); }}>{t("startBlank")}</button>
                    <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void load(e)} />
                    <button type="button" className="button ghost small" onClick={() => file.current?.click()}>{t("loadFile")}</button>
                </div>
            )}
            {mode === "edit" && (story || blank) && (
                <StoryEditor key={story ? "stored" : "blank"} session={session} story={story} initial={story ?? blank!} onSaved={onNext} />
            )}
        </section>
    );
}

function WriteForm({ session, state, onDrafted }: { session: StoryFilmSession; state: StoryFilmState; onDrafted(): void }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [text, setText] = useState("");
    const [style, setStyle] = useState("");
    const [medium, setMedium] = useState<StoryMedium>("2d");
    const [shots, setShots] = useState(12);
    const [models, setModels] = useState<ProviderModel[]>([]);
    useEffect(() => void session.models("text.generate").then(setModels), [session]);
    const request = useMemo((): DraftRequest | null => {
        if (!text.trim()) return null;
        const draft = writeDraftRequest({ text, shots, medium, ...(style.trim() ? { style } : {}) });
        const model = draftTextModel(models, false);
        return model ? { ...draft, input: { ...draft.input, model } as DraftRequest["input"] } : draft;
    }, [text, style, medium, shots, models]);
    const price = useDraftPrice(session, request);
    const available = session.available("text.generate");
    return (
        <>
            <label className="field story-film-field">
                <span>{t("writeLabel")}</span>
                <textarea className="text-input story-film-textarea story-film-script" rows={6} value={text} maxLength={20_000} placeholder={t("writePlaceholder")} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="story-film-text" />
            </label>
            <div className="story-film-fields">
                <label className="field story-film-field">
                    <span>{t("styleLabel")}</span>
                    <input className="text-input" value={style} maxLength={STORY_LIMITS.style} placeholder={t("stylePlaceholder")} onChange={(e) => setStyle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                </label>
            </div>
            <div className="story-film-fields">
                <MediumField value={medium} onChange={setMedium} />
                <label className="field story-film-field">
                    <span>{t("shotsLabel")}</span>
                    <select className="text-input" value={shots} onChange={(e) => setShots(Number(e.target.value))}>
                        {[6, 8, 10, 12, 14, 16].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                </label>
            </div>
            {!available && <p className="muted">{t("draftUnavailable")}</p>}
            <div className="story-film-actions">
                <button
                    type="button" className="button primary small" data-testid="story-film-draft" disabled={!available || !request || !price.ready || Boolean(state.running)}
                    onClick={() => request && void session.draft(request, { kind: "write" }, price.hold).then((ok) => ok && onDrafted())}
                >
                    {price.label ? t("draftRun", { price: price.label }) : t("pricing")}
                </button>
            </div>
        </>
    );
}

/** The price of a draft call: its label, whether it may run, and what it holds. */
function useDraftPrice(session: StoryFilmSession, request: DraftRequest | null): { label: string | null; ready: boolean; hold: number } {
    const t = useTimelineMessages("storyFilm") as T;
    const [answer, setAnswer] = useState<PriceAnswer | null>(null);
    const key = request ? JSON.stringify({ ...request.input, prompt: request.input.prompt.length }) : null;
    useEffect(() => {
        setAnswer(null);
        if (!request) return;
        let live = true;
        const timer = window.setTimeout(() => void session.priceDraft(request).then((a) => live && setAnswer(a)), PRICE_SETTLE_MS);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, session]);
    const label = priceText(t, answer);
    return { label, ready: label !== null, hold: answer?.kind === "estimate" ? Math.max(answer.estimate.holdUsd ?? 0, answer.estimate.usd) : 0 };
}

function MediumField({ value, onChange }: { value: StoryMedium; onChange(medium: StoryMedium): void }) {
    const t = useTimelineMessages("storyFilm") as T;
    return (
        <label className="field story-film-field">
            <span>{t("mediumLabel")}</span>
            <select className="text-input" value={value} onChange={(e) => onChange(e.target.value as StoryMedium)}>
                {STORY_MEDIUMS.map((m) => <option key={m} value={m}>{t(MEDIUM_KEYS[m])}</option>)}
            </select>
        </label>
    );
}

/** The video model a new story animates with (the first choice the provider lists), for the copy's "keep the original motion". */
function useDefaultVideoModel(session: StoryFilmSession): ProviderModel | null {
    const [model, setModel] = useState<ProviderModel | null>(null);
    useEffect(() => {
        let live = true;
        void session.models("video.image-to-video").then((list) => live && setModel(videoModelChoices(list)[0] ?? null));
        return () => {
            live = false;
        };
    }, [session]);
    return model;
}

/** The copy prompt's shot table priced at its longest (a story's most shots), so the price is never under the call sent. */
const WORST_SHOTS = Array.from({ length: STORY_LIMITS.shots }, (_, i) => ({ start: i * 15, end: i * 15 + 14.99, firstFrame: i + 1, lastFrame: i + 1 }));

function CopyForm({ session, sheet, shots, state, onDrafted }: { session: StoryFilmSession; sheet: ReturnType<typeof createStorySheet>; shots: StoryShots; state: StoryFilmState; onDrafted(): void }) {
    const t = useTimelineMessages("storyFilm") as T;
    const { backend } = useStudioRuntime();
    const projectId = useEditorStore((s) => s.projectMeta?.id ?? null);
    const [source, setSource] = useState<"media" | "file" | "link">("media");
    const [videos, setVideos] = useState<Array<{ url: string; name: string }>>([]);
    const [chosen, setChosen] = useState("");
    const [link, setLink] = useState("");
    const [cast, setCast] = useState<"original" | "keep">("original");
    const [notes, setNotes] = useState("");
    const [stage, setStage] = useState<string | null>(null);
    const [models, setModels] = useState<ProviderModel[]>([]);
    const [refresh, setRefresh] = useState(0);
    const videoModel = useDefaultVideoModel(session);
    const takesReferences = Boolean(videoModel?.referenceVideos);
    const [keepMotionChoice, setKeepMotion] = useState<boolean | null>(null);
    // On by default when the video model takes reference videos.
    const keepMotion = (keepMotionChoice ?? takesReferences) && takesReferences;
    const upload = useRef<HTMLInputElement>(null);
    useEffect(() => void session.models("text.generate").then(setModels), [session]);
    useEffect(() => {
        if (!projectId) return;
        let live = true;
        void backend.listLibrary(projectId).then((items) => {
            if (!live) return;
            const list = items.filter((m) => (m.mimeType ?? "").startsWith("video/")).map((m) => ({ url: m.url, name: m.name }));
            setVideos(list);
            setChosen((current) => current || list[0]?.url || "");
        }).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [backend, projectId, refresh]);
    // Priced as the call that will be sent: one contact sheet of the video's frames.
    const model = draftTextModel(models, true);
    const placeholder = useMemo(() => {
        const draft = copyDraftRequest({ sheet: "https://opennan.com/studio/quote-input.png", frames: STORY_LIMITS.shots, everySeconds: 4, durationSeconds: 600, cast, shots: WORST_SHOTS, ...(notes.trim() ? { notes } : {}) });
        return model ? { ...draft, input: { ...draft.input, model } as DraftRequest["input"] } : draft;
    }, [cast, notes, model]);
    const price = useDraftPrice(session, placeholder);
    const ready = source === "media" ? Boolean(chosen) : source === "link" ? /^https:\/\/\S+$/.test(link.trim()) : false;
    const run = () => {
        // What the copy found, for placing the draft's shots on the real ones once it is written.
        let found: { mediaUrl: string; shots: Array<ShotRange & { clip?: string }> } | null = null;
        const progress = (words: string) => {
            setStage(words);
            session.stage(words);
        };
        return session.draft(placeholder, { kind: "copy", cast, keepMotion, ...(source === "link" ? { link: link.trim() } : {}) }, price.hold, async (signal) => {
            let mediaUrl = chosen;
            if (source === "link") {
                progress(t("copyDownloading"));
                mediaUrl = await session.fetchLink(link.trim(), signal);
            }
            progress(t("copyFindingShots"));
            const cuts = await shots.find(mediaUrl, signal);
            if (!cuts || cuts.shots.length === 0) throw new Error(t("copyNoFrames"));
            let clips: string[] = [];
            if (keepMotion) clips = await shots.cut(mediaUrl, cuts.shots, signal, (i) => progress(t("copyCutting", { n: i + 1, count: cuts.shots.length })));
            found = { mediaUrl, shots: cuts.shots.map((shot, i) => ({ ...shot, ...(clips[i] ? { clip: clips[i] } : {}) })) };
            progress(t("copySampling"));
            const frames = shotSheetTimes(cuts.shots);
            const made = await sheet(mediaUrl, signal, frames);
            setStage(null);
            if (!made) throw new Error(t("copyNoFrames"));
            const table = cuts.shots.map((shot, i) => ({ ...shot, firstFrame: frames.findIndex((f) => f.shot === i) + 1, lastFrame: frames.map((f) => f.shot).lastIndexOf(i) + 1 }));
            const request = copyDraftRequest({
                sheet: { mediaUrl: made.url }, frames: made.frames, everySeconds: made.everySeconds, durationSeconds: made.durationSeconds, cast, shots: table, ...(notes.trim() ? { notes } : {}),
            });
            return model ? { ...request, input: { ...request.input, model } as DraftRequest["input"] } : request;
        }, (drafted) => {
            if (!found) return drafted;
            const placed = withShotSources({ ...drafted, source: { kind: "copy", cast, keepMotion, mediaUrl: found.mediaUrl, ...(source === "link" ? { link: link.trim() } : {}) } }, found.shots);
            return videoModel ? withVideoModel(placed, videoModel) : placed;
        }).finally(() => setStage(null)).then((ok) => ok && onDrafted());
    };
    const fromFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !projectId) return;
        const uploaded = await backend.uploadFile(projectId, file, "video");
        await backend.saveToLibrary(projectId, uploaded);
        window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { projectId } }));
        setChosen(uploaded.url);
        setSource("media");
        setRefresh((n) => n + 1);
    };
    return (
        <>
            <p className="muted story-film-intro">{t("copyIntro")}</p>
            <div className="story-film-fields" role="radiogroup" aria-label={t("copySource")}>
                {(["media", "file", "link"] as const).map((id) => (
                    <label key={id} className="story-film-check"><input type="radio" name="story-copy-source" checked={source === id} onChange={() => setSource(id)} /> {t(id === "media" ? "copyFromMedia" : id === "file" ? "copyUpload" : "copyLink")}</label>
                ))}
            </div>
            {source === "media" && (videos.length > 0 ? (
                <label className="field story-film-field">
                    <span>{t("copySource")}</span>
                    <select className="text-input" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                        {videos.map((v) => <option key={v.url} value={v.url}>{v.name}</option>)}
                    </select>
                </label>
            ) : <p className="muted">{t("copyNoVideos")}</p>)}
            {source === "file" && (
                <div className="story-film-actions">
                    <input ref={upload} type="file" accept="video/*" hidden onChange={(e) => void fromFile(e)} />
                    <button type="button" className="button ghost small" onClick={() => upload.current?.click()}>{t("copyUpload")}</button>
                </div>
            )}
            {source === "link" && (
                <label className="field story-film-field">
                    <span>{t("copyLink")}</span>
                    <input className="text-input" value={link} placeholder={t("copyLinkPlaceholder")} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="story-film-link" />
                </label>
            )}
            <fieldset className="story-film-fieldset">
                <legend className="muted">{t("copyCast")}</legend>
                <label className="story-film-check"><input type="radio" name="story-copy-cast" checked={cast === "original"} onChange={() => setCast("original")} /> {t("copyOriginal")}</label>
                <label className="story-film-check"><input type="radio" name="story-copy-cast" checked={cast === "keep"} onChange={() => setCast("keep")} /> {t("copyKeep")}</label>
            </fieldset>
            <fieldset className="story-film-fieldset">
                <label className="story-film-check">
                    <input type="checkbox" checked={keepMotion} disabled={!takesReferences} onChange={(e) => setKeepMotion(e.target.checked)} data-testid="story-film-keep-motion" /> {t("copyKeepMotion")}
                </label>
                <p className="muted small">{takesReferences || !videoModel ? t("copyKeepMotionHint") : t("copyKeepMotionUnavailable")}</p>
            </fieldset>
            <p className="muted small">{t("copyRights")}</p>
            <label className="field story-film-field">
                <span>{t("copyNotes")}</span>
                <input className="text-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            {!session.available("text.generate") && <p className="muted">{t("draftUnavailable")}</p>}
            {stage && <p className="muted" role="status">{stage}</p>}
            <div className="story-film-actions">
                <button type="button" className="button primary small" data-testid="story-film-copy" disabled={!ready || !price.ready || Boolean(state.running) || !session.available("text.generate")} onClick={() => void run()}>
                    {price.label ? t("copyRun", { price: price.label }) : t("pricing")}
                </button>
            </div>
        </>
    );
}

interface DraftCharacter { id: string; name: string; look: string }
interface DraftShot { id: string; cast: string[]; frame: string; motion: string; seconds: number }

function draftOf(value: Record<string, unknown> | StoryFilm) {
    const raw = value as Record<string, unknown>;
    const characters = (Array.isArray(raw.characters) ? raw.characters : []) as Array<Record<string, unknown>>;
    const shots = (Array.isArray(raw.shots) ? raw.shots : []) as Array<Record<string, unknown>>;
    return {
        title: String(raw.title ?? ""), style: String(raw.style ?? ""), medium: (STORY_MEDIUMS as readonly string[]).includes(String(raw.medium)) ? (raw.medium as StoryMedium) : "2d",
        music: typeof raw.music === "string" ? raw.music : "",
        characters: characters.map((c, i): DraftCharacter => ({ id: String(c.id ?? `c${i + 1}`), name: String(c.name ?? ""), look: String(c.look ?? "") })),
        shots: shots.map((s, i): DraftShot => ({
            id: String(s.id ?? `s${String(i + 1).padStart(2, "0")}`), cast: Array.isArray(s.cast) ? (s.cast as unknown[]).map(String) : [],
            frame: String(s.frame ?? ""), motion: String(s.motion ?? ""), seconds: typeof s.seconds === "number" ? s.seconds : 5,
        })),
    };
}

const nextId = (prefix: string, taken: string[]) => {
    for (let n = taken.length + 1; ; n += 1) {
        const id = `${prefix}${String(n).padStart(2, "0")}`;
        if (!taken.includes(id)) return id;
    }
};

function StoryEditor({ session, story, initial, onSaved }: { session: StoryFilmSession; story: StoryFilm | null; initial: Record<string, unknown> | StoryFilm; onSaved(): void }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [draft, setDraft] = useState(() => draftOf(initial));
    const [errors, setErrors] = useState<string[]>([]);
    const [saved, setSaved] = useState(false);
    useEffect(() => setDraft(draftOf(initial)), [initial]);
    const edit = (patch: Partial<typeof draft>) => {
        setDraft((d) => ({ ...d, ...patch }));
        setSaved(false);
    };
    const save = async () => {
        const parsed = parseStoryFilm({ version: 1, ...draft, ...(story?.source ? { source: story.source } : initial && "source" in initial ? { source: (initial as { source?: unknown }).source } : {}) });
        if (!parsed.ok) {
            setErrors(parsed.errors);
            return;
        }
        setErrors([]);
        await session.save(mergeStory(session.story(), parsed.story));
        setSaved(true);
    };
    const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
    return (
        <div className="story-film-editor" data-testid="story-film-editor">
            <label className="field story-film-field"><span>{t("edTitle")}</span><input className="text-input" value={draft.title} maxLength={STORY_LIMITS.title} onChange={(e) => edit({ title: e.target.value })} onKeyDown={stop} data-testid="story-film-title" /></label>
            <label className="field story-film-field"><span>{t("edStyle")}</span><textarea className="text-input story-film-textarea" rows={3} value={draft.style} maxLength={STORY_LIMITS.style} onChange={(e) => edit({ style: e.target.value })} onKeyDown={stop} /></label>
            <div className="story-film-fields">
                <MediumField value={draft.medium} onChange={(medium) => edit({ medium })} />
            </div>
            <h3 className="story-film-subhead">{t("edCharacters")}</h3>
            {draft.characters.map((c, i) => (
                <div key={i} className="story-film-card story-film-row">
                    <div className="story-film-fields">
                        <label className="field story-film-field"><span>{t("edName")}</span><input className="text-input" value={c.name} maxLength={STORY_LIMITS.name} onChange={(e) => edit({ characters: draft.characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} onKeyDown={stop} /></label>
                        <button type="button" className="button ghost small story-film-remove" onClick={() => edit({ characters: draft.characters.filter((_, j) => j !== i), shots: draft.shots.map((s) => ({ ...s, cast: s.cast.filter((id) => id !== c.id) })) })}>{t("edRemove")}</button>
                    </div>
                    <label className="field story-film-field"><span>{t("edLook")}</span><textarea className="text-input story-film-textarea" rows={2} value={c.look} maxLength={STORY_LIMITS.look} onChange={(e) => edit({ characters: draft.characters.map((x, j) => (j === i ? { ...x, look: e.target.value } : x)) })} onKeyDown={stop} /></label>
                </div>
            ))}
            {draft.characters.length < STORY_LIMITS.characters && (
                <div className="story-film-actions"><button type="button" className="button ghost small" onClick={() => edit({ characters: [...draft.characters, { id: nextId("c", draft.characters.map((c) => c.id)), name: "", look: "" }] })}>{t("edAddCharacter")}</button></div>
            )}
            <h3 className="story-film-subhead">{t("edShots")}</h3>
            {draft.shots.map((s, i) => (
                <div key={s.id} className="story-film-card story-film-row" data-testid="story-film-shot-edit">
                    <div className="story-film-card-head">
                        <span className="story-film-card-label">{t("shotLabel", { n: i + 1 })}</span>
                        <select className="text-input story-film-seconds" aria-label={t("edSeconds")} value={s.seconds} onChange={(e) => edit({ shots: draft.shots.map((x, j) => (j === i ? { ...x, seconds: Number(e.target.value) } : x)) })}>
                            {Array.from({ length: STORY_LIMITS.maxSeconds - STORY_LIMITS.minSeconds + 1 }, (_, k) => STORY_LIMITS.minSeconds + k).map((n) => <option key={n} value={n}>{n} s</option>)}
                        </select>
                        <button type="button" className="button ghost small" onClick={() => edit({ shots: draft.shots.filter((_, j) => j !== i) })}>{t("edRemove")}</button>
                    </div>
                    <div className="story-film-cast" role="group" aria-label={t("edCast")}>
                        {draft.characters.map((c) => (
                            <label key={c.id} className="story-film-check">
                                <input type="checkbox" checked={s.cast.includes(c.id)} onChange={(e) => edit({ shots: draft.shots.map((x, j) => (j === i ? { ...x, cast: e.target.checked ? [...x.cast, c.id] : x.cast.filter((id) => id !== c.id) } : x)) })} />
                                {c.name || c.id}
                            </label>
                        ))}
                    </div>
                    <label className="field story-film-field"><span>{t("edFrame")}</span><textarea className="text-input story-film-textarea" rows={2} value={s.frame} maxLength={STORY_LIMITS.frame} onChange={(e) => edit({ shots: draft.shots.map((x, j) => (j === i ? { ...x, frame: e.target.value } : x)) })} onKeyDown={stop} /></label>
                    <label className="field story-film-field"><span>{t("edMotion")}</span><textarea className="text-input story-film-textarea" rows={2} value={s.motion} maxLength={STORY_LIMITS.motion} onChange={(e) => edit({ shots: draft.shots.map((x, j) => (j === i ? { ...x, motion: e.target.value } : x)) })} onKeyDown={stop} /></label>
                </div>
            ))}
            {draft.shots.length < STORY_LIMITS.shots && (
                <div className="story-film-actions"><button type="button" className="button ghost small" onClick={() => edit({ shots: [...draft.shots, { id: nextId("s", draft.shots.map((s) => s.id)), cast: [], frame: "", motion: "", seconds: 5 }] })}>{t("edAddShot")}</button></div>
            )}
            <label className="field story-film-field"><span>{t("edMusic")}</span><textarea className="text-input story-film-textarea" rows={2} value={draft.music} maxLength={STORY_LIMITS.music} onChange={(e) => edit({ music: e.target.value })} onKeyDown={stop} /></label>
            {errors.length > 0 && <div className="story-film-error" role="alert"><AlertIcon /> <span>{t("edProblems")} {errors.slice(0, 6).join("; ")}</span></div>}
            <div className="story-film-actions">
                <button type="button" className="button primary small" data-testid="story-film-save" onClick={() => void save()}>{t("edSave")}</button>
                {saved && <span className="story-film-ok" role="status"><CheckIcon /> {t("edSaved")}</span>}
                {saved && <button type="button" className="button ghost small" onClick={onSaved}>{t("next")}</button>}
            </div>
        </div>
    );
}

// ── Cast and shots ───────────────────────────────────────────────────────────

function statusText(t: T, item: StoryItem, update: ItemUpdate | undefined): string {
    if (update?.status === "running") return update.progress !== undefined ? `${t("running")} ${Math.round(update.progress * 100)}%` : (update.message ?? t("running"));
    if (update?.status === "queued") return t("queued");
    if (update?.status === "failed" && !item.asset) return t("failed");
    if (update?.status === "cancelled" && !item.asset) return t("cancelled");
    if (!item.asset) return item.blocked ?? t("missing");
    return isStale(item) ? t("changed") : t("made");
}

function MediaView({ url, kind }: { url: string; kind: "image" | "video" | "audio" }) {
    const media = useTimelineMedia();
    const src = media.resolveMediaUrl(url);
    if (kind === "image") return <img className="story-film-media" src={src} alt="" />;
    if (kind === "video") return <video className="story-film-media" src={src} muted controls preload="metadata" />;
    return <audio src={src} controls preload="metadata" />;
}

/** A redo's price for one item. */
function RedoButton({ session, story, step, item, state, label, extra }: {
    session: StoryFilmSession; story: StoryFilm; step: StoryStep; item: StoryItem; state: StoryFilmState; label: string; extra?: StepOptions;
}) {
    const t = useTimelineMessages("storyFilm") as T;
    const castCheck = extra?.castCheck;
    const options = useMemo(() => ({ only: [item.id], redo: Boolean(item.asset), ...(castCheck !== undefined ? { castCheck } : {}) }), [item.id, item.asset, castCheck]);
    const estimate = useEstimate(session, story, step, options);
    const price = estimate?.ready ? estimate.label : null;
    return (
        <button
            type="button" className="button ghost small" data-testid={`story-film-redo-${item.id}`} disabled={Boolean(state.running) || !price}
            onClick={() => void session.run(step, `${label}: ${item.label}`, options)}
        >
            {price ? t(item.asset ? "redoOne" : "runOne", { price }) : estimate && !estimate.ready ? (estimate.items[0]?.blocked ?? t("notPriced")) : t("pricing")}
        </button>
    );
}

function RunAll({ session, story, step, state, verb, options = {} }: { session: StoryFilmSession; story: StoryFilm; step: StoryStep; state: StoryFilmState; verb: string; options?: StepOptions }) {
    const t = useTimelineMessages("storyFilm") as T;
    const estimate = useEstimate(session, story, step, options);
    const count = estimate?.items.length ?? 0;
    const nothing = estimate !== null && estimate.reason?.startsWith("Nothing to make");
    return (
        <div className="story-film-actions">
            <button
                type="button" className="button primary small" data-testid={`story-film-run-${step}`} disabled={Boolean(state.running) || !estimate?.ready}
                onClick={() => void session.run(step, verb, options)}
            >
                {estimate?.ready ? t("runAll", { price: estimate.label, verb, count }) : nothing ? t("nothingToMake") : estimate ? (estimate.reason ?? t("notPriced")) : t("pricing")}
            </button>
            <span className="muted small">{session.providerName(step === "animate" ? "video.image-to-video" : step === "music" ? "audio.music" : "image.generate") === "OpenNan" ? t("chargedNote") : ""}</span>
        </div>
    );
}

function ItemsStep({ session, story, state, step, intro, castCheck, onCastCheck }: {
    session: StoryFilmSession; story: StoryFilm; state: StoryFilmState; step: "cast" | "frames"; intro: string; castCheck?: boolean; onCastCheck?(on: boolean): void;
}) {
    const t = useTimelineMessages("storyFilm") as T;
    const items = storyItems(story, step);
    const verb = t(step === "cast" ? "verbDraw" : "verbDrawKeyframes");
    // Frames: the cast check's redraws (1, or 0 when it is off), the same for "Draw all" and each redo.
    const options = useMemo<StepOptions>(() => (step === "frames" ? { castCheck: castCheck === false ? 0 : 1 } : {}), [step, castCheck]);
    return (
        <section className="story-film-body">
            <p className="muted story-film-intro">{intro}</p>
            {step === "frames" && onCastCheck && <CastCheckField session={session} story={story} on={castCheck !== false} onChange={onCastCheck} disabled={Boolean(state.running)} />}
            <RunAll session={session} story={story} step={step} state={state} verb={verb} options={options} />
            <ul className="story-film-grid">
                {items.map((item, i) => {
                    const update = state.items[item.id];
                    const shot = step === "frames" ? story.shots[i] : null;
                    const flagged = shot ? isFlagged(shot) : false;
                    return (
                        <li
                            key={item.id} className="story-film-card story-film-item" data-testid={`story-film-item-${item.id}`} data-state={update?.status ?? (item.asset ? "done" : "missing")}
                            data-flagged={flagged || undefined}
                        >
                            <div className="story-film-frame">{item.asset ? <MediaView url={item.asset.url} kind="image" /> : <span className="muted small">{statusText(t, item, update)}</span>}</div>
                            <div className="story-film-card-head">
                                <span className="story-film-card-label">{item.label}</span>
                                <span className="story-film-card-state">{shot && update?.status !== "running" && update?.status !== "queued" ? checkedText(t, shot, item, update) : statusText(t, item, update)}</span>
                            </div>
                            {update?.status === "failed" && update.error && <p className="story-film-error"><AlertIcon /> {update.error}</p>}
                            {shot && flagged && <CheckFlag story={story} shot={shot} />}
                            {shot && <ShotText session={session} story={story} shotId={shot.id} />}
                            <div className="story-film-actions"><RedoButton session={session} story={story} step={step} item={item} state={state} label={verb} extra={options} /></div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/** "Check characters match (+~$0.004 per shot)": the dearest single look, on by default. */
function CastCheckField({ session, story, on, onChange, disabled }: { session: StoryFilmSession; story: StoryFilm; on: boolean; onChange(on: boolean): void; disabled: boolean }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [price, setPrice] = useState<PriceAnswer | null>(null);
    const key = JSON.stringify([story.characters, story.shots.map((s) => s.cast)]);
    useEffect(() => {
        let live = true;
        const timer = window.setTimeout(() => void session.castCheckPrice(story).then((answer) => live && setPrice(answer)), PRICE_SETTLE_MS);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, session]);
    const label = priceText(t, price);
    return (
        <div className="story-film-castcheck">
            <label className="story-film-check">
                <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid="story-film-cast-check" />
                {label ? t("castCheck", { price: price?.kind === "estimate" ? `+${label.replace("≈ ", "~")}` : label }) : t("castCheckPlain")}
            </label>
            <p className="muted small">{t("castCheckHint")}</p>
        </div>
    );
}

/** A made keyframe's state with its cast check: "Characters match", "Check this shot", else the usual words. */
function checkedText(t: T, shot: StoryFilm["shots"][number], item: StoryItem, update: ItemUpdate | undefined): string {
    if (!item.asset || isStale(item) || !shot.check || shot.check.keyframeUrl !== item.asset.url) return statusText(t, item, update);
    return shot.check.ok ? t("castMatches") : t("checkThisShot");
}

/** Why a shot is flagged: each character off their sheet and what differs, or that nobody could tell. */
function CheckFlag({ story, shot }: { story: StoryFilm; shot: StoryFilm["shots"][number] }) {
    const t = useTimelineMessages("storyFilm") as T;
    const check = shot.check!;
    const name = (id: string) => story.characters.find((c) => c.id === id)?.name ?? id;
    const why = check.unread ? t("checkUnread") : check.misses.map((m) => (m.reason ? t("checkMiss", { name: name(m.id), reason: m.reason }) : name(m.id))).join("; ");
    return <p className="story-film-flag" role="note" data-testid={`story-film-flag-${shot.id}`}><AlertIcon /> <span><strong>{t("checkThisShot")}.</strong> {why}</span></p>;
}

/** A shot's still and motion text, edited in place (saved when it loses focus). */
function ShotText({ session, story, shotId }: { session: StoryFilmSession; story: StoryFilm; shotId: string }) {
    const t = useTimelineMessages("storyFilm") as T;
    const shot = story.shots.find((s) => s.id === shotId)!;
    const [frame, setFrame] = useState(shot.frame);
    const [motion, setMotion] = useState(shot.motion);
    useEffect(() => {
        setFrame(shot.frame);
        setMotion(shot.motion);
    }, [shot.frame, shot.motion]);
    const commit = () => {
        if (frame.trim() === shot.frame && motion.trim() === shot.motion) return;
        if (!frame.trim() || !motion.trim()) return;
        const current = session.story() ?? story;
        void session.save({ ...current, shots: current.shots.map((s) => (s.id === shotId ? { ...s, frame: frame.trim(), motion: motion.trim() } : s)) });
    };
    return (
        <>
            <label className="field story-film-field"><span>{t("edFrame")}</span><textarea className="text-input story-film-textarea" rows={2} value={frame} maxLength={STORY_LIMITS.frame} onChange={(e) => setFrame(e.target.value)} onBlur={commit} onKeyDown={(e) => e.stopPropagation()} /></label>
            <label className="field story-film-field"><span>{t("edMotion")}</span><textarea className="text-input story-film-textarea" rows={2} value={motion} maxLength={STORY_LIMITS.motion} onChange={(e) => setMotion(e.target.value)} onBlur={commit} onKeyDown={(e) => e.stopPropagation()} /></label>
        </>
    );
}

// ── Animate, music, timeline ─────────────────────────────────────────────────

function AnimateStep({ session, story, state }: { session: StoryFilmSession; story: StoryFilm; state: StoryFilmState }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [models, setModels] = useState<ProviderModel[]>([]);
    useEffect(() => void session.models("video.image-to-video").then((list) => setModels(videoModelChoices(list))), [session]);
    const model = story.settings?.videoModel ?? STORY_DEFAULTS.videoModel;
    const chosen = models.find((m) => m.id === model);
    const qualities = chosen?.qualities?.length ? chosen.qualities : [STORY_DEFAULTS.quality];
    const quality = story.settings?.quality && qualities.includes(story.settings.quality) ? story.settings.quality : qualities.includes(STORY_DEFAULTS.quality) ? STORY_DEFAULTS.quality : qualities[0]!;
    // A listed model that is not the stored one (the default is not sold here): the first choice. The stored model's
    // facts (its lengths, its reference video limits) follow its listing.
    useEffect(() => {
        if (models.length === 0) return;
        const current = session.story() ?? story;
        if (!chosen) void session.save(withVideoModel(current, models[0]!));
        else if (!sameVideoModel(current, chosen)) void session.save(withVideoModel(current, chosen));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [models, chosen]);
    const setting = (patch: { videoModel?: string; quality?: string }) => {
        const current = session.story() ?? story;
        const next = models.find((m) => m.id === (patch.videoModel ?? model)) ?? { id: patch.videoModel ?? model };
        void session.save(withVideoModel(current, next, patch.quality ?? quality));
    };
    const copied = story.source?.kind === "copy" && story.shots.some((s) => s.source);
    const keepMotion = story.source?.kind === "copy" && story.source.keepMotion === true;
    const setKeepMotion = (on: boolean) => {
        const current = session.story() ?? story;
        if (current.source?.kind === "copy") void session.save({ ...current, source: { ...current.source, keepMotion: on } });
    };
    const items = storyItems(story, "animate");
    const remaking = items.some((i) => i.remake);
    const verb = t("verbAnimate");
    return (
        <section className="story-film-body">
            <p className="muted story-film-intro" data-testid="story-film-animate-intro">{t(remaking ? "animateRemakeIntro" : "animateIntro")}</p>
            {copied && (
                <div className="story-film-castcheck">
                    <label className="story-film-check">
                        <input type="checkbox" checked={keepMotion} disabled={Boolean(state.running)} onChange={(e) => setKeepMotion(e.target.checked)} data-testid="story-film-animate-keep-motion" /> {t("animateKeepMotion")}
                    </label>
                    {keepMotion && chosen && !chosen.referenceVideos && <p className="muted small">{t("animateNoReference", { model: chosen.label })}</p>}
                </div>
            )}
            <div className="story-film-fields">
                <label className="field story-film-field">
                    <span>{t("videoModel")}</span>
                    <select className="text-input" value={model} data-testid="story-film-model" onChange={(e) => setting({ videoModel: e.target.value })}>
                        {(models.length > 0 ? models : [{ id: model, label: model }]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                </label>
                <label className="field story-film-field">
                    <span>{t("videoQuality")}</span>
                    <select className="text-input" value={quality} onChange={(e) => setting({ quality: e.target.value })}>
                        {qualities.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                </label>
            </div>
            <RunAll session={session} story={story} step="animate" state={state} verb={verb} />
            <ul className="story-film-grid">
                {items.map((item) => {
                    const update = state.items[item.id];
                    const real = item.remake ? story.shots.find((s) => s.id === item.id)?.source : undefined;
                    return (
                        <li
                            key={item.id} className="story-film-card story-film-item" data-testid={`story-film-clip-${item.id}`} data-state={update?.status ?? (item.asset ? "done" : "missing")}
                            data-remake={item.remake || undefined}
                        >
                            <div className="story-film-frame">
                                {item.asset ? <MediaView url={item.asset.url} kind="video" /> : story.shots.find((s) => s.id === item.id)?.keyframe ? <MediaView url={story.shots.find((s) => s.id === item.id)!.keyframe!.url} kind="image" /> : null}
                            </div>
                            <div className="story-film-card-head"><span className="story-film-card-label">{item.label}</span><span className="story-film-card-state">{statusText(t, item, update)}</span></div>
                            {real && (
                                // The original shot this clip remakes: watch it beside the result (and before paying).
                                <div className="story-film-original" data-testid={`story-film-original-${item.id}`}>
                                    <span className="muted small">{t("originalShot", { seconds: Math.round((real.end - real.start) * 10) / 10 })}</span>
                                    <MediaView url={real.clip ?? `${story.source?.kind === "copy" ? story.source.mediaUrl ?? "" : ""}#t=${real.start},${real.end}`} kind="video" />
                                </div>
                            )}
                            {item.blocked && !item.asset && update?.status !== "running" && <p className="muted small">{item.blocked}</p>}
                            {update?.status === "running" && <div className="story-film-progress"><span style={{ width: `${Math.round((update.progress ?? 0.05) * 100)}%` }} /></div>}
                            {update?.status === "failed" && update.error && <p className="story-film-error"><AlertIcon /> {update.error}</p>}
                            <div className="story-film-actions"><RedoButton session={session} story={story} step="animate" item={item} state={state} label={verb} /></div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

function MusicStep({ session, story, state }: { session: StoryFilmSession; story: StoryFilm; state: StoryFilmState }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [text, setText] = useState(story.music);
    useEffect(() => setText(story.music), [story.music]);
    const item = storyItems(story, "music")[0]!;
    const commit = () => {
        if (text.trim() !== story.music) void session.save({ ...(session.story() ?? story), music: text.trim() });
    };
    return (
        <section className="story-film-body">
            <p className="muted story-film-intro">{t("musicIntro")}</p>
            <label className="field story-film-field"><span>{t("edMusic")}</span><textarea className="text-input story-film-textarea" rows={3} value={text} maxLength={STORY_LIMITS.music} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.stopPropagation()} /></label>
            {story.musicAsset && <div className="story-film-card story-film-music"><MediaView url={story.musicAsset.url} kind="audio" /><span className="story-film-card-state">{statusText(t, item, state.items.music)}</span></div>}
            <div className="story-film-actions"><RedoButton session={session} story={story} step="music" item={item} state={state} label={t("verbMusic")} /></div>
        </section>
    );
}

function TimelineStep({ session, story, state }: { session: StoryFilmSession; story: StoryFilm; state: StoryFilmState }) {
    const t = useTimelineMessages("storyFilm") as T;
    const [done, setDone] = useState(false);
    const missing = story.shots.filter((s) => !s.clip).length;
    const preset = LAYOUT_PRESETS[0]!;
    return (
        <section className="story-film-body">
            <p className="muted story-film-intro">{t("timelineIntro")}</p>
            <fieldset className="story-film-fieldset">
                <legend className="muted">{t("layoutLabel")}</legend>
                <label className="story-film-check"><input type="radio" name="story-layout" checked readOnly /> {t(preset.nameKey)}</label>
            </fieldset>
            <p className="muted">{t("spent", { usd: formatUsdEstimate(Math.round((story.spentUsd ?? 0) * 1_000_000)).replace("≈ ", "") })}</p>
            {missing > 0 && <p className="muted">{t("needsAll")}</p>}
            <div className="story-film-actions">
                <button type="button" className="button primary small" data-testid="story-film-assemble" disabled={missing > 0 || Boolean(state.running)} onClick={() => void session.assemble().then(setDone)}>
                    {story.assembled ? t("assembleAgain") : t("assemble")}
                </button>
                {done && <span className="story-film-ok" role="status"><CheckIcon /> {t("assembled")}</span>}
            </div>
        </section>
    );
}
