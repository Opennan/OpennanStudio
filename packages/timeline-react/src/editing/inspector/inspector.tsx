"use client";
// The right column, always visible: project settings with nothing selected; Video / Animation / Adjust /
// Filter / Effects / Speed / Audio for a clip or a main-track scene (Text / Animation for text clips);
// duration and type for a transition. Every control writes one controller command (sliders coalesce a
// drag into one undo step). Keyframable properties carry a diamond (keyframe-toggle.tsx).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
    ArrowDown, ArrowUp, AudioLines, Clapperboard, Film, Globe, Image as ImageIcon, LayoutTemplate, Sparkles, Trash2, Type, Wand2, ArrowLeftRight,
} from "lucide-react";
import { selectLiveScenes, timelineDurationSeconds, type SceneData, type TimelineClip, type TimelineTrack } from "@opennan/timeline-core";
import { sceneJunctions } from "@opennan/timeline-core/lib/scene-transitions";
import { clipJunction } from "@opennan/timeline-core/looks/windows";
import { looksCatalog } from "@opennan/timeline-core/looks/catalog";
import { effectById, effectParams } from "@opennan/timeline-core/looks/effects";
import { DEFAULT_FILTER_INTENSITY, normalizeFilterId } from "@opennan/timeline-core/looks/filters";
import { itemFilterIntensity } from "@opennan/timeline-core/looks/look-plan";
import { MIN_TRANSITION_SECONDS, transitionById } from "@opennan/timeline-core/looks/transitions";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing-navigation";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { POINTWISE_ADJUSTMENTS, itemAdjustments } from "@opennan/timeline-core/looks/adjust";
import { clipSpeedProfile, sceneSpeedProfile } from "@opennan/timeline-core/motion/speed";
import { motionTarget } from "@opennan/timeline-core/motion/transform";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core/timeline/scene-timing";
import { ClipProperties } from "../../clip-properties";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { AdjustControls, type AdjustKeyframes } from "../adjust-controls";
import { Section, Segmented, SliderRow, Toggle } from "../controls";
import { lookTargetOf, useSelectionTarget, type LookTarget } from "../selection";
import { AnimationTab } from "./animation-tab";
import { MaskTab } from "./mask-tab";
import { TrackTab } from "./track-tab";
import { KeyframeBar, KeyframeToggle, KeyframedSliders, useKeyframeGroup, type KeyItem } from "./keyframe-toggle";
import { KeyframeGraphDrawer } from "./keyframe-graph";
import { SpeedTab } from "./speed-tab";
import { hasReadOnlyShots } from "../read-only-shots";
import { StoryboardSection } from "./storyboard-section";
import { GroupInspector } from "./group-inspector";
import { useGroupSelection } from "../multi-selection";
import { AttributeHeadActions } from "../attributes/attribute-head-actions";
import { AiTab, aiItemKind, type AiTabFocus } from "../../ai/ai-tab";
import { peekInspectorAiRequest, useInspectorAiRequest, type InspectorAiRequest } from "../../ai/inspector-request";


const CATALOG = looksCatalog();
// Stable empties: a fresh [] from a store selector re-renders forever.
const EMPTY_CLIPS: TimelineClip[] = [];
const EMPTY_TRACKS: TimelineTrack[] = [];
type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;

function Head({ icon: Icon, title, kind, actions }: { icon: typeof Film; title: string; kind: string; actions?: ReactNode }) {
    return (
        <div className="on-inspector-head">
            <span className="on-inspector-icon"><Icon aria-hidden="true" /></span>
            <div style={{ minWidth: 0 }}>
                <p className="on-inspector-title">{title}</p>
                <p className="on-inspector-kind">{kind}</p>
            </div>
            {actions}
        </div>
    );
}

/**
 * `shotsEditUrl`: where the open project's shots made on opennan.com are edited (the host's link to the project on
 * opennan.com); scenes with such shots show a badge with it.
 */
export function Inspector({ className, shotsEditUrl }: { className?: string; shotsEditUrl?: string | null }) {
    const t = useTimelineMessages("studioEditor");
    const selection = useSelectionTarget();
    // Two or more selected clips and scenes: the group mode (phase 10c) replaces the single-item inspector.
    const group = useGroupSelection();
    if (group) {
        return (
            <div className={`on-editing on-inspector ${className ?? ""}`} data-testid="inspector" aria-label={t("inspectorLabel")}>
                <GroupInspector t={t} group={group} />
            </div>
        );
    }
    return (
        <div className={`on-editing on-inspector ${className ?? ""}`} data-testid="inspector" aria-label={t("inspectorLabel")}>
            {selection === null && <ProjectInspector t={t} />}
            {selection?.kind === "transition" && <TransitionInspector t={t} selected={selection.transition} />}
            {selection?.kind === "scene" && <ItemInspector key={selection.scene.id} t={t} scene={selection.scene} shotsEditUrl={shotsEditUrl ?? null} />}
            {selection?.kind === "clip" && <ClipInspector key={selection.clip.id} t={t} clip={selection.clip} />}
        </div>
    );
}

