"use client";
// The inspector's AI tab (phase 11): the AI tools that fit the selected item, each a section with its options and a Run
// button that carries the host's price (ai-action-button.tsx), plus the free on-device tools (local-panels.tsx).
//   video clip / scene  Auto captions, Isolate voice, Split vocals, Remove background, Upscale, Lip sync, Stabilize,
//                       Remove silences, Remove filler words
//   audio clip          Auto captions, Isolate voice, Split vocals, Remove silences, Remove filler words, Detect beats
//   image clip          a pointer to AI › Video (image to video); background removal and upscale take video
//   text clip           Translate captions (the clip's track)
// Paid tools need the editor host (opennan.com sign-in, prices, the job queue); without it they are disabled with the
// reason and the local tools still work. Jobs running on the item show their tray rows at the top.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import {
    MATTING_BACKGROUNDS, aiMediaSource, planAiTool,
    type AiTargetRef, type AiToolId, type MattingBackground, type SceneData, type TimelineClip, type UpscaleResolution,
} from "@opennan/timeline-core";
import { useEditorStore } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { Section, Segmented, Toggle } from "../editing/controls";
import { AiActionButton } from "./ai-action-button";
import type { AiToolView } from "./ai-host";
import { AiJobTray } from "./ai-job-tray";
import { searchLanguages } from "./languages";
import { BeatsPanel, FillersPanel, SilencesPanel } from "./local-panels";
import { useAiHost } from "./use-ai";

type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;

export type AiItemKind = "video" | "scene" | "image" | "audio" | "text";

export interface AiItem {
    kind: AiItemKind;
    id: string;
    target: AiTargetRef;
    clip?: TimelineClip;
    scene?: SceneData;
}

export interface AiTabFocus {
    tool?: AiToolId;
    autoStart?: boolean;
    nonce: number;
}

/** The tools each item kind offers, in the tab's order (the context menu shows the same set). */
export const AI_TOOLS_BY_KIND: Record<AiItemKind, readonly AiToolId[]> = {
    video: ["captions", "voice-isolation", "stems", "remove-background", "video-upscale", "lipsync", "stabilize", "silences", "fillers"],
    scene: ["captions", "voice-isolation", "stems", "remove-background", "video-upscale", "lipsync", "stabilize", "silences", "fillers"],
    audio: ["captions", "voice-isolation", "stems", "silences", "fillers", "beats"],
    image: ["remove-background", "video-upscale"],
    text: ["caption-translate"],
};

/** The AI kind of a clip or scene, or null when no AI tool takes it (stickers, graphics, effects). */
export function aiItemKind(item: { clip?: TimelineClip; scene?: SceneData }): AiItemKind | null {
    if (item.scene) return "scene";
    const clip = item.clip;
    if (!clip) return null;
    if (clip.trackType === "audio") return "audio";
    if (clip.trackType === "text") return "text";
    if (clip.trackType === "video") return clip.mediaType === "image" ? "image" : "video";
    return null;
}

/** Upscale tiers and the short side they need; a video whose short side already reaches one gains nothing from it. */
export const UPSCALE_TIERS: ReadonlyArray<{ value: UpscaleResolution; shortSide: number }> = [
    { value: "1080p", shortSide: 1080 },
    { value: "2k", shortSide: 1440 },
    { value: "4k", shortSide: 2160 },
];

export function metUpscaleTiers(size: { width?: number; height?: number } | null): Set<UpscaleResolution> {
    const met = new Set<UpscaleResolution>();
    if (!size?.width || !size.height) return met;
    const short = Math.min(size.width, size.height);
    for (const tier of UPSCALE_TIERS) if (short >= tier.shortSide) met.add(tier.value);
    return met;
}

const sizeCache = new Map<string, { width: number; height: number } | null>();

