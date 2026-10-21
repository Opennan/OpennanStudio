// Generate (phase 8, phase 11): an image, a video (from a description, or from the frame at the playhead), a voice
// (text to speech with a voice picker), music, or a sound effect, through the same ai.run command agents use. Each
// paid run shows "≈ $x · Generate" from the provider's price (never below what it settles at). The result lands in the
// project's media library and, by default, on the timeline at the playhead (one undo step). Signed out, Generate
// opens Sign in with OpenNan first (the OpenNan gate) and continues after approval.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MediaSourceRef, PriceAnswer, PriceUnits, ProviderCapability, ProviderModel, ProviderVoice } from "@opennan/provider-sdk";
import type { AiRunProgress } from "@opennan/timeline-core";
import { useEditorStore, useTimelineController, type GenerateKind } from "@opennan/timeline-react";
import { useAccount } from "../account/account-context";
import { accountHold, holdCovered, holdOf, notEnoughCreditsMessage } from "./hold-check";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import { useCapability } from "./use-capability";
import "./generate.css";

export const GENERATE = "Generate";
/** provider-opennan's INSUFFICIENT_CREDITS_MESSAGE starts with this. */
const CREDITS_PREFIX = "Not enough credits";
/** The price is asked once the run's inputs stop changing for this long. */
export const PRICE_SETTLE_MS = 400;
const MUSIC_SECONDS = [10, 30, 60, 120, 240];
const SFX_SECONDS = [1, 3, 5, 10, 22];

interface KindSpec {
    capability: ProviderCapability;
    label: string;
    feature: string;
    field: string;
    placeholder: string;
}

const KINDS: Record<GenerateKind, KindSpec> = {
    image: { capability: "image.generate", label: "Image", feature: "Generate image", field: "Describe the image", placeholder: "A lighthouse on a cliff at dawn, soft fog" },
    video: { capability: "video.text-to-video", label: "Video", feature: "Generate video", field: "Describe the video", placeholder: "Slow drone shot over a lighthouse at dawn" },
    voice: { capability: "audio.tts", label: "Voice", feature: "Text to speech", field: "Text to speak", placeholder: "Welcome back. Today we build a lighthouse." },
    music: { capability: "audio.music", label: "Music", feature: "Generate music", field: "Describe the music", placeholder: "Warm lo-fi beat, soft piano, 80 BPM" },
    sfx: { capability: "audio.sfx", label: "Sound effect", feature: "Generate a sound effect", field: "Describe the sound", placeholder: "Heavy rain on a tin roof" },
};

type Phase =
    | { kind: "idle" }
    | { kind: "running"; progress: number | null; message: string }
    | { kind: "done"; count: number; placed: number }
    | { kind: "cancelled" }
    | { kind: "error"; message: string; credits: boolean };

export interface GenerateDialogProps {
    onClose(): void;
    initialKind?: GenerateKind;
    /** "From this frame": the still under the playhead, saved to Media; null when there is no video there. */
    captureFrame?(): Promise<MediaSourceRef | null>;
    fromFrame?: boolean;
}

function priceLabel(answer: PriceAnswer | null): string | null {
    if (!answer) return null;
    if (answer.kind === "estimate") return answer.estimate.label;
    if (answer.kind === "billed-elsewhere") return `Billed by ${answer.by}`;
    if (answer.kind === "free") return "Free";
    return null;
}

