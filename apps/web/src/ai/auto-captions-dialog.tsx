// Auto captions (spec §5.9): transcribes the timeline audio with the routed audio.transcribe provider and places
// one caption clip per spoken line on a new Captions track, through the same ai.run command agents use (one undo
// step). Without a provider it explains what the feature needs instead of hiding it (capability-gated UI).
// A caption style (phase 10b, timeline-core text/captions.ts) is picked up front and passed to the placement, so the
// captions arrive styled in the same undo step.
// Phase 11: an engine switch when both run it — On this device (free, whisper.cpp) or OpenNan cloud ("≈ $x", word
// timings from the server, the sign-in gate first).
import { useEffect, useMemo, useRef, useState } from "react";
import { WHISPER_LANGUAGES, displayedUsd, type PriceAnswer, type Provider, type ProviderModel } from "@opennan/provider-sdk";
import { planAiTool, timelineDurationSeconds, type AiRunProgress, type AiTargetRef } from "@opennan/timeline-core";
import { CAPTION_STYLES } from "@opennan/timeline-core/text/captions";
import {
    drawPreviewTextBlock, drawPreviewTextState, layoutPreviewTextBlock, parsePreviewTextStyle, previewTextBlockBleed, type PreviewTextContext,
} from "@opennan/timeline-core/lib/preview-text-draw";
import { fontFacesForStyle } from "@opennan/timeline-core/text/fonts";
import { useTimelineController } from "@opennan/timeline-react";
import { useOptionalAccount } from "../account/account-context";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import { accountHold, holdCovered, holdOf, notEnoughCreditsMessage } from "./hold-check";
import { useCapability } from "./use-capability";
import "./auto-captions.css";

export const AUTO_CAPTIONS = "Auto captions";
export const DESKTOP_HINT = "On-device auto captions run in the OpenNan Studio desktop app.";
export const DEFAULT_CAPTION_STYLE = "classic";

/** Caption style names in the picker (ids from timeline-core CAPTION_STYLES). */
export const CAPTION_STYLE_NAMES: Record<string, string> = {
    classic: "Classic",
    pill: "Pill",
    bold_yellow: "Bold yellow",
    boxed: "Boxed",
    neon: "Neon",
    minimal: "Minimal",
    karaoke_highlight: "Karaoke highlight",
    karaoke_box: "Karaoke box",
};
const SAMPLE = "Captions look like this";
const THUMB_W = 120;
const THUMB_H = 64;
/** Karaoke samples keep clear of the "Word by word" badge along the thumbnail's bottom edge. */
const BADGE_SPACE = 20;

/**
 * Draws a caption style's sample with the preview's own text drawing, fitted and centred (karaoke styles
 * highlight the second word). Returns false without a 2D context (jsdom).
 */
export function drawCaptionStyleThumb(ctx: PreviewTextContext | null, width: number, height: number, styleJson: string, karaoke: boolean, text = SAMPLE): boolean {
    if (!ctx) return false;
    const style = parsePreviewTextStyle(styleJson);
    let frameScale = (height * 0.26) / Math.max(1, style.fontSize);
    let block = layoutPreviewTextBlock(ctx, { text, textStyle: styleJson, scale: 1, frameScale, frameWidth: width });
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const bleed = previewTextBlockBleed(block) * 0.6;
        if (block.width + bleed * 2 <= width * 0.96 && block.height + bleed * 2 <= height * 0.92) break;
        frameScale *= 0.85;
        block = layoutPreviewTextBlock(ctx, { text, textStyle: styleJson, scale: 1, frameScale, frameWidth: width });
    }
    const x = (width - block.width) / 2;
    const y = (height - block.height) / 2;
    if (karaoke) drawPreviewTextState(ctx, block, x, y, { kind: "karaoke", word: 1 });
    else drawPreviewTextBlock(ctx, block, x, y);
    return true;
}