/** The video's pixel size: the scene's recorded size, else read once from the file's metadata (null while unknown). */
function useVideoSize(url: string | null, known: { width?: number; height?: number } | null): { width: number; height: number } | null {
    const media = useTimelineMedia();
    const [size, setSize] = useState(() => (url ? sizeCache.get(url) ?? null : null));
    useEffect(() => {
        if (known?.width && known.height) return;
        if (!url || sizeCache.has(url) || typeof document === "undefined") return;
        const video = document.createElement("video");
        let done = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (done) return;
            done = true;
            sizeCache.set(url, value);
            setSize(value);
            video.removeAttribute("src");
            video.load?.();
        };
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
        video.onerror = () => finish(null);
        try {
            video.src = media.resolveMediaUrl(url);
        } catch {
            finish(null);
        }
        return () => {
            done = true;
        };
    }, [url, known?.width, known?.height, media]);
    if (known?.width && known.height) return { width: known.width, height: known.height };
    return size;
}

function ToolSection({ tool, title, focus, children }: { tool: AiToolId; title: string; focus?: AiTabFocus | null; children: ReactNode }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const focused = focus?.tool === tool;
    useEffect(() => {
        if (focused) ref.current?.scrollIntoView?.({ block: "nearest" });
    }, [focused, focus?.nonce]);
    return (
        <div ref={ref} className="on-ai-section" data-ai-tool={tool} data-focused={focused || undefined} data-testid={`ai-section-${tool}`}>
            <Section title={title}>{children}</Section>
        </div>
    );
}

export function AiTab({ item, focus }: { item: AiItem; focus?: AiTabFocus | null }) {
    const t = useTimelineMessages("studioEditor");
    const host = useAiHost();
    const tools = AI_TOOLS_BY_KIND[item.kind];
    const target = item.target;
    const autoStart = (tool: AiToolId) => (focus?.tool === tool && focus.autoStart) || undefined;
    const section = (tool: AiToolId, title: string, body: ReactNode) => (
        <ToolSection key={tool} tool={tool} title={title} focus={focus}>{body}</ToolSection>
    );
    return (
        <div className="on-ai-tab" data-testid="ai-tab">
            {!host && <p className="on-hint" data-testid="ai-no-host">{t("ai_noHost")}</p>}
            <AiJobTray targetId={item.id} />
            {item.kind === "image" && <p className="on-hint" data-testid="ai-image-hint">{t("ai_imageHint")}</p>}
            {tools.map((tool) => {
                switch (tool) {
                    case "captions":
                        return section(tool, t("ai_captions"), <CaptionsBody t={t} target={target} />);
                    case "caption-translate":
                        return section(tool, t("ai_translate"), <TranslateBody t={t} clipId={item.id} />);
                    case "voice-isolation":
                        return section(tool, t("ai_isolate"), (
                            <>
                                <p className="on-ai-desc">{t("ai_isolateDesc")}</p>
                                <AiActionButton toolId={tool} params={target} testId="ai-run-voice-isolation" />
                            </>
                        ));
                    case "stems":
                        return section(tool, t("ai_stems"), <StemsBody t={t} target={target} />);
                    case "remove-background":
                        return section(tool, t("ai_background"), <BackgroundBody t={t} target={target} imageOnly={item.kind === "image"} />);
                    case "video-upscale":
                        return section(tool, t("ai_upscale"), <UpscaleBody t={t} item={item} />);
                    case "lipsync":
                        return section(tool, t("ai_lipsync"), <LipSyncBody t={t} target={target} />);
                    case "stabilize":
                        return section(tool, t("ai_stabilize"), (
                            <>
                                <p className="on-ai-desc">{t("ai_stabilizeDesc")}</p>
                                <AiActionButton toolId={tool} params={target} testId="ai-run-stabilize" />
                            </>
                        ));
                    case "silences":
                        return section(tool, t("ai_silences"), <SilencesPanel target={target} autoStart={autoStart(tool)} />);
                    case "fillers":
                        return section(tool, t("ai_fillers"), <FillersPanel target={target} />);
                    case "beats":
                        return item.clip ? section(tool, t("ai_beats"), <BeatsPanel clip={item.clip} autoStart={autoStart(tool)} />) : null;
                    default:
                        return null;
                }
            })}
        </div>
    );
}

