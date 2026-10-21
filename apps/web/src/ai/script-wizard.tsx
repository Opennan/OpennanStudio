// Script to video (AI tab → Script to video): Script → Plan → Storyboards → Videos → Review. A plain script is cut
// into subtitles (one per sentence) or an SRT file is read as it is; both are stored on the project (PATCH, stored
// only). The plan, the storyboards and the videos are the paid project pipelines, each quoted before it runs (per
// scene and in total), each result arriving on the timeline through sync as one undo step. Every step can be skipped
// and the wizard resumes from the project's state (its stored script, its scenes' panels and videos).
import { useEffect, useMemo, useRef, useState } from "react";
import {
    cutScript, formatUsdUp, parseSrt, pipelineRequest, projectVideoModels, toSrt, videoQualities, type Cue, type CueResult, type Quote,
} from "@opennan/director-client";
import { selectLiveScenes } from "@opennan/timeline-core";
import { useEditorStore, useTimelineMessages } from "@opennan/timeline-react";
import type { DirectorError, DirectorHost, ProjectScript } from "./director-host";
import { directorErrorText, type DirectorT } from "./director-copy";
import { AlertIcon, CheckIcon, TaskLine } from "./director-panel";
import { StoryboardBoard, orderedScenes } from "./storyboard-board";
import { useDirectorState } from "./use-director";

const STEPS = ["script", "plan", "storyboards", "videos", "review"] as const;
type Step = (typeof STEPS)[number];
const STEP_KEYS: Record<Step, string> = { script: "stepScript", plan: "stepPlan", storyboards: "stepStoryboards", videos: "stepVideos", review: "stepReview" };

type Priced = { quote: Quote } | { error: DirectorError } | "loading" | null;