/** A caption style thumbnail: loads the style's bundled faces (document.fonts) and redraws when they arrive. */
function CaptionStyleThumb({ styleJson, karaoke }: { styleJson: string; karaoke: boolean }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [fontsLoaded, setFontsLoaded] = useState(0);
    const dpr = typeof window !== "undefined" ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
    useEffect(() => {
        const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
        const faces = fontFacesForStyle(styleJson);
        if (!fonts?.load || faces.length === 0) return;
        let live = true;
        void Promise.all(faces.map((f) => fonts.load(`${f.style === "italic" ? "italic " : ""}${f.weight} 32px "${f.family}"`)))
            .then(() => { if (live) setFontsLoaded((n) => n + 1); })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [styleJson]);
    useEffect(() => {
        const canvas = ref.current;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
            ctx = canvas?.getContext("2d") ?? null;
        } catch {
            ctx = null;
        }
        if (!canvas || !ctx) return;
        try {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, THUMB_W, THUMB_H);
            drawCaptionStyleThumb(ctx, THUMB_W, karaoke ? THUMB_H - BADGE_SPACE : THUMB_H, styleJson, karaoke);
        } catch {
            /* a broken style draws nothing */
        }
    }, [styleJson, karaoke, fontsLoaded, dpr]);
    return <canvas ref={ref} width={THUMB_W * dpr} height={THUMB_H * dpr} aria-hidden="true" />;
}

/** Arrow keys move the caption style choice (radio group). */
function nextStyle(current: string, key: string): string | null {
    const ids = CAPTION_STYLES.map((s) => s.id);
    const i = ids.indexOf(current);
    if (key === "ArrowRight" || key === "ArrowDown") return ids[(i + 1) % ids.length];
    if (key === "ArrowLeft" || key === "ArrowUp") return ids[(i + ids.length - 1) % ids.length];
    return null;
}

type Phase =
    | { kind: "idle" }
    | { kind: "running"; progress: number | null; message: string }
    | { kind: "done"; count: number }
    | { kind: "cancelled" }
    | { kind: "error"; message: string };

const LANGUAGES = [...WHISPER_LANGUAGES].sort((a, b) => a.name.localeCompare(b.name));
const MB = 1024 * 1024;

export function modelLabel(model: ProviderModel): string {
    const size = model.sizeBytes ? ` · ${Math.round(model.sizeBytes / MB)} MB` : "";
    return `${model.label}${size}${model.installed ? " · downloaded" : ""}`;
}

type Engine = "local" | "cloud";

/** The engines that can run captions: an on-device provider and/or a cloud one. */
function enginesOf(providers: Provider[]): Partial<Record<Engine, Provider>> {
    const offering = providers.filter((p) => p.info.capabilities.includes("audio.transcribe"));
    const local = offering.find((p) => p.info.onDevice);
    const cloud = offering.find((p) => !p.info.onDevice);
    return { ...(local ? { local } : {}), ...(cloud ? { cloud } : {}) };
}