// ── project ──────────────────────────────────────────────

const RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;

function ProjectInspector({ t }: { t: Translate }) {
    const controller = useTimelineController();
    const project = useEditorStore((s) => s.projectMeta);
    const scenes = useEditorStore((s) => selectLiveScenes(s));
    const clips = useEditorStore((s) => s.timelineData?.clips ?? EMPTY_CLIPS);
    const [name, setName] = useState(project?.name ?? "");
    useEffect(() => setName(project?.name ?? ""), [project?.name]);
    const duration = useMemo(() => timelineDurationSeconds({ scenes, clips }), [scenes, clips]);
    const commitName = () => {
        const next = name.trim();
        if (next && next !== project?.name) void controller.execute({ type: "project.update", patch: { name: next } });
    };
    return (
        <>
            <Head icon={LayoutTemplate} title={project?.name ?? t("project")} kind={t("project")} />
            <div className="on-inspector-body" data-testid="inspector-project">
                <label className="on-field">
                    <span className="on-field-label">{t("projectName")}</span>
                    <input className="on-text-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
                </label>
                <Segmented
                    label={t("aspectRatio")}
                    value={(project?.aspectRatio ?? "16:9") as (typeof RATIOS)[number]}
                    options={RATIOS.map((r) => ({ value: r, label: r }))}
                    onChange={(aspectRatio) => void controller.execute({ type: "project.update", patch: { aspectRatio } })}
                />
                <div className="on-row-between">
                    <span className="on-field-label">{t("projectDuration")}</span>
                    <span className="on-field-value">{t("seconds", { value: Number.isFinite(duration) ? duration.toFixed(1) : "0.0" })}</span>
                </div>
                <p className="on-hint">{t("projectItems", { scenes: scenes.length, clips: clips.length })}</p>
                <p className="on-hint">{t("nothingSelectedHint")}</p>
            </div>
        </>
    );
}

// ── transition ───────────────────────────────────────────

function TransitionInspector({ t, selected }: { t: Translate; selected: { kind: "clip" | "scene"; id: string } }) {
    const controller = useTimelineController();
    const scenes = useEditorStore((s) => selectLiveScenes(s));
    const tracks = useEditorStore((s) => s.timelineData?.tracks ?? EMPTY_TRACKS);
    const clip = useEditorStore((s) => (selected.kind === "clip" ? s.timelineData?.clips.find((c) => c.id === selected.id) ?? null : null));
    const scene = selected.kind === "scene" ? scenes.find((s) => s.id === selected.id) ?? null : null;
    const junction = selected.kind === "scene" ? sceneJunctions(scenes, tracks).find((j) => j.sceneId === selected.id) ?? null : null;
    const type = normalizeTimelineTransitionType((scene ? scene.visualTransition : clip?.transitionType) ?? "none");
    const duration = Number((scene ? scene.visualTransitionDuration : clip?.transitionDuration) ?? 0) || 0;
    // Upper-track clip cuts follow the scene rule (phase 10b): 2 s and both neighbours.
    const clips = useEditorStore((s) => s.timelineData?.clips);
    const clipCut = clip && clips ? clipJunction(clips, clip.id) : null;
    const max = junction?.maxDuration ?? (clipCut?.outgoingId === clip?.id ? clipCut?.maxDuration : undefined) ?? (clip ? (clip.endTime - clip.startTime) / 2 : 2);
    const target = selected.kind === "scene" ? { sceneId: selected.id } : { clipId: selected.id };
    const set = (transition: string, seconds?: number) => void controller.execute({ type: "transition.set", ...target, transition, ...(seconds !== undefined ? { duration: seconds } : {}) });
    const def = transitionById(type);
    return (
        <>
            <Head icon={ArrowLeftRight} title={def ? t(`tr_${def.id}` as never) : t("none")} kind={t("transition")} />
            <div className="on-inspector-body" data-testid="inspector-transition">
                {def && (
                    <Section title={t("duration")}>
                        <SliderRow
                            testId="transition-duration"
                            label={t("duration")}
                            value={Math.round(duration * 10) / 10}
                            min={MIN_TRANSITION_SECONDS}
                            max={Math.max(MIN_TRANSITION_SECONDS, Math.round(max * 10) / 10)}
                            step={0.1}
                            defaultValue={def.defaultDuration}
                            format={(v) => t("seconds", { value: v.toFixed(1) })}
                            onChange={(v) => void controller.execute({ type: "transition.set", ...target, transition: type, duration: v }, { coalesceKey: `transition-${selected.id}`, debounceMs: 120 })}
                        />
                        <p className="on-hint">{t("transitionDurationHint", { seconds: max.toFixed(1) })}</p>
                    </Section>
                )}
                <Section title={t("tabTransitions")}>
                    <div className="on-chips" style={{ flexWrap: "wrap", padding: 0, overflow: "visible" }}>
                        {CATALOG.transitions.map((tr) => (
                            <button key={tr.id} type="button" className="on-chip" aria-pressed={type === tr.id} onClick={() => set(tr.id)}>{t(`tr_${tr.id}` as never)}</button>
                        ))}
                    </div>
                </Section>
                <div className="on-row">
                    {def && selected.kind === "scene" && (
                        <button type="button" className="on-btn" data-testid="transition-apply-all" onClick={() => void controller.execute({ type: "transition.applyAll", transition: type, duration })}>{t("applyToAll")}</button>
                    )}
                    {def && <button type="button" className="on-btn on-btn-ghost" onClick={() => set("none")}><Trash2 aria-hidden="true" />{t("transitionRemove")}</button>}
                </div>
            </div>
        </>
    );
}