function CaptionsBody({ t, target }: { t: Translate; target: AiTargetRef }) {
    const host = useAiHost();
    const controller = useTimelineController();
    const open = host?.openAutoCaptions;
    const desc = <p className="on-ai-desc">{t("ai_captionsDesc")}</p>;
    if (!open) return <>{desc}<AiActionButton toolId="captions" params={target} testId="ai-run-captions" /></>;
    // The host's dialog picks the engine (on this device or OpenNan cloud) and shows that engine's price.
    const plan = planAiTool(controller.snapshot(), "captions", target);
    return (
        <>
            {desc}
            <div className="on-ai-action" data-testid="ai-run-captions">
                <button type="button" className="on-btn on-btn-primary on-ai-run" data-testid="ai-run-captions-run" disabled={!plan.ok} onClick={() => open(target)}>
                    {t("ai_captionsOpen")}
                </button>
                {!plan.ok && <p className="on-ai-reason" data-testid="ai-run-captions-reason">{plan.error}</p>}
            </div>
        </>
    );
}

function TranslateBody({ t, clipId }: { t: Translate; clipId: string }) {
    const [query, setQuery] = useState("");
    const [language, setLanguage] = useState("");
    const [keepSource, setKeepSource] = useState(true);
    const selectId = useId();
    const matches = useMemo(() => searchLanguages(query), [query]);
    // The chosen language stays listed while the search hides it.
    const options = language && !matches.some((l) => l.code === language) ? [...searchLanguages(language).filter((l) => l.code === language), ...matches] : matches;
    return (
        <>
            <p className="on-ai-desc">{t("ai_translateDesc")}</p>
            <label className="on-search" style={{ margin: 0 }}>
                <Search aria-hidden="true" />
                <input type="search" value={query} placeholder={t("ai_translateSearch")} aria-label={t("ai_translateSearch")} data-testid="ai-translate-search" onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label className="on-field" htmlFor={selectId}>
                <span className="on-field-label">{t("ai_translateLanguage")}</span>
                <select id={selectId} className="on-ai-select" data-testid="ai-translate-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="">{t("ai_translateChoose")}</option>
                    {options.map((l) => <option key={l.code} value={l.code}>{l.name === l.native ? `${l.name} (${l.code})` : `${l.name} · ${l.native} (${l.code})`}</option>)}
                </select>
            </label>
            {matches.length === 0 && <p className="on-ai-note" data-testid="ai-translate-nomatch">{t("ai_translateNoMatch", { query })}</p>}
            <Toggle label={t("ai_translateKeep")} checked={keepSource} onChange={setKeepSource} />
            <AiActionButton toolId="caption-translate" params={{ clipId, ...(language ? { language } : {}), keepSource }} testId="ai-run-caption-translate" />
        </>
    );
}

function StemsBody({ t, target }: { t: Translate; target: AiTargetRef }) {
    const [stems, setStems] = useState<"vocals" | "all">("vocals");
    return (
        <>
            <p className="on-ai-desc">{t("ai_stemsDesc")}</p>
            <Segmented<"vocals" | "all"> testId="ai-stems-count" label={t("ai_stemsCount")} value={stems} options={[{ value: "vocals", label: t("ai_stems2") }, { value: "all", label: t("ai_stems4") }]} onChange={setStems} />
            <AiActionButton toolId="stems" params={{ ...target, stems }} testId="ai-run-stems" />
        </>
    );
}

function BackgroundBody({ t, target, imageOnly }: { t: Translate; target: AiTargetRef; imageOnly: boolean }) {
    const [background, setBackground] = useState<MattingBackground>("transparent");
    const videoOnly: AiToolView | undefined = imageOnly ? { id: "remove-background", state: "unavailable", reason: t("ai_videoOnly"), price: { kind: "unknown" } } : undefined;
    return (
        <>
            <p className="on-ai-desc">{t("ai_backgroundDesc")}</p>
            {!imageOnly && (
                <Segmented<MattingBackground>
                    testId="ai-background" label={t("ai_backgroundLabel")} value={background} onChange={setBackground}
                    options={MATTING_BACKGROUNDS.map((value) => ({ value, label: t(`ai_bg_${value}` as never) }))}
                />
            )}
            <AiActionButton toolId="remove-background" params={{ ...target, background }} view={videoOnly} testId="ai-run-remove-background" />
        </>
    );
}