export function AutoCaptionsDialog({ onClose, target }: { onClose(): void; target?: AiTargetRef }) {
    const { providers, platform, capabilityNote } = useStudioRuntime();
    const controller = useTimelineController();
    const account = useOptionalAccount();
    const gate = useCapability(providers, "audio.transcribe", AUTO_CAPTIONS);
    const engines = useMemo(() => enginesOf(gate.available ? providers.providers() : []), [gate, providers]);
    const routedEngine: Engine = gate.available && providers.route("audio.transcribe")?.info.onDevice ? "local" : engines.cloud ? "cloud" : "local";
    const [engine, setEngine] = useState<Engine>(routedEngine);
    const [price, setPrice] = useState<PriceAnswer | null>(null);
    // An unreadable price is asked again after a while (the cloud run waits for one).
    const [priceRetry, setPriceRetry] = useState(0);
    useEffect(() => {
        if (price?.kind !== "unknown") return;
        const timer = window.setTimeout(() => setPriceRetry((n) => n + 1), 10_000);
        return () => window.clearTimeout(timer);
    }, [price]);
    const [language, setLanguage] = useState("auto");
    const [models, setModels] = useState<ProviderModel[]>([]);
    const [model, setModel] = useState<string | null>(null);
    const [styleId, setStyleId] = useState(DEFAULT_CAPTION_STYLE);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const abort = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const both = Boolean(engines.local && engines.cloud);
    const chosen: Engine = engines[engine] ? engine : routedEngine;
    const provider = useMemo(() => (gate.available ? engines[chosen] ?? providers.route("audio.transcribe") : null), [gate, engines, chosen, providers]);
    const cloud = chosen === "cloud" && Boolean(engines.cloud);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            abort.current?.abort();
        };
    }, []);
    useEffect(() => {
        let live = true;
        void provider?.audio?.models?.("audio.transcribe").then((list) => {
            if (!live) return;
            setModels(list);
            setModel((current) => current ?? list.find((m) => m.default)?.id ?? list[0]?.id ?? null);
        }).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [provider, phase.kind === "done"]);

    // The cloud price for the whole timeline's audio (started minutes, never below the settle).
    useEffect(() => {
        let live = true;
        setPrice(null);
        if (!engines.cloud?.price) return;
        const snapshot = controller.snapshot?.();
        const planned = snapshot && target ? planAiTool(snapshot, "captions", { ...target, engine: "cloud" }) : null;
        const seconds = planned?.ok ? planned.plan.units.seconds ?? 0 : snapshot ? timelineDurationSeconds(snapshot) : 0;
        if (!(seconds > 0)) return;
        void engines.cloud.price({ capability: "audio.transcribe", input: {}, units: { seconds } }).then((answer) => {
            if (live) setPrice(answer);
        }).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [engines, controller, target, priceRetry]);

    const running = phase.kind === "running";
    const cloudBlocked = cloud && price && (price.kind === "unavailable" || price.kind === "over-limit")
        ? price.kind === "unavailable" ? price.reason : `OpenNan cloud captions take at most ${Math.round(price.limit.max / 60)} minutes of audio.`
        : null;
    // The cloud engine runs only from a shown price, and sends that amount for the provider's re-check.
    const cloudUnpriced = cloud && Boolean(engines.cloud?.price) && price?.kind !== "estimate";
    const start = async () => {
        if (cloud && account && !(await account.requireOpenNan("audio.transcribe", AUTO_CAPTIONS))) return;
        if (!mounted.current) return;
        // The balance must cover what the cloud run holds (phase 11.1): nothing is sent otherwise.
        if (cloud && account && engines.cloud?.info.id === "opennan" && price?.kind === "estimate") {
            const hold = holdOf(price.estimate);
            if (!(await holdCovered(accountHold(account.account), hold))) {
                if (mounted.current) setPhase({ kind: "error", message: notEnoughCreditsMessage(hold) });
                return;
            }
            if (!mounted.current) return;
        }
        const controllerAbort = new AbortController();
        abort.current = controllerAbort;
        setPhase({ kind: "running", progress: null, message: "Starting" });
        const onProgress = (update: AiRunProgress) => {
            if (!mounted.current || controllerAbort.signal.aborted) return;
            setPhase({ kind: "running", progress: update.progress ?? null, message: update.message ?? "Working" });
        };
        const style = styleId === DEFAULT_CAPTION_STYLE ? "caption" : styleId;
        // One clip or scene: the same plan the AI tab and agents use (its used range, placed at its timeline position).
        const planned = target ? planAiTool(controller.snapshot(), "captions", { ...target, language, style, ...(both || cloud ? { engine: chosen } : {}) }) : null;
        if (planned && !planned.ok) {
            abort.current = null;
            setPhase({ kind: "error", message: planned.error });
            return;
        }
        const accepted = cloud && price?.kind === "estimate" ? { expectedMaxUsd: displayedUsd(price.estimate.microUsd) } : {};
        const input = planned?.ok
            ? { ...planned.plan.input, ...(model && !cloud ? { model } : {}), ...accepted }
            : { language, ...(both || cloud ? { engine: chosen } : {}), ...(model && !cloud ? { model } : {}), ...accepted };
        const placeAt = planned?.ok && planned.plan.placeAt ? planned.plan.placeAt : { kind: "captions-track", style };
        const result = await controller.execute({ type: "ai.run", capability: "audio.transcribe", input, placeAt },
            { signal: controllerAbort.signal, onProgress, toastOnError: false });
        if (!mounted.current) return;
        abort.current = null;
        if (result.ok) {
            setPhase({ kind: "done", count: (result.createdClipIds ?? []).length });
        }
        else if (result.cancelled) setPhase({ kind: "cancelled" });
        else setPhase({ kind: "error", message: result.error ?? "Auto captions failed." });
        if (cloud) void account?.account.refresh();
    };
    const cancel = () => abort.current?.abort();
    const close = () => {
        cancel();
        onClose();
    };

    if (!gate.available) {
        return (
            <Dialog title={AUTO_CAPTIONS} onClose={onClose}>
                <p className="captions-unavailable" role="note">{gate.message}</p>
                {capabilityNote?.("audio.transcribe") && <p className="muted small" style={{ margin: 0 }}>{capabilityNote("audio.transcribe")}</p>}
                {platform !== "desktop" && <p className="muted small" style={{ margin: 0 }}>{DESKTOP_HINT}</p>}
                <div className="dialog-footer">
                    <button type="button" className="button ghost" onClick={onClose}>Close</button>
                </div>
            </Dialog>
        );
    }

    return (
        <Dialog title={AUTO_CAPTIONS} onClose={close}>
            {both && (
                <div className="generate-kinds" role="radiogroup" aria-label="Where to transcribe">
                    {(["local", "cloud"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={chosen === value}
                            className="generate-kind"
                            disabled={running}
                            onClick={() => setEngine(value)}
                        >
                            {value === "local" ? "On this device · free" : `OpenNan cloud${price?.kind === "estimate" ? ` · ${price.estimate.label}` : ""}`}
                        </button>
                    ))}
                </div>
            )}
            <div className="captions-fields">
                <label className="field">
                    <span>Language</span>
                    <select className="text-input captions-select" value={language} disabled={running} onChange={(event) => setLanguage(event.target.value)}>
                        <option value="auto">Auto-detect</option>
                        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                    </select>
                </label>
                {!cloud && (
                    <label className="field">
                        <span>Model</span>
                        <select className="text-input captions-select" value={model ?? ""} disabled={running || models.length === 0} onChange={(event) => setModel(event.target.value)}>
                            {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
                        </select>
                    </label>
                )}
            </div>
            <fieldset className="captions-styles" disabled={running}>
                <legend>Style</legend>
                <div
                    className="captions-style-grid"
                    role="radiogroup"
                    aria-label="Caption style"
                    onKeyDown={(event) => {
                        const next = nextStyle(styleId, event.key);
                        if (!next) return;
                        event.preventDefault();
                        setStyleId(next);
                        (event.currentTarget.querySelector(`[data-style="${next}"]`) as HTMLElement | null)?.focus();
                    }}
                >
                    {CAPTION_STYLES.map((style) => (
                        <button
                            key={style.id}
                            type="button"
                            role="radio"
                            aria-checked={styleId === style.id}
                            tabIndex={styleId === style.id ? 0 : -1}
                            className="captions-style"
                            data-style={style.id}
                            onClick={() => setStyleId(style.id)}
                        >
                            <span className="captions-style-thumb">
                                <CaptionStyleThumb styleJson={JSON.stringify(style.style)} karaoke={style.karaoke} />
                                {style.karaoke && <span className="captions-style-badge">Word by word</span>}
                            </span>
                            <span className="captions-style-name">{CAPTION_STYLE_NAMES[style.id] ?? style.id}</span>
                        </button>
                    ))}
                </div>
            </fieldset>
            {cloud ? (
                <p className="captions-note small">
                    Sends {target ? "this clip's audio" : "the timeline audio"} to OpenNan cloud and adds the captions, with word timings, on a new Captions track.
                    {price?.kind === "estimate" ? ` ${price.estimate.label}: charged when it finishes, refunded if it fails.` : ""}
                </p>
            ) : (
                <p className="captions-note small">
                    Transcribes {target ? "this clip's audio" : "the timeline audio"} on this computer ({provider?.info.name ?? gate.providerName}) and adds the captions on a new Captions track.
                    The first use of a model downloads it once.
                </p>
            )}
            {cloudBlocked && <p className="captions-unavailable" role="note">{cloudBlocked}</p>}
            {phase.kind === "running" && (
                <div className="captions-progress" role="status">
                    <progress max={1} value={phase.progress ?? undefined} aria-label="Auto captions progress" />
                    <span className="muted small">{phase.message}{phase.progress !== null ? ` ${Math.round(phase.progress * 100)}%` : ""}</span>
                </div>
            )}
            {phase.kind === "done" && (
                <p className="captions-done" role="status">
                    {phase.count > 0 ? `Added ${phase.count} caption${phase.count === 1 ? "" : "s"} on a new Captions track.` : "No speech found."}
                </p>
            )}
            {phase.kind === "cancelled" && <p className="muted small" role="status">Cancelled.</p>}
            {phase.kind === "error" && <p className="error-text" role="alert">{phase.message}</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={running ? cancel : close}>{running ? "Cancel" : "Close"}</button>
                <button type="button" className="button primary" disabled={running || (!cloud && !model) || Boolean(cloudBlocked) || cloudUnpriced} onClick={() => void start()}>
                    {`${cloud && price?.kind === "estimate" ? `${price.estimate.label} · ` : ""}${phase.kind === "error" ? "Try again" : phase.kind === "done" ? "Run again" : cloud ? "Run" : "Start"}`}
                </button>
            </div>
        </Dialog>
    );
}