// ── clips and scenes ─────────────────────────────────────

type ItemTab = "video" | "animation" | "mask" | "track" | "adjust" | "filter" | "effects" | "speed" | "audio" | "ai";

const focusOf = (request: InspectorAiRequest | null): AiTabFocus | null => (request ? { tool: request.tool, autoStart: request.autoStart, nonce: request.nonce } : null);

/**
 * The AI tab (phase 11) opens when the timeline's menu asks for it (Upscale…, Remove silences…): at mount when the request
 * was waiting for this item, or later while the inspector is open.
 */
function useAiTabRequest<T extends string>(itemId: string, hasAi: boolean, setTab: (tab: T) => void) {
    const storeApi = useEditorStoreApi();
    const [focus, setFocus] = useState<AiTabFocus | null>(() => (hasAi ? focusOf(peekInspectorAiRequest(storeApi, itemId)) : null));
    useInspectorAiRequest(storeApi, itemId, (request) => {
        if (!hasAi) return;
        setTab("ai" as T);
        setFocus(focusOf(request));
    });
    return { focus };
}

/** Motion tracking (phase 10d) needs one video: a video clip, or a scene with its own video (not shot by shot). */
function trackable(scene: SceneData | undefined, clip: TimelineClip | undefined): boolean {
    if (scene) return Boolean(scene.videoUrl || (scene.cardType === "source_clip" && scene.sourceVideoUrl));
    return Boolean(clip && clip.trackType === "video" && clip.mediaType !== "image" && clip.mediaUrl && !clip.freezeFrame);
}
type TextTab = "text" | "animation" | "mask" | "ai";

function ClipInspector({ t, clip }: { t: Translate; clip: TimelineClip }) {
    if (clip.trackType === "video" || clip.trackType === "sticker" || clip.trackType === "audio") return <ItemInspector t={t} clip={clip} />;
    if (clip.trackType === "text") return <TextInspector t={t} clip={clip} />;
    if (clip.trackType === "remotion") return <GraphicsInspector t={t} clip={clip} />;
    // Effect layers keep their full property editor.
    const icon = clip.trackType === "effect" ? Wand2 : Sparkles;
    const kind = clip.trackType === "effect" ? t("itemEffect") : clip.trackType;
    return (
        <>
            <Head icon={icon} title={clip.label || clip.textContent || kind} kind={kind} />
            <div className="on-inspector-body" style={{ padding: 0 }}>
                <ClipProperties clipId={clip.id} />
            </div>
        </>
    );
}

/** Text clips: the full text editor and, beside it, the text animations (In / Out / Loop) and the mask (phase 10d). */
function TextInspector({ t, clip }: { t: Translate; clip: TimelineClip }) {
    const storeApi = useEditorStoreApi();
    const [tab, setTab] = useState<TextTab>(() => (peekInspectorAiRequest(storeApi, clip.id) ? "ai" : "text"));
    const ai = useAiTabRequest<TextTab>(clip.id, true, setTab);
    const keyItem = useKeyItem(undefined, clip);
    const graphOpen = useEditorStore((s) => s.keyframeGraph.open);
    const title = clip.label || clip.textContent || t("itemText");
    const labels: Record<TextTab, string> = { text: t("tabText"), animation: t("anim_tab"), mask: t("tabMask"), ai: t("tabAi") };
    return (
        <>
            <Head icon={Type} title={title} kind={t("itemText")} actions={<AttributeHeadActions item={{ kind: "clip", clip }} />} />
            <div className="on-tabs" role="tablist" aria-label={title}>
                {(["text", "animation", "mask", "ai"] as const).map((id) => (
                    <button key={id} type="button" role="tab" className="on-tab" aria-selected={tab === id} data-testid={`inspector-tab-${id}`} onClick={() => setTab(id)}>{labels[id]}</button>
                ))}
            </div>
            {graphOpen && <KeyframeGraphDrawer item={keyItem} kind="clip" />}
            {tab === "text" && (
                <div className="on-inspector-body" role="tabpanel" style={{ padding: 0 }} data-testid="inspector-panel-text">
                    <ClipProperties clipId={clip.id} />
                </div>
            )}
            {tab === "animation" && (
                <div className="on-inspector-body" role="tabpanel" data-testid="inspector-panel-animation">
                    <AnimationTab item={{ id: clip.id, target: { clipId: clip.id }, animationJson: clip.animationJson, duration: Math.max(0, clip.endTime - clip.startTime) }} kind="text" />
                </div>
            )}
            {tab === "mask" && (
                <div className="on-inspector-body" role="tabpanel" data-testid="inspector-panel-mask">
                    <MaskTab item={{ id: clip.id, target: { clipId: clip.id }, maskJson: clip.maskJson }} keyItem={keyItem} />
                </div>
            )}
            {tab === "ai" && (
                <div className="on-inspector-body" role="tabpanel" data-testid="inspector-panel-ai">
                    <AiTab item={{ kind: "text", id: clip.id, target: { clipId: clip.id }, clip }} focus={ai.focus} />
                </div>
            )}
        </>
    );
}