function UpscaleBody({ t, item }: { t: Translate; item: AiItem }) {
    const controller = useTimelineController();
    const imageOnly = item.kind === "image";
    const source = imageOnly ? null : aiMediaSource(controller.snapshot(), item.target);
    const size = useVideoSize(source?.kind === "video" ? source.mediaUrl : null, source ? { width: source.width, height: source.height } : null);
    const met = metUpscaleTiers(size);
    const labels: Record<UpscaleResolution, string> = { "1080p": t("ai_res_1080p"), "2k": t("ai_res_2k"), "4k": t("ai_res_4k") };
    const firstOpen = UPSCALE_TIERS.find((tier) => !met.has(tier.value))?.value ?? null;
    const [chosen, setChosen] = useState<UpscaleResolution | null>(null);
    const resolution = chosen && !met.has(chosen) ? chosen : firstOpen ?? "4k";
    const allMet = firstOpen === null;
    const view: AiToolView | undefined = imageOnly
        ? { id: "video-upscale", state: "unavailable", reason: t("ai_videoOnly"), price: { kind: "unknown" } }
        : allMet ? { id: "video-upscale", state: "unavailable", reason: t("ai_upscaleAllMet"), price: { kind: "unknown" } } : undefined;
    return (
        <>
            <p className="on-ai-desc">{t("ai_upscaleDesc")}</p>
            {!imageOnly && (
                <Segmented<UpscaleResolution>
                    testId="ai-upscale-tier" label={t("ai_upscaleTier")} value={resolution} onChange={setChosen}
                    options={UPSCALE_TIERS.map((tier) => ({
                        value: tier.value, label: labels[tier.value], disabled: met.has(tier.value),
                        ...(met.has(tier.value) ? { title: t("ai_upscaleMet", { tier: labels[tier.value] }) } : {}),
                    }))}
                />
            )}
            <AiActionButton toolId="video-upscale" params={{ ...item.target, resolution }} view={view} testId="ai-run-video-upscale" />
        </>
    );
}

const EMPTY_CLIPS: TimelineClip[] = [];

function LipSyncBody({ t, target }: { t: Translate; target: AiTargetRef }) {
    const clips = useEditorStore((s) => s.timelineData?.clips ?? EMPTY_CLIPS);
    const audio = useMemo(() => clips.filter((c) => c.trackType === "audio" && Boolean(c.mediaUrl)).sort((a, b) => a.trackIndex - b.trackIndex || a.startTime - b.startTime), [clips]);
    const [audioClipId, setAudioClipId] = useState("");
    const selectId = useId();
    const picked = audio.some((c) => c.id === audioClipId) ? audioClipId : "";
    return (
        <>
            <p className="on-ai-desc">{t("ai_lipsyncDesc")}</p>
            {audio.length === 0 ? (
                <p className="on-ai-note" data-testid="ai-lipsync-none">{t("ai_lipsyncNone")}</p>
            ) : (
                <label className="on-field" htmlFor={selectId}>
                    <span className="on-field-label">{t("ai_lipsyncAudio")}</span>
                    <select id={selectId} className="on-ai-select" data-testid="ai-lipsync-audio" value={picked} onChange={(e) => setAudioClipId(e.target.value)}>
                        <option value="">{t("ai_lipsyncChoose")}</option>
                        {audio.map((c) => <option key={c.id} value={c.id}>{`A${c.trackIndex} · ${c.label || t("itemAudio")} · ${c.startTime.toFixed(1)} s`}</option>)}
                    </select>
                </label>
            )}
            <AiActionButton toolId="lipsync" params={{ ...target, ...(picked ? { audioClipId: picked } : {}) }} testId="ai-run-lipsync" />
        </>
    );
}