export function ScriptWizard({ host }: { host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const [step, setStep] = useState<Step>("script");
    const [srtSaved, setSrtSaved] = useState(false);
    const index = STEPS.indexOf(step);
    return (
        <div className="director-wizard" data-testid="script-wizard">
            <header className="director-head">
                <h2 className="director-title">{t("wizardTitle")}</h2>
                <span className="muted">{t("stepOf", { n: index + 1, count: STEPS.length })}</span>
            </header>
            <ol className="director-steps" aria-label={t("wizardTitle")}>
                {STEPS.map((id, i) => (
                    <li key={id} aria-current={id === step ? "step" : undefined} data-done={i < index || undefined}>
                        <button type="button" className="director-step" onClick={() => setStep(id)}>{t(STEP_KEYS[id])}</button>
                    </li>
                ))}
            </ol>
            {step === "script" && <ScriptStep host={host} onSaved={(hasSrt) => setSrtSaved(hasSrt)} />}
            {step === "plan" && <PlanStep host={host} hasSrt={srtSaved} />}
            {step === "storyboards" && <><p className="muted director-intro">{t("storyboardsIntro")}</p><StoryboardBoard host={host} /></>}
            {step === "videos" && <VideosStep host={host} />}
            {step === "review" && <ReviewStep />}
            <div className="director-wizard-nav">
                <button type="button" className="button ghost small" disabled={index === 0} onClick={() => setStep(STEPS[index - 1]!)}>{t("back")}</button>
                {index < STEPS.length - 1
                    ? <button type="button" className="button ghost small" onClick={() => setStep(STEPS[index + 1]!)}>{step === "script" || step === "plan" ? t("skip") : t("next")}</button>
                    : <button type="button" className="button primary small" onClick={() => setStep("script")}>{t("finish")}</button>}
            </div>
        </div>
    );
}

function ScriptStep({ host, onSaved }: { host: DirectorHost; onSaved(hasSrt: boolean): void }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const [text, setText] = useState("");
    const [srt, setSrt] = useState<{ name: string; text: string; result: CueResult } | null>(null);
    const [read, setRead] = useState<ProjectScript | null>(null);
    const [conflict, setConflict] = useState<ProjectScript | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<"saved" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const file = useRef<HTMLInputElement>(null);
    useEffect(() => {
        let live = true;
        host.readScript().then((script) => {
            if (!live) return;
            setRead(script);
            if (script.scriptText) setText(script.scriptText);
            else if (script.srtContent) setSrt({ name: "subtitles.srt", text: script.srtContent, result: parseSrt(script.srtContent) });
            onSaved(Boolean(script.srtContent));
        }, () => undefined);
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [host]);
    const cut = useMemo<CueResult>(() => (srt ? srt.result : text.trim() ? cutScript(text) : { cues: [] }), [srt, text]);
    const seconds = cut.cues.length ? Math.round(cut.cues.at(-1)!.end) : 0;
    const load = (script: ProjectScript) => {
        setRead(script);
        setSrt(null);
        setText(script.scriptText ?? "");
        if (!script.scriptText && script.srtContent) setSrt({ name: "subtitles.srt", text: script.srtContent, result: parseSrt(script.srtContent) });
    };
    const save = async (base: ProjectScript | null = read) => {
        if (cut.error || cut.cues.length === 0) return;
        setSaving(true);
        setError(null);
        setConflict(null);
        try {
            const outcome = await host.saveScript(srt ? { scriptText: null, srtContent: srt.text } : { scriptText: text, srtContent: toSrt(cut.cues) }, base);
            if (!outcome.saved) {
                setConflict(outcome.conflict);
                return;
            }
            setSaved("saved");
            onSaved(true);
            const fresh = await host.readScript().catch(() => null);
            if (fresh) setRead(fresh);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setSaving(false);
        }
    };
    return (
        <section className="director-step-body">
            <p className="muted director-intro">{t("scriptIntro")}</p>
            {srt ? (
                <div className="director-card">
                    <div className="director-card-head"><CheckIcon /><span className="director-card-label">{srt.name}</span>
                        <button type="button" className="button ghost small" onClick={() => setSrt(null)}>{t("close")}</button></div>
                </div>
            ) : (
                <label className="director-field">
                    <span>{t("scriptLabel")}</span>
                    <textarea className="input director-script" rows={8} value={text} placeholder={t("scriptPlaceholder")} onChange={(e) => { setText(e.target.value); setSaved(null); }} onKeyDown={(e) => e.stopPropagation()} />
                </label>
            )}
            <div className="director-card-actions">
                <input ref={file} type="file" accept=".srt,application/x-subrip,text/plain" hidden onChange={async (event) => {
                    const chosen = event.target.files?.[0];
                    event.target.value = "";
                    if (!chosen) return;
                    const content = await chosen.text();
                    setSrt({ name: chosen.name, text: content, result: parseSrt(content) });
                    setSaved(null);
                }} />
                <button type="button" className="button ghost small" onClick={() => file.current?.click()}>{t("scriptLoadSrt")}</button>
                <span className="muted" data-testid="script-cues">{cut.cues.length ? t("scriptCues", { count: cut.cues.length, seconds }) : ""}</span>
            </div>
            {cut.error && <p className="director-error" role="alert"><AlertIcon /> {cut.error}</p>}
            {cut.cues.length > 0 && <CuePreview cues={cut.cues} />}
            <div className="director-card-actions">
                <button type="button" className="button primary small" disabled={saving || Boolean(cut.error) || cut.cues.length === 0} onClick={() => void save()}>{saving ? t("scriptSaving") : t("scriptSave")}</button>
                {saved && <span className="director-ok" role="status"><CheckIcon /> {t("scriptSaved")}</span>}
            </div>
            {conflict && (
                <div className="director-banner" role="alert" data-testid="script-conflict">
                    <AlertIcon /> <span>{t("scriptConflict")}</span>
                    <button type="button" className="button ghost small" onClick={() => { load(conflict); setConflict(null); }}>{t("scriptUseTheirs")}</button>
                    <button type="button" className="button ghost small" onClick={() => void save(conflict)}>{t("scriptKeepMine")}</button>
                </div>
            )}
            {error && <p className="director-error" role="alert"><AlertIcon /> {t("errServer")}</p>}
        </section>
    );
}

function CuePreview({ cues }: { cues: Cue[] }) {
    const shown = cues.slice(0, 6);
    const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return (
        <ol className="director-cues">
            {shown.map((cue, i) => <li key={i}><span className="muted">{stamp(cue.start)}</span> {cue.text}</li>)}
            {cues.length > shown.length && <li className="muted">…</li>}
        </ol>
    );
}

function PlanStep({ host, hasSrt }: { host: DirectorHost; hasSrt: boolean }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const [fields, setFields] = useState({ style: "", concept: "", direction: "" });
    const [price, setPrice] = useState<Priced>(null);
    const state = useDirectorState(host);
    const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    const request = pipelineRequest("story-scenes", host.serverId, { body });
    const bodyKey = JSON.stringify(body);
    useEffect(() => {
        if (!hasSrt) return;
        let live = true;
        setPrice("loading");
        const timer = setTimeout(() => void host.priceStep(request).then((answer) => live && setPrice(answer)), 300);
        return () => {
            live = false;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bodyKey, hasSrt, host]);
    const task = [...state.tasks].reverse().find((task) => task.label === t("stepPlan"));
    const running = task && (task.status === "starting" || task.status === "queued" || task.status === "running");
    return (
        <section className="director-step-body">
            <p className="muted director-intro">{t("planIntro")}</p>
            {(["style", "concept", "direction"] as const).map((key) => (
                <label key={key} className="director-field">
                    <span>{t(key === "style" ? "planStyle" : key === "concept" ? "planConcept" : "planDirection")}</span>
                    <input className="input" value={fields[key]} maxLength={2_000} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                </label>
            ))}
            {!hasSrt && <p className="director-error"><AlertIcon /> {t("planNeedsScript")}</p>}
            {price && price !== "loading" && "error" in price && <p className="director-error" role="alert"><AlertIcon /> {directorErrorText(t, price.error)}</p>}
            <div className="director-card-actions">
                <button
                    type="button" className="button primary small" disabled={!hasSrt || !price || price === "loading" || "error" in price || Boolean(running)}
                    onClick={() => price && price !== "loading" && "quote" in price && void host.runStep(request, t("stepPlan"), price.quote).then((outcome) => {
                        if (outcome.quote) setPrice({ quote: outcome.quote });
                    })}
                >
                    {price && price !== "loading" && "quote" in price ? t("planRun", { usd: formatUsdUp(price.quote.holdUsd) }) : t("boardPricing")}
                </button>
            </div>
            {task && <TaskLine host={host} task={task} onRetry={task.status === "failed" && price && price !== "loading" && "quote" in price ? () => void host.runStep(request, t("stepPlan"), price.quote) : undefined} />}
        </section>
    );
}

function VideosStep({ host }: { host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const live = useEditorStore(selectLiveScenes);
    const scenes = useMemo(() => orderedScenes(live), [live]);
    const state = useDirectorState(host);
    const models = projectVideoModels("smart-scene-video");
    const [model, setModel] = useState("auto");
    const qualities = videoQualities(model);
    const [quality, setQuality] = useState("720p");
    const [audio, setAudio] = useState(false);
    const effectiveQuality = qualities.includes(quality) ? quality : qualities[0]!;
    const busy = new Set(state.tasks.filter((task) => task.sceneId && (task.status === "starting" || task.status === "queued" || task.status === "running")).map((task) => task.sceneId!));
    const todo = scenes.filter((scene) => !scene.videoUrl && !busy.has(scene.id));
    const body = { ...(model !== "auto" ? { model } : {}), quality: effectiveQuality, ...(audio ? { generate_audio: true } : {}) };
    const [prices, setPrices] = useState<Record<string, Priced>>({});
    const key = `${todo.map((s) => `${s.id}:${s.duration ?? ""}`).join(",")}|${JSON.stringify(body)}`;
    useEffect(() => {
        let alive = true;
        const timer = setTimeout(() => {
            for (const scene of todo) {
                setPrices((p) => ({ ...p, [scene.id]: "loading" }));
                void host.priceStep(pipelineRequest("smart-scene-video", host.serverId, { sceneId: scene.id, body })).then((answer) => alive && setPrices((p) => ({ ...p, [scene.id]: answer })));
            }
        }, 400);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, host]);
    let total = 0;
    let ready = todo.length > 0;
    for (const scene of todo) {
        const price = prices[scene.id];
        if (price && price !== "loading" && "quote" in price) total += price.quote.holdUsd;
        else ready = false;
    }
    const render = async () => {
        if (!(await host.checkHold(total))) return;
        for (const scene of todo) {
            const price = prices[scene.id];
            if (!price || price === "loading" || !("quote" in price)) continue;
            void host.runStep(pipelineRequest("smart-scene-video", host.serverId, { sceneId: scene.id, body }), t("boardScene", { n: scenes.indexOf(scene) + 1 }), price.quote).then((outcome) => {
                if (outcome.quote) setPrices((p) => ({ ...p, [scene.id]: { quote: outcome.quote! } }));
            });
        }
    };
    return (
        <section className="director-step-body">
            <p className="muted director-intro">{t("videosIntro")}</p>
            <div className="director-row">
                <label className="director-field">
                    <span>{t("videoModel")}</span>
                    <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                        {models.map((id) => <option key={id} value={id}>{id === "auto" ? t("videoModelAuto") : id}</option>)}
                    </select>
                </label>
                <label className="director-field">
                    <span>{t("videoQuality")}</span>
                    <select className="input" value={effectiveQuality} onChange={(e) => setQuality(e.target.value)}>
                        {qualities.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                </label>
            </div>
            <label className="director-check"><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> {t("videoAudio")}</label>
            {todo.length === 0 && busy.size === 0 && <p className="muted">{t("videosNone")}</p>}
            <div className="director-card-actions">
                <button type="button" className="button primary small" disabled={!ready} onClick={() => void render()}>
                    {ready ? t("videosRun", { count: todo.length, usd: formatUsdUp(total) }) : todo.length ? t("boardPricing") : t("videosNone")}
                </button>
            </div>
            <ul className="director-task-list">
                {state.tasks.filter((task) => task.sceneId && scenes.some((s) => s.id === task.sceneId)).slice(-12).map((task, i) => <li key={`${task.id ?? "new"}-${i}`}><span className="muted">{task.label}</span> <TaskLine host={host} task={task} /></li>)}
            </ul>
        </section>
    );
}

function ReviewStep() {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const scenes = useEditorStore(selectLiveScenes);
    const done = scenes.filter((scene) => scene.videoUrl).length;
    return (
        <section className="director-step-body">
            <p className="muted director-intro">{t("reviewIntro")}</p>
            <p data-testid="wizard-review">{t("reviewDone", { done, count: scenes.length })}</p>
        </section>
    );
}