export function GenerateDialog({ onClose, initialKind = "image", captureFrame, fromFrame: initialFromFrame = false }: GenerateDialogProps) {
    const { providers } = useStudioRuntime();
    const { account, requireOpenNan } = useAccount();
    const controller = useTimelineController();
    const aspectRatio = useEditorStore((s) => s.projectMeta?.aspectRatio ?? "16:9");
    const playhead = useEditorStore((s) => (s as { currentTime?: number }).currentTime ?? 0);
    const [kind, setKind] = useState<GenerateKind>(initialKind);
    const [description, setDescription] = useState("");
    const [models, setModels] = useState<ProviderModel[]>([]);
    const [model, setModel] = useState<string | null>(null);
    const [voices, setVoices] = useState<ProviderVoice[]>([]);
    const [voice, setVoice] = useState<string | null>(null);
    const [seconds, setSeconds] = useState<number | null>(null);
    const [instrumental, setInstrumental] = useState(false);
    const [fromFrame, setFromFrame] = useState(initialFromFrame && Boolean(captureFrame));
    const [place, setPlace] = useState(true);
    const [price, setPrice] = useState<PriceAnswer | null>(null);
    // An unreadable price is asked again after a while (the run waits for one).
    const [priceRetry, setPriceRetry] = useState(0);
    useEffect(() => {
        if (price?.kind !== "unknown") return;
        const timer = window.setTimeout(() => setPriceRetry((n) => n + 1), 10_000);
        return () => window.clearTimeout(timer);
    }, [price]);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const abort = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const fieldId = useId();
    const base = KINDS[kind];
    const capability: ProviderCapability = kind === "video" && fromFrame ? "video.image-to-video" : base.capability;
    const spec = { ...base, capability };
    const gate = useCapability(providers, capability, spec.feature);
    const provider = useMemo(() => (gate.available ? providers.route(capability) : null), [gate, providers, capability]);
    const chosenModel = models.find((m) => m.id === model) ?? null;
    const durations = kind === "video" ? (chosenModel?.durations?.length ? chosenModel.durations : [5, 10]) : kind === "music" ? MUSIC_SECONDS : kind === "sfx" ? SFX_SECONDS : [];
    const duration = seconds !== null && durations.includes(seconds) ? seconds : durations[kind === "music" ? 1 : kind === "sfx" ? 2 : 0] ?? null;

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            abort.current?.abort();
        };
    }, []);
    useEffect(() => {
        let live = true;
        setModels([]);
        setModel(null);
        void provider?.models?.(capability).then((list) => {
            if (!live) return;
            setModels(list);
            setModel(list.find((m) => m.default)?.id ?? list[0]?.id ?? null);
        }).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [provider, capability]);
    useEffect(() => {
        let live = true;
        if (kind !== "voice" || !provider?.voices) return;
        void provider.voices().then((list) => {
            if (!live) return;
            setVoices(list);
            setVoice((current) => current ?? list[0]?.id ?? null);
        }).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [provider, kind]);

    const input = useMemo((): Record<string, unknown> => {
        const text = description.trim();
        const common = model ? { model } : {};
        switch (kind) {
            case "image":
                return { description: text, aspectRatio, ...common };
            case "video":
                return { description: text, aspectRatio, ...(duration ? { durationSeconds: duration } : {}), ...common };
            case "voice":
                return { text, ...(voice ? { voice } : {}), ...common };
            case "music":
                return { description: text, ...(duration ? { durationSeconds: duration } : {}), instrumental, ...common };
            case "sfx":
                return { description: text, ...(duration ? { durationSeconds: duration } : {}) };
        }
    }, [kind, description, model, aspectRatio, duration, voice, instrumental]);
    const units = useMemo((): PriceUnits => {
        if (kind === "image") return { images: 0 };
        if (kind === "voice") return { characters: [...description.trim()].length };
        return duration ? { seconds: duration } : {};
    }, [kind, description, duration]);

    // The price for exactly this run ("≈ $x"), re-read once what would be sent stops changing (400 ms: typing, picking).
    // OpenNan prices from its quotes, which leave the prompt out, so typing a description reuses the quote.
    useEffect(() => {
        let live = true;
        setPrice(null);
        if (!provider?.price) return;
        const timer = window.setTimeout(() => {
            void provider.price!({ capability, input, units }).then((answer) => {
                if (live) setPrice(answer);
            }).catch(() => undefined);
        }, PRICE_SETTLE_MS);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [provider, capability, input, units, priceRetry]);

    const running = phase.kind === "running";
    const unavailable = price?.kind === "unavailable" ? price.reason : null;
    // A provider with prices must show one before a paid run starts (never "unknown" or still loading).
    const unpriced = Boolean(provider?.price) && !(price && (price.kind === "estimate" || price.kind === "free" || price.kind === "billed-elsewhere"));
    const generate = async () => {
        if (!description.trim() || running || unavailable || unpriced) return;
        if (!(await requireOpenNan(capability, spec.feature)) || !mounted.current) return;
        // The balance must cover what the run holds (phase 11.1): nothing is sent otherwise.
        if (provider?.info.id === "opennan" && price?.kind === "estimate") {
            const hold = holdOf(price.estimate);
            if (!(await holdCovered(accountHold(account), hold))) {
                if (mounted.current) setPhase({ kind: "error", message: notEnoughCreditsMessage(hold), credits: true });
                return;
            }
            if (!mounted.current) return;
        }
        const run = new AbortController();
        abort.current = run;
        setPhase({ kind: "running", progress: null, message: "Starting" });
        let image: MediaSourceRef | null = null;
        if (capability === "video.image-to-video") {
            image = (await captureFrame?.().catch(() => null)) ?? null;
            if (!mounted.current) return;
            if (!image) {
                setPhase({ kind: "error", message: "There is no video frame at the playhead to start from.", credits: false });
                return;
            }
        }
        const onProgress = (update: AiRunProgress) => {
            if (mounted.current && !run.signal.aborted) setPhase({ kind: "running", progress: update.progress ?? null, message: update.message ?? "Generating" });
        };
        const result = await controller.execute({
            type: "ai.run",
            capability,
            input: image ? { ...input, image } : input,
            ...(place ? { placeAt: { kind: "insert-media", at: playhead } } : {}),
        }, { signal: run.signal, onProgress, toastOnError: false });
        if (!mounted.current) return;
        abort.current = null;
        if (result.ok) {
            const media = (result.output as { media?: unknown[] } | undefined)?.media ?? [];
            setPhase({ kind: "done", count: media.length, placed: result.createdClipIds?.length ?? 0 });
        } else if (result.cancelled) setPhase({ kind: "cancelled" });
        else {
            const message = result.error ?? "Generation failed.";
            setPhase({ kind: "error", message, credits: message.startsWith(CREDITS_PREFIX) });
        }
        if (provider?.info.id === "opennan") void account.refresh();
    };
    const cancel = () => abort.current?.abort();
    const close = () => {
        cancel();
        onClose();
    };
    const label = priceLabel(price);
    const primary = phase.kind === "done" ? "Generate another" : phase.kind === "error" ? "Try again" : GENERATE;

    return (
        <Dialog title={GENERATE} onClose={close} className="generate-dialog">
            <div className="generate-kinds" role="radiogroup" aria-label="What to generate">
                {(Object.keys(KINDS) as GenerateKind[]).map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={kind === value}
                        className="generate-kind"
                        disabled={running}
                        onClick={() => {
                            setKind(value);
                            setSeconds(null);
                            setPhase({ kind: "idle" });
                        }}
                    >
                        {KINDS[value].label}
                    </button>
                ))}
            </div>
            {!gate.available ? (
                <p className="captions-unavailable" role="note">{gate.message}</p>
            ) : (
                <>
                    <label className="field" htmlFor={fieldId}>
                        <span>{spec.field}</span>
                        <textarea
                            id={fieldId}
                            className="text-input generate-text"
                            data-autofocus
                            rows={4}
                            maxLength={4000}
                            value={description}
                            disabled={running}
                            placeholder={spec.placeholder}
                            onChange={(event) => setDescription(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void generate();
                            }}
                        />
                    </label>
                    {kind === "video" && captureFrame && (
                        <label className="generate-check">
                            <input type="checkbox" checked={fromFrame} disabled={running} onChange={(event) => setFromFrame(event.target.checked)} />
                            <span>Start from the frame at the playhead</span>
                        </label>
                    )}
                    <div className="generate-row">
                        {kind !== "sfx" && (
                            <label className="field">
                                <span>Model</span>
                                <select className="text-input captions-select" value={model ?? ""} disabled={running || models.length === 0} onChange={(event) => setModel(event.target.value)}>
                                    {models.length === 0 && <option value="">Default</option>}
                                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                            </label>
                        )}
                        {kind === "voice" && (
                            <label className="field">
                                <span>Voice</span>
                                <select className="text-input captions-select" aria-label="Voice" value={voice ?? ""} disabled={running || voices.length === 0} onChange={(event) => setVoice(event.target.value)}>
                                    {voices.length === 0 && <option value="">Default</option>}
                                    {voices.map((v) => <option key={v.id} value={v.id}>{`${v.name} · ${v.language}${v.gender ? ` · ${v.gender}` : ""}`}</option>)}
                                </select>
                            </label>
                        )}
                        {durations.length > 0 && (
                            <label className="field">
                                <span>Length</span>
                                <select className="text-input captions-select" aria-label="Length" value={duration ?? ""} disabled={running} onChange={(event) => setSeconds(Number(event.target.value))}>
                                    {durations.map((d) => <option key={d} value={d}>{d} s</option>)}
                                </select>
                            </label>
                        )}
                    </div>
                    <div className="generate-row">
                        <div className="generate-options">
                            {kind === "music" && (
                                <label className="generate-check">
                                    <input type="checkbox" checked={instrumental} disabled={running} onChange={(event) => setInstrumental(event.target.checked)} />
                                    <span>Instrumental</span>
                                </label>
                            )}
                            <label className="generate-check">
                                <input type="checkbox" checked={place} disabled={running} onChange={(event) => setPlace(event.target.checked)} />
                                <span>Add to the timeline at the playhead</span>
                            </label>
                        </div>
                        <p className="muted small generate-meta">
                            {kind === "image" || kind === "video" ? `${aspectRatio} · ` : ""}{gate.providerName}{gate.providerId === "opennan" ? " · charged when it finishes, refunded if it fails" : ""}
                        </p>
                    </div>
                    {unavailable && <p className="captions-unavailable" role="note">{unavailable}</p>}
                    {!unavailable && unpriced && description.trim() && price?.kind === "unknown" && <p className="muted small" role="note">The price could not be read. Try again in a moment.</p>}
                </>
            )}
            {phase.kind === "running" && (
                <div className="captions-progress" role="status">
                    <progress max={1} value={phase.progress ?? undefined} aria-label="Generation progress" />
                    <span className="muted small">{phase.message}{phase.progress !== null ? ` ${Math.round(phase.progress * 100)}%` : ""}</span>
                </div>
            )}
            {phase.kind === "done" && (
                <p className="captions-done" role="status">
                    {phase.count === 0 ? "The provider returned nothing to add." : phase.placed > 0 ? "Added to Media and the timeline." : "Added to Media."}
                </p>
            )}
            {phase.kind === "cancelled" && <p className="muted small" role="status">Cancelled.</p>}
            {phase.kind === "error" && (
                <div className="generate-error" role="alert">
                    <p className="error-text">{phase.credits ? (phase.message.startsWith("Not enough credits:") ? phase.message : "Not enough credits.") : phase.message}</p>
                    {phase.credits && <button type="button" className="button small" onClick={() => account.openConsole("billing")}>Buy credits</button>}
                </div>
            )}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={running ? cancel : close}>{running ? "Cancel" : "Close"}</button>
                {gate.available && (
                    <button
                        type="button"
                        className="button primary"
                        data-testid="generate-run"
                        disabled={running || !description.trim() || Boolean(unavailable) || unpriced}
                        aria-label={label ? `${primary}, ${label.replace("≈ ", "about ")}` : primary}
                        onClick={() => void generate()}
                    >
                        {label ? `${label} · ${primary}` : primary}
                    </button>
                )}
            </div>
        </Dialog>
    );
}