type GraphicsTab = "graphics" | "video" | "animation";

/**
 * Graphics clips (phase 10c): the template editor, the transform with keyframe diamonds (position, scale, rotation,
 * opacity), and clip animations, like other visual clips.
 */
function GraphicsInspector({ t, clip }: { t: Translate; clip: TimelineClip }) {
    const [tab, setTab] = useState<GraphicsTab>("graphics");
    const keyItem = useKeyItem(undefined, clip);
    const graphOpen = useEditorStore((s) => s.keyframeGraph.open);
    const title = clip.label || t("itemGraphics");
    const labels: Record<GraphicsTab, string> = { graphics: t("tabGraphics"), video: t("tabVideo"), animation: t("anim_tab") };
    return (
        <>
            <Head icon={Sparkles} title={title} kind={t("itemGraphics")} actions={<AttributeHeadActions item={{ kind: "clip", clip }} />} />
            <div className="on-tabs" role="tablist" aria-label={title}>
                {(["graphics", "video", "animation"] as const).map((id) => (
                    <button key={id} type="button" role="tab" className="on-tab" aria-selected={tab === id} data-testid={`inspector-tab-${id}`} onClick={() => setTab(id)}>{labels[id]}</button>
                ))}
            </div>
            {graphOpen && <KeyframeGraphDrawer item={keyItem} kind="clip" />}
            {tab === "graphics" && (
                <div className="on-inspector-body" role="tabpanel" style={{ padding: 0 }} data-testid="inspector-panel-graphics">
                    <ClipProperties clipId={clip.id} />
                </div>
            )}
            {tab === "video" && (
                <div className="on-inspector-body" role="tabpanel" data-testid="inspector-panel-video">
                    <ClipVideoTab t={t} clip={clip} keyItem={keyItem} transformOnly />
                </div>
            )}
            {tab === "animation" && (
                <div className="on-inspector-body" role="tabpanel" data-testid="inspector-panel-animation">
                    <AnimationTab item={{ id: clip.id, target: { clipId: clip.id }, animationJson: clip.animationJson, duration: Math.max(0, clip.endTime - clip.startTime) }} kind="clip" />
                </div>
            )}
        </>
    );
}

/** The selected clip or scene as the keyframe rows see it: target, timeline start, length, parsed points. */
function useKeyItem(scene: SceneData | undefined, clip: TimelineClip | undefined): KeyItem {
    const scenes = useEditorStore((s) => (scene ? selectLiveScenes(s) : null));
    const json = (scene ?? clip)?.keyframesJson ?? null;
    const points = useMemo(() => parseTimelineKeyframes(json), [json]);
    if (scene) {
        const index = scenes ? scenes.findIndex((s) => s.id === scene.id) : -1;
        const start = scenes && index >= 0 ? getSceneStart(scene, scenes, index) : Number(scene.timelinePositionSeconds) || 0;
        return { id: scene.id, target: { sceneId: scene.id }, start, duration: getSceneDuration(scene), points };
    }
    return { id: clip!.id, target: { clipId: clip!.id }, start: clip!.startTime, duration: Math.max(0, clip!.endTime - clip!.startTime), points };
}

function WebShotsBadge({ t, href }: { t: Translate; href: string | null }) {
    return (
        <div className="on-web-shots" role="note" data-testid="inspector-web-shots">
            <Globe aria-hidden="true" />
            <span>{t("shotsMadeOnWeb")}</span>
            {href && <a className="on-web-shots-link" href={href} target="_blank" rel="noopener noreferrer">{t("shotsOpenOnWeb")}</a>}
        </div>
    );
}

