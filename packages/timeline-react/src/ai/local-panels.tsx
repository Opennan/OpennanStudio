"use client";
// The free, on-device AI tools of the inspector's AI tab (phase 11). Each finds first and changes nothing, shows what it
// would cut as ghost regions on the timeline (store.aiCutPreview), then applies in ONE command (one undo step):
//   Remove silences     analysis.run silences (the host's analyzer: decode + worker) → cuts.apply
//   Remove filler words analysis.fillers (caption word timings) → the checked ones → cuts.apply
//   Detect beats        analysis.run beats → beats.set (source seconds on the audio clip); Clear → beats.set null
// No editor host (opennan.com) is needed for any of them.
import { useEffect, useId, useRef, useState } from "react";
import { AudioWaveform, Scissors, Square, X } from "lucide-react";
import { FILLER_WORDS, planAiTool, type AiCutPreview, type AiTargetRef, type AiToolId, type TimelineClip } from "@opennan/timeline-core";
import { parseBeatsJson } from "@opennan/timeline-core/analysis/beat-plan";
import { useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { SliderRow } from "../editing/controls";
import { FILLER_LANGUAGE_NAMES } from "./languages";
import { useAiHost } from "./use-ai";

type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;
type Range = { start: number; end: number };

const totalSeconds = (ranges: readonly Range[]) => ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
const oneDecimal = (seconds: number) => (Math.round(seconds * 10) / 10).toFixed(1);

/** "0:03.2" for a timeline second. */
export function formatClock(seconds: number): string {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** Why a local tool cannot run on the item (the shared planner's words), or null. */
function usePlanError(toolId: AiToolId, target: AiTargetRef): string | null {
    const controller = useTimelineController();
    const result = planAiTool(controller.snapshot(), toolId, target);
    return result.ok ? null : result.error;
}

/** Sets the timeline's cut preview and takes it back when the panel goes away (only if it is still ours). */
function useCutPreview() {
    const storeApi = useEditorStoreApi();
    const ours = useRef<AiCutPreview | null>(null);
    useEffect(() => () => {
        if (ours.current && storeApi.getState().aiCutPreview === ours.current) storeApi.getState().setAiCutPreview(null);
    }, [storeApi]);
    return (preview: AiCutPreview | null) => {
        const state = storeApi.getState();
        if (!preview) {
            // Only our own ghosts are taken away; another panel's stay.
            if (ours.current && state.aiCutPreview === ours.current) state.setAiCutPreview(null);
            ours.current = null;
            return;
        }
        ours.current = preview;
        state.setAiCutPreview(preview);
    };
}

function LocalNote({ t }: { t: Translate }) {
    return <p className="on-ai-note">{t("ai_localNote")}</p>;
}

function Progress({ t, progress, onCancel, testId }: { t: Translate; progress: number; onCancel(): void; testId: string }) {
    const percent = Math.round(progress * 100);
    return (
        <>
            <div className="on-ai-progress" role="progressbar" aria-label={t("ai_analysisProgress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-testid={`${testId}-progress`}>
                <span style={{ width: `${percent}%` }} />
            </div>
            <div className="on-row-between">
                <p className="on-hint" role="status" aria-live="polite">{t("ai_analysing", { percent })}</p>
                <button type="button" className="on-btn on-btn-ghost" data-testid={`${testId}-cancel`} onClick={onCancel}><Square aria-hidden="true" />{t("ai_cancel")}</button>
            </div>
        </>
    );
}

type AnalysisStatus<T> =
    | { kind: "idle" }
    | { kind: "running"; progress: number }
    | { kind: "found"; result: T }
    | { kind: "done"; message: string }
    | { kind: "error"; message: string };

/** analysis.run with progress and cancel; resolves the output, or null (cancelled / failed, status set). */
function useAnalysisRun<T>(t: Translate, setStatus: (update: (s: AnalysisStatus<T>) => AnalysisStatus<T>) => void) {
    const controller = useTimelineController();
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);
    const run = async (command: { kind: "silences" | "beats"; options?: Record<string, number> } & AiTargetRef): Promise<unknown | null> => {
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        setStatus(() => ({ kind: "running", progress: 0 }));
        const outcome = await controller.execute(
            { type: "analysis.run", ...command },
            { signal: abort.signal, toastOnError: false, onProgress: (p) => setStatus((s) => (s.kind === "running" && abortRef.current === abort ? { kind: "running", progress: p.progress ?? 0 } : s)) },
        );
        if (abortRef.current !== abort) return null;
        abortRef.current = null;
        if (outcome.cancelled) {
            setStatus(() => ({ kind: "idle" }));
            return null;
        }
        if (!outcome.ok) {
            const reason = outcome.error ?? "";
            setStatus(() => ({ kind: "error", message: outcome.unavailable ? t("ai_analysisUnavailable", { reason }) : t("ai_analysisFailed", { reason }) }));
            return null;
        }
        return outcome.output ?? null;
    };
    const cancel = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setStatus(() => ({ kind: "idle" }));
    };
    return { run, cancel };
}

// ── Remove silences ─────────────────────────────────────

export const SILENCE_CONTROLS = {
    thresholdDb: { min: -60, max: -20, step: 1, value: -40 },
    minSilence: { min: 0.2, max: 2, step: 0.05, value: 0.35 },
    padding: { min: 0, max: 0.3, step: 0.01, value: 0.08 },
} as const;

export function SilencesPanel({ target, autoStart }: { target: AiTargetRef; autoStart?: boolean }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const setPreview = useCutPreview();
    const planError = usePlanError("silences", target);
    const [thresholdDb, setThreshold] = useState<number>(SILENCE_CONTROLS.thresholdDb.value);
    const [minSilence, setMinSilence] = useState<number>(SILENCE_CONTROLS.minSilence.value);
    const [padding, setPadding] = useState<number>(SILENCE_CONTROLS.padding.value);
    const [status, setStatusState] = useState<AnalysisStatus<Range[]>>({ kind: "idle" });
    const setStatus = (update: (s: AnalysisStatus<Range[]>) => AnalysisStatus<Range[]>) => setStatusState(update);
    const analysis = useAnalysisRun<Range[]>(t, setStatus);
    const statusId = useId();

    const find = async () => {
        setPreview(null);
        const output = await analysis.run({ kind: "silences", ...target, options: { thresholdDb, minSilence, padding } }) as { ranges?: Range[] } | null;
        if (!output) return;
        const ranges = output.ranges ?? [];
        setStatus(() => ({ kind: "found", result: ranges }));
        setPreview(ranges.length > 0 ? { ranges, kind: "silences" } : null);
    };
    const started = useRef(false);
    useEffect(() => {
        if (autoStart && !started.current && !planError) {
            started.current = true;
            void find();
        }
        // Started once per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoStart]);

    const remove = async (ranges: Range[]) => {
        const outcome = await controller.execute({ type: "cuts.apply", ...target, ranges }, { toastOnError: false });
        if (!outcome.ok) {
            setStatus(() => ({ kind: "error", message: t("ai_cutFailed", { reason: outcome.error ?? "" }) }));
            return;
        }
        setPreview(null);
        setStatus(() => ({ kind: "done", message: t("ai_removed", { seconds: oneDecimal(totalSeconds(ranges)) }) }));
    };
    const clear = () => {
        setPreview(null);
        setStatus(() => ({ kind: "idle" }));
    };

    const running = status.kind === "running";
    const seconds = (v: number) => t("ai_seconds", { value: v.toFixed(2) });
    return (
        <div data-testid="ai-silences">
            <p className="on-ai-desc">{t("ai_silencesDesc")}</p>
            <SliderRow testId="ai-silences-threshold" label={t("ai_silThreshold")} {...SILENCE_CONTROLS.thresholdDb} value={thresholdDb} defaultValue={SILENCE_CONTROLS.thresholdDb.value} disabled={running} format={(v) => t("ai_db", { value: v })} onChange={setThreshold} />
            <SliderRow testId="ai-silences-min" label={t("ai_silMin")} {...SILENCE_CONTROLS.minSilence} value={minSilence} defaultValue={SILENCE_CONTROLS.minSilence.value} disabled={running} format={seconds} onChange={setMinSilence} />
            <SliderRow testId="ai-silences-padding" label={t("ai_silPadding")} {...SILENCE_CONTROLS.padding} value={padding} defaultValue={SILENCE_CONTROLS.padding.value} disabled={running} format={seconds} onChange={setPadding} />
            {running ? (
                <Progress t={t} progress={status.progress} onCancel={analysis.cancel} testId="ai-silences" />
            ) : (
                <button type="button" className="on-btn on-btn-primary on-ai-run" data-testid="ai-silences-find" disabled={Boolean(planError)} aria-describedby={statusId} onClick={() => void find()}>
                    <AudioWaveform aria-hidden="true" />{t("ai_silFind")}
                </button>
            )}
            <div id={statusId} aria-live="polite">
                {planError && <p className="on-ai-reason" data-testid="ai-silences-reason">{planError}</p>}
                {status.kind === "found" && (
                    <p className="on-ai-summary" data-testid="ai-silences-summary">
                        {status.result.length > 0 ? t("ai_silSummary", { count: status.result.length, seconds: oneDecimal(totalSeconds(status.result)) }) : t("ai_silNone")}
                    </p>
                )}
                {status.kind === "done" && <p className="on-ai-summary" data-testid="ai-silences-done">{status.message}</p>}
                {status.kind === "error" && <p className="on-ai-error" data-testid="ai-silences-error">{status.message}</p>}
            </div>
            {status.kind === "found" && status.result.length > 0 && (
                <div className="on-ai-buttons">
                    <button type="button" className="on-btn on-btn-primary" data-testid="ai-silences-remove" onClick={() => void remove(status.result)}><Scissors aria-hidden="true" />{t("ai_silRemove")}</button>
                    <button type="button" className="on-btn on-btn-ghost" data-testid="ai-silences-clear" onClick={clear}><X aria-hidden="true" />{t("ai_clear")}</button>
                </div>
            )}
            <LocalNote t={t} />
        </div>
    );
}

// ── Remove filler words ─────────────────────────────────

interface FillerRow {
    range: Range;
    words: string[];
}

/** One row per cut range with the filler words inside it (adjacent fillers go out as one cut). */
export function fillerRows(ranges: readonly Range[], words: ReadonlyArray<{ text: string; start: number; end: number }>): FillerRow[] {
    return ranges.map((range) => ({
        range,
        words: words.filter((w) => (w.start + w.end) / 2 >= range.start - 1e-6 && (w.start + w.end) / 2 <= range.end + 1e-6).map((w) => w.text),
    }));
}

const NO_WORDS = /^No word timings/;

export function FillersPanel({ target }: { target: AiTargetRef }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const host = useAiHost();
    const setPreview = useCutPreview();
    const planError = usePlanError("fillers", target);
    const [language, setLanguage] = useState("auto");
    const [rows, setRows] = useState<FillerRow[] | null>(null);
    const [checked, setChecked] = useState<Set<number>>(() => new Set());
    const [needsCaptions, setNeedsCaptions] = useState(false);
    const [message, setMessage] = useState<{ kind: "done" | "error"; text: string } | null>(null);
    const languageId = useId();

    const previewOf = (list: FillerRow[], on: Set<number>) => {
        const ranges = list.filter((_, i) => on.has(i)).map((row) => row.range);
        setPreview(ranges.length > 0 ? { ranges, kind: "fillers" } : null);
    };

    const find = async () => {
        setMessage(null);
        setNeedsCaptions(false);
        setPreview(null);
        const outcome = await controller.execute({ type: "analysis.fillers", ...target, ...(language !== "auto" ? { language } : {}) }, { toastOnError: false });
        if (!outcome.ok) {
            setRows(null);
            if (NO_WORDS.test(outcome.error ?? "")) setNeedsCaptions(true);
            else setMessage({ kind: "error", text: t("ai_fillersFailed", { reason: outcome.error ?? "" }) });
            return;
        }
        const output = outcome.output as { ranges: Range[]; words: Array<{ text: string; start: number; end: number }> };
        const found = fillerRows(output.ranges, output.words);
        const all = new Set(found.map((_, i) => i));
        setRows(found);
        setChecked(all);
        previewOf(found, all);
    };

    const toggle = (index: number, on: boolean) => {
        const next = new Set(checked);
        if (on) next.add(index);
        else next.delete(index);
        setChecked(next);
        if (rows) previewOf(rows, next);
    };

    const remove = async () => {
        if (!rows) return;
        const ranges = rows.filter((_, i) => checked.has(i)).map((row) => row.range);
        if (ranges.length === 0) return;
        const outcome = await controller.execute({ type: "cuts.apply", ...target, ranges }, { toastOnError: false });
        if (!outcome.ok) {
            setMessage({ kind: "error", text: t("ai_cutFailed", { reason: outcome.error ?? "" }) });
            return;
        }
        setPreview(null);
        setRows(null);
        setChecked(new Set());
        setMessage({ kind: "done", text: t("ai_removed", { seconds: oneDecimal(totalSeconds(ranges)) }) });
    };

    const makeCaptions = () => {
        if (!host) return;
        if (host.openAutoCaptions) host.openAutoCaptions(target);
        else host.run("captions", target);
    };

    return (
        <div data-testid="ai-fillers">
            <p className="on-ai-desc">{t("ai_fillersDesc")}</p>
            <label className="on-field" htmlFor={languageId}>
                <span className="on-field-label">{t("ai_fillersLanguage")}</span>
                <select id={languageId} className="on-ai-select" data-testid="ai-fillers-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="auto">{t("ai_langAuto")}</option>
                    {Object.keys(FILLER_WORDS).map((code) => <option key={code} value={code}>{FILLER_LANGUAGE_NAMES[code] ?? code}</option>)}
                </select>
            </label>
            <button type="button" className="on-btn on-btn-primary on-ai-run" data-testid="ai-fillers-find" disabled={Boolean(planError)} onClick={() => void find()}>
                <AudioWaveform aria-hidden="true" />{t("ai_fillersFind")}
            </button>
            <div aria-live="polite">
                {planError && <p className="on-ai-reason" data-testid="ai-fillers-reason">{planError}</p>}
                {needsCaptions && (
                    <div className="on-ai-action" data-testid="ai-fillers-needs-captions">
                        <p className="on-ai-reason">{t("ai_fillersNeedCaptions")}</p>
                        <button type="button" className="on-btn" data-testid="ai-fillers-make-captions" disabled={!host} onClick={makeCaptions}>{t("ai_fillersMakeCaptions")}</button>
                        {!host && <p className="on-ai-note">{t("ai_needsApp")}</p>}
                    </div>
                )}
                {rows && rows.length === 0 && <p className="on-ai-summary" data-testid="ai-fillers-none">{t("ai_fillersNone")}</p>}
                {rows && rows.length > 0 && <p className="on-ai-summary" data-testid="ai-fillers-summary">{t("ai_fillersFound", { count: rows.reduce((n, row) => n + Math.max(1, row.words.length), 0) })}</p>}
                {message && <p className={message.kind === "error" ? "on-ai-error" : "on-ai-summary"} data-testid={`ai-fillers-${message.kind}`}>{message.text}</p>}
            </div>
            {rows && rows.length > 0 && (
                <>
                    <ul className="on-ai-found" data-testid="ai-fillers-list">
                        {rows.map((row, i) => (
                            <li key={`${row.range.start}-${row.range.end}`}>
                                <label className="on-attr-row">
                                    <input type="checkbox" className="on-attr-check" data-testid={`ai-fillers-row-${i}`} checked={checked.has(i)} onChange={(e) => toggle(i, e.currentTarget.checked)} />
                                    <span className="on-attr-name">{row.words.join(" ") || "…"}</span>
                                    <span className="on-ai-found-time">{formatClock(row.range.start)}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="on-ai-buttons">
                        <button type="button" className="on-btn on-btn-primary" data-testid="ai-fillers-remove" disabled={checked.size === 0} onClick={() => void remove()}>
                            <Scissors aria-hidden="true" />{t("ai_fillersRemove", { count: checked.size })}
                        </button>
                        <button type="button" className="on-btn on-btn-ghost" data-testid="ai-fillers-clear" onClick={() => { setPreview(null); setRows(null); }}><X aria-hidden="true" />{t("ai_clear")}</button>
                    </div>
                </>
            )}
            <LocalNote t={t} />
        </div>
    );
}

// ── Detect beats ────────────────────────────────────────

export function BeatsPanel({ clip, autoStart }: { clip: TimelineClip; autoStart?: boolean }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const target = { clipId: clip.id };
    const planError = usePlanError("beats", target);
    const stored = parseBeatsJson(clip.beatsJson).length;
    const [status, setStatusState] = useState<AnalysisStatus<{ bpm: number; count: number }>>({ kind: "idle" });
    const setStatus = (update: (s: AnalysisStatus<{ bpm: number; count: number }>) => AnalysisStatus<{ bpm: number; count: number }>) => setStatusState(update);
    const analysis = useAnalysisRun(t, setStatus);

    const detect = async () => {
        const output = await analysis.run({ kind: "beats", clipId: clip.id }) as { bpm: number; sourceTimes?: number[]; times?: number[] } | null;
        if (!output) return;
        const beats = output.sourceTimes ?? [];
        if (beats.length === 0) {
            setStatus(() => ({ kind: "done", message: t("ai_beatsNone") }));
            return;
        }
        const saved = await controller.execute({ type: "beats.set", clipId: clip.id, beats }, { toastOnError: false });
        if (!saved.ok) {
            setStatus(() => ({ kind: "error", message: t("ai_beatsFailed", { reason: saved.error ?? "" }) }));
            return;
        }
        setStatus(() => ({ kind: "found", result: { bpm: Math.round(output.bpm), count: beats.length } }));
    };
    const started = useRef(false);
    useEffect(() => {
        if (autoStart && !started.current && !planError) {
            started.current = true;
            void detect();
        }
        // Started once per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoStart]);

    const clear = async () => {
        const outcome = await controller.execute({ type: "beats.set", clipId: clip.id, beats: null }, { toastOnError: false });
        setStatus(() => (outcome.ok ? { kind: "idle" } : { kind: "error", message: t("ai_beatsFailed", { reason: outcome.error ?? "" }) }));
    };

    const running = status.kind === "running";
    return (
        <div data-testid="ai-beats">
            <p className="on-ai-desc">{t("ai_beatsDesc")}</p>
            {running ? (
                <Progress t={t} progress={status.progress} onCancel={analysis.cancel} testId="ai-beats" />
            ) : (
                <div className="on-ai-buttons">
                    <button type="button" className="on-btn on-btn-primary" data-testid="ai-beats-detect" disabled={Boolean(planError)} onClick={() => void detect()}>
                        <AudioWaveform aria-hidden="true" />{stored > 0 ? t("ai_beatsAgain") : t("ai_beatsDetect")}
                    </button>
                    {stored > 0 && (
                        <button type="button" className="on-btn on-btn-ghost" data-testid="ai-beats-clear" onClick={() => void clear()}><X aria-hidden="true" />{t("ai_beatsClear")}</button>
                    )}
                </div>
            )}
            <div aria-live="polite">
                {planError && <p className="on-ai-reason" data-testid="ai-beats-reason">{planError}</p>}
                {status.kind === "found" && <p className="on-ai-summary" data-testid="ai-beats-summary">{t("ai_beatsSummary", { bpm: status.result.bpm, count: status.result.count })}</p>}
                {status.kind !== "found" && status.kind !== "running" && stored > 0 && <p className="on-hint" data-testid="ai-beats-stored">{t("ai_beatsOnClip", { count: stored })}</p>}
                {status.kind === "done" && <p className="on-ai-summary" data-testid="ai-beats-done">{status.message}</p>}
                {status.kind === "error" && <p className="on-ai-error" data-testid="ai-beats-error">{status.message}</p>}
            </div>
            <LocalNote t={t} />
        </div>
    );
}