function ItemInspector({ t, scene, clip, shotsEditUrl = null }: { t: Translate; scene?: SceneData; clip?: TimelineClip; shotsEditUrl?: string | null }) {
    const isAudio = clip?.trackType === "audio";
    const isImage = clip ? clip.trackType === "sticker" || clip.mediaType === "image" : false;
    // Masks: scenes, video and image clips (phase 10c), and stickers (phase 10d).
    const isSticker = clip?.trackType === "sticker";
    const canTrack = !isAudio && !isImage && trackable(scene, clip);
    // AI tools (phase 11) take scenes and video, image, and audio clips; not stickers.
    const aiKind = aiItemKind({ scene, clip });
    const ai: ItemTab[] = aiKind ? ["ai"] : [];
    const tabs: ItemTab[] = isAudio
        ? ["audio", "speed", ...ai]
        : scene
            ? ["video", "animation", "mask", ...(canTrack ? ["track" as const] : []), "adjust", "filter", "effects", "speed", ...ai]
            : isSticker
                ? ["video", "animation", "mask", "adjust", "filter", "effects"]
                : isImage
                    ? ["video", "animation", "mask", "adjust", "filter", "effects", ...ai]
                    : ["video", "animation", "mask", ...(canTrack ? ["track" as const] : []), "adjust", "filter", "effects", "speed", "audio", ...ai];
    const itemId = (scene ?? clip)!.id;
    const storeApi = useEditorStoreApi();
    const [tab, setTab] = useState<ItemTab>(() => (aiKind && peekInspectorAiRequest(storeApi, itemId) ? "ai" : tabs[0]));
    const aiRequest = useAiTabRequest<ItemTab>(itemId, Boolean(aiKind), setTab);
    const target: LookTarget | null = scene ? { sceneId: scene.id } : lookTargetOf(clip ? { kind: "clip", clip } : null);
    const item = (scene ?? clip)!;
    const keyItem = useKeyItem(scene, clip);
    const graphOpen = useEditorStore((s) => s.keyframeGraph.open);
    const title = scene ? scene.caption || t("itemScene") : clip!.label || t(isAudio ? "itemAudio" : isImage ? "itemImage" : "itemVideo");
    const icon = scene ? Clapperboard : isAudio ? AudioLines : isImage ? ImageIcon : Film;
    const labels: Record<ItemTab, string> = {
        video: t("tabVideo"), animation: t("anim_tab"), mask: t("tabMask"), track: t("tabTrack"), adjust: t("tabAdjust"), filter: t("tabFilter"), effects: t("tabEffects"), speed: t("tabSpeed"), audio: t("tabAudio"),
        ai: t("tabAi"),
    };
    const animationKind = clip ? motionTarget({ kind: "clip", clip }) : "clip";
    return (
        <>
            <Head
                icon={icon} title={title} kind={scene ? t("itemScene") : t(isAudio ? "itemAudio" : isImage ? "itemImage" : "itemVideo")}
                actions={<AttributeHeadActions item={scene ? { kind: "scene", scene } : { kind: "clip", clip: clip! }} />}
            />
            {scene && hasReadOnlyShots(scene) && <WebShotsBadge t={t} href={shotsEditUrl} />}
            {scene && <StoryboardSection scene={scene} />}
            <div className="on-tabs" role="tablist" aria-label={title}>
                {tabs.map((id) => (
                    <button key={id} type="button" role="tab" className="on-tab" aria-selected={tab === id} data-testid={`inspector-tab-${id}`} onClick={() => setTab(id)}>{labels[id]}</button>
                ))}
            </div>
            {graphOpen && <KeyframeGraphDrawer item={keyItem} kind={scene ? "scene" : "clip"} />}
            <div className="on-inspector-body" role="tabpanel" key={tab} data-testid={`inspector-panel-${tab}`}>
                {tab === "video" && (scene ? <SceneVideoTab t={t} scene={scene} keyItem={keyItem} /> : <ClipVideoTab t={t} clip={clip!} keyItem={keyItem} />)}
                {tab === "animation" && (
                    <AnimationTab item={{ id: keyItem.id, target: keyItem.target, animationJson: item.animationJson, duration: keyItem.duration }} kind={animationKind === "text" ? "clip" : animationKind} />
                )}
                {tab === "mask" && <MaskTab item={{ id: keyItem.id, target: keyItem.target, maskJson: item.maskJson }} keyItem={keyItem} />}
                {tab === "track" && <TrackTab tracked={{ owner: keyItem.target, start: keyItem.start, duration: keyItem.duration, item }} />}
                {tab === "adjust" && target && <AdjustTab target={target} item={item} keyItem={keyItem} />}
                {tab === "filter" && target && <FilterTab t={t} target={target} item={item} keyItem={keyItem} />}
                {tab === "effects" && target && <EffectsStack t={t} target={target} item={item} />}
                {tab === "speed" && (
                    <SpeedTab item={{ id: keyItem.id, target: keyItem.target, profile: scene ? sceneSpeedProfile(scene) : clipSpeedProfile(clip!), duration: keyItem.duration }}>
                        {clip && !isAudio && <ClipSpeedToggles t={t} clip={clip} />}
                    </SpeedTab>
                )}
                {tab === "audio" && clip && <AudioTab t={t} clip={clip} keyItem={keyItem} />}
                {tab === "ai" && aiKind && <AiTab item={{ kind: aiKind, id: itemId, target: keyItem.target, clip, scene }} focus={aiRequest.focus} />}
            </div>
        </>
    );
}

const percent = (t: Translate) => (v: number) => t("percent", { value: v });
const same = (v: number) => v;

function SceneVideoTab({ t, scene, keyItem }: { t: Translate; scene: SceneData; keyItem: KeyItem }) {
    const controller = useTimelineController();
    const update = (patch: Partial<SceneData>, key: string) => void controller.execute({ type: "scene.update", sceneId: scene.id, patch }, { coalesceKey: `scene-${scene.id}-${key}`, debounceMs: 120 });
    return (
        <>
            <KeyframeBar item={keyItem} />
            <Segmented
                label={t("fit")}
                value={(scene.fitMode ?? "contain") as "contain" | "cover" | "fill"}
                options={(["contain", "cover", "fill"] as const).map((v) => ({ value: v, label: t(`fit_${v}` as never) }))}
                onChange={(fitMode) => update({ fitMode }, "fit")}
            />
            <KeyframedSliders item={keyItem} name="scale" label={t("scale")} rows={[{
                channel: "scale", base: Number(scene.transformScale ?? 1) || 1, label: t("scale"), testId: "scene-scale", min: 10, max: 300, defaultValue: 100, format: percent(t),
                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ transformScale: v / 100 }, "scale"),
            }]} />
            <KeyframedSliders item={keyItem} name="position" label={t("kf_position")} rows={[
                {
                    channel: "position_x", base: Number(scene.transformOffsetX ?? 0) || 0, label: t("positionX"), testId: "scene-position-x", min: -100, max: 100, defaultValue: 0, format: percent(t),
                    toSlider: Math.round, toChannel: same, onStatic: (v) => update({ transformOffsetX: v }, "x"),
                },
                {
                    channel: "position_y", base: Number(scene.transformOffsetY ?? 0) || 0, label: t("positionY"), testId: "scene-position-y", min: -100, max: 100, defaultValue: 0, format: percent(t),
                    toSlider: Math.round, toChannel: same, onStatic: (v) => update({ transformOffsetY: v }, "y"),
                },
            ]} />
            <KeyframedSliders item={keyItem} name="rotation" label={t("rotation")} rows={[{
                channel: "rotation_degrees", base: Number(scene.rotationDegrees ?? 0) || 0, label: t("rotation"), testId: "scene-rotation", min: -180, max: 180, defaultValue: 0, format: (v) => t("degrees", { value: v }),
                toSlider: Math.round, toChannel: same, onStatic: (v) => update({ rotationDegrees: v }, "rotation"),
            }]} />
            <KeyframedSliders item={keyItem} name="opacity" label={t("opacity")} rows={[{
                channel: "opacity", base: scene.opacity === null || scene.opacity === undefined ? 1 : Number(scene.opacity), label: t("opacity"), testId: "scene-opacity", min: 0, max: 100, defaultValue: 100, format: percent(t),
                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ opacity: v / 100 }, "opacity"),
            }]} />
        </>
    );
}

function ClipVideoTab({ t, clip, keyItem, transformOnly }: { t: Translate; clip: TimelineClip; keyItem: KeyItem; transformOnly?: boolean }) {
    const controller = useTimelineController();
    const update = (patch: Partial<TimelineClip>, key: string) => void controller.execute({ type: "clip.update", clipIds: [clip.id], patch }, { coalesceKey: `clip-${clip.id}-${key}`, debounceMs: 120 });
    return (
        <>
            <KeyframeBar item={keyItem} />
            <KeyframedSliders item={keyItem} name="scale" label={t("scale")} rows={[{
                channel: "scale", base: clip.scale, label: t("scale"), testId: "clip-scale", min: 10, max: 400, defaultValue: 100, format: percent(t),
                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ scale: v / 100 }, "scale"),
            }]} />
            <KeyframedSliders item={keyItem} name="position" label={t("kf_position")} rows={[
                {
                    channel: "position_x", base: clip.positionX, label: t("positionX"), testId: "clip-position-x", min: 0, max: 100, defaultValue: 50, format: percent(t),
                    toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ positionX: v / 100 }, "x"),
                },
                {
                    channel: "position_y", base: clip.positionY, label: t("positionY"), testId: "clip-position-y", min: 0, max: 100, defaultValue: 50, format: percent(t),
                    toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ positionY: v / 100 }, "y"),
                },
            ]} />
            <KeyframedSliders item={keyItem} name="rotation" label={t("rotation")} rows={[{
                channel: "rotation_degrees", base: clip.rotationDegrees, label: t("rotation"), testId: "clip-rotation", min: -180, max: 180, defaultValue: 0, format: (v) => t("degrees", { value: v }),
                toSlider: Math.round, toChannel: same, onStatic: (v) => update({ rotationDegrees: v }, "rotation"),
            }]} />
            <KeyframedSliders item={keyItem} name="opacity" label={t("opacity")} rows={[{
                channel: "opacity", base: clip.opacity, label: t("opacity"), testId: "clip-opacity", min: 0, max: 100, defaultValue: 100, format: percent(t),
                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ opacity: v / 100 }, "opacity"),
            }]} />
            {!transformOnly && <Segmented
                label={t("blendMode")}
                value={(clip.blendMode || "normal") as "normal" | "multiply" | "screen" | "overlay"}
                options={(["normal", "multiply", "screen", "overlay"] as const).map((v) => ({ value: v, label: t(`blend_${v}` as never) }))}
                onChange={(blendMode) => update({ blendMode }, "blend")}
            />}
            {!transformOnly && <Toggle label={t("flipH")} checked={clip.horizontalFlip} onChange={(horizontalFlip) => update({ horizontalFlip }, "flipH")} />}
            {!transformOnly && <Toggle label={t("flipV")} checked={clip.verticalFlip} onChange={(verticalFlip) => update({ verticalFlip }, "flipV")} />}
        </>
    );
}

/** Adjust with one diamond for the ten pointwise controls and the filter intensity (CapCut's Adjust keyframe). */
function AdjustTab({ target, item, keyItem }: { target: LookTarget; item: SceneData | TimelineClip; keyItem: KeyItem }) {
    const t = useTimelineMessages("studioEditor");
    const kind = "sceneId" in target ? "scene" : "clip";
    const values = itemAdjustments(item, kind);
    const hasFilter = normalizeFilterId(item.visualFilter) !== "none";
    const specs = [
        ...POINTWISE_ADJUSTMENTS.map((key) => ({ channel: `adj_${key}`, base: values[key] })),
        ...(hasFilter ? [{ channel: "filter_intensity", base: itemFilterIntensity(item) }] : []),
    ];
    const group = useKeyframeGroup(keyItem, specs, "adjust");
    const keyframes: AdjustKeyframes | undefined = group.keyed
        ? {
            values: Object.fromEntries(POINTWISE_ADJUSTMENTS.map((key) => [key, group.values[`adj_${key}`]])),
            disabled: !group.inside,
            onChange: (key, value) => (POINTWISE_ADJUSTMENTS.includes(key) ? group.write(`adj_${key}`, value) : false),
        }
        : undefined;
    return (
        <>
            <KeyframeBar item={keyItem} />
            <AdjustControls target={target} item={item} keyframes={keyframes} headerAction={<KeyframeToggle group={group} label={t("kf_adjust")} testId="kf-toggle-adjust" />} />
        </>
    );
}

function FilterTab({ t, target, item, keyItem }: { t: Translate; target: LookTarget; item: SceneData | TimelineClip; keyItem: KeyItem }) {
    const controller = useTimelineController();
    const current = normalizeFilterId(item.visualFilter);
    const intensity = current === "none" ? DEFAULT_FILTER_INTENSITY : itemFilterIntensity(item);
    const pick = (filter: string) => void controller.execute({ type: "look.set", ...target, filter, intensity });
    return (
        <>
            {current !== "none" && (
                <KeyframedSliders item={keyItem} name="filter" label={t("intensity")} rows={[{
                    channel: "filter_intensity", base: intensity, label: t("intensity"), testId: "inspector-filter-intensity", min: 0, max: 100,
                    defaultValue: Math.round(DEFAULT_FILTER_INTENSITY * 100), format: percent(t),
                    toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100,
                    onStatic: (v) => void controller.execute({ type: "look.set", ...target, intensity: v / 100 }, { coalesceKey: `intensity-${item.id}`, debounceMs: 120 }),
                }]} />
            )}
            {(["life", "movies", "retro", "bw", "food", "landscape"] as const).map((category) => (
                <Section key={category} title={t(`fltCat_${category}` as never)}>
                    <div className="on-chips" style={{ flexWrap: "wrap", padding: 0, overflow: "visible" }}>
                        {CATALOG.filters.filter((f) => f.category === category).map((f) => (
                            <button key={f.id} type="button" className="on-chip" aria-pressed={current === f.id} onClick={() => pick(current === f.id ? "none" : f.id)}>{t(`flt_${f.id}` as never)}</button>
                        ))}
                    </div>
                </Section>
            ))}
            {current !== "none" && <button type="button" className="on-btn on-btn-ghost" onClick={() => pick("none")}>{t("filterNone")}</button>}
        </>
    );
}

function EffectsStack({ t, target, item }: { t: Translate; target: LookTarget; item: SceneData | TimelineClip }) {
    const controller = useTimelineController();
    const rows = [...(item.effects ?? [])].sort((a, b) => a.order - b.order);
    if (rows.length === 0) return <p className="on-hint" data-testid="effects-empty">{t("effectsEmpty")}</p>;
    const move = (index: number, delta: number) => {
        const ids = rows.map((r) => r.id);
        const [moved] = ids.splice(index, 1);
        ids.splice(index + delta, 0, moved);
        void controller.execute({ type: "clip.effect.reorder", ...target, effectRowIds: ids });
    };
    return (
        <ul className="on-stack" data-testid="effects-stack">
            {rows.map((row, index) => {
                const effect = effectById(row.effectId);
                const name = effect ? t(`fx_${effect.id.replace(/^fx_/, "")}` as never) : row.effectId;
                const values = effect ? effectParams(effect, row.paramsJson) : {};
                return (
                    <li key={row.id} className="on-stack-item" data-disabled={!row.enabled || undefined} data-testid="effects-stack-item">
                        <div className="on-row-between">
                            <button type="button" role="switch" className="on-toggle" aria-checked={row.enabled} aria-label={t("toggleEffect", { name })} onClick={() => void controller.execute({ type: "clip.effect.update", effectRowId: row.id, patch: { enabled: !row.enabled } })} />
                            <span className="on-stack-name">{name}</span>
                            <button type="button" className="on-icon-btn" aria-label={t("moveUp", { name })} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></button>
                            <button type="button" className="on-icon-btn" aria-label={t("moveDown", { name })} disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></button>
                            <button type="button" className="on-icon-btn" data-danger="true" aria-label={t("removeEffect", { name })} onClick={() => void controller.execute({ type: "clip.effect.remove", effectRowId: row.id })}><Trash2 aria-hidden="true" /></button>
                        </div>
                        {effect && row.enabled && effect.params.filter((p) => p.type === "slider").map((param) => (
                            <SliderRow
                                key={param.key}
                                label={param.label}
                                value={Math.round(values[param.key] * 100) / 100}
                                min={param.min}
                                max={param.max}
                                step={(param.max - param.min) / 100}
                                defaultValue={param.default}
                                format={(v) => (param.max - param.min > 5 ? v.toFixed(0) : v.toFixed(2))}
                                onChange={(v) => void controller.execute(
                                    { type: "clip.effect.update", effectRowId: row.id, patch: { paramsJson: JSON.stringify({ ...values, [param.key]: v }) } },
                                    { coalesceKey: `fx-${row.id}-${param.key}`, debounceMs: 120 },
                                )}
                            />
                        ))}
                    </li>
                );
            })}
        </ul>
    );
}

/** Reverse and freeze stay clip fields (not part of the speed profile). */
function ClipSpeedToggles({ t, clip }: { t: Translate; clip: TimelineClip }) {
    const controller = useTimelineController();
    const update = (patch: Partial<TimelineClip>, key: string) => void controller.execute({ type: "clip.update", clipIds: [clip.id], patch }, { coalesceKey: `clip-${clip.id}-${key}`, debounceMs: 120 });
    return (
        <>
            <Toggle label={t("reverse")} checked={clip.reversePlayback} onChange={(reversePlayback) => update({ reversePlayback }, "reverse")} />
            <Toggle label={t("freeze")} checked={clip.freezeFrame} onChange={(freezeFrame) => update({ freezeFrame }, "freeze")} />
        </>
    );
}

function AudioTab({ t, clip, keyItem }: { t: Translate; clip: TimelineClip; keyItem: KeyItem }) {
    const controller = useTimelineController();
    const update = (patch: Partial<TimelineClip>, key: string) => void controller.execute({ type: "clip.update", clipIds: [clip.id], patch }, { coalesceKey: `clip-${clip.id}-${key}`, debounceMs: 120 });
    const length = Math.max(0, clip.endTime - clip.startTime);
    return (
        <>
            <KeyframeBar item={keyItem} />
            <KeyframedSliders item={keyItem} name="volume" label={t("volume")} rows={[{
                channel: "volume", base: clip.volume ?? 1, label: t("volume"), testId: "clip-volume", min: 0, max: 200, defaultValue: 100, format: percent(t),
                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => update({ volume: v / 100 }, "volume"),
            }]} />
            <SliderRow label={t("fadeIn")} value={Math.round((clip.fadeInDuration ?? 0) * 10) / 10} min={0} max={Math.max(0.1, Math.round((length / 2) * 10) / 10)} step={0.1} defaultValue={0} format={(v) => t("seconds", { value: v.toFixed(1) })} onChange={(v) => update({ fadeInDuration: v }, "fadeIn")} />
            <SliderRow label={t("fadeOut")} value={Math.round((clip.fadeOutDuration ?? 0) * 10) / 10} min={0} max={Math.max(0.1, Math.round((length / 2) * 10) / 10)} step={0.1} defaultValue={0} format={(v) => t("seconds", { value: v.toFixed(1) })} onChange={(v) => update({ fadeOutDuration: v }, "fadeOut")} />
        </>
    );
}
