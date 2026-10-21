"use client";
// Graphics library (phase 10d): the built-in graphics templates (timeline-core graphics: lower thirds, titles,
// charts, callouts, social, shapes) as live thumbnails drawn by the same Canvas 2D code as the preview and both
// exports. A click adds a 4 s graphic at the playhead; a drag carries { kind: "remotion", templateId } to the
// timeline (nle-timeline's onTrackDrop), which lands it at the drop.
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { EditorStore, TimelineClip, TimelineController, TimelineTrack } from "@opennan/timeline-core";
import type { CreateClipInput } from "@opennan/timeline-core/backend/types";
import { GRAPHICS_FONT_FACES } from "@opennan/timeline-core/graphics/draw/helpers";
import { drawGraphicsFrame } from "@opennan/timeline-core/graphics/render";
import { GRAPHICS_TEMPLATES } from "@opennan/timeline-core/graphics/templates";
import type { GraphicsContext, GraphicsTemplateDef } from "@opennan/timeline-core/graphics/types";
import { roundTimelineTime } from "@opennan/timeline-core/lib/timeline-editing-shared";
import { nextTrackForType, resolveNonOverlappingTrackIndex } from "@opennan/timeline-core/lib/timeline-tracks";
import { defaultTracks, withRequiredBaseTimelineTracks } from "@opennan/timeline-core/timeline/scene-helpers";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { useTimelineToast } from "../../hooks/use-timeline-toast";
import { defaultPropsFor } from "../../remotion/templates";

/** Length of a graphic added from the library (the timeline's own graphics drop uses the same). */
export const GRAPHIC_SECONDS = 4;
export const GRAPHICS_CATEGORIES = ["text", "data", "callout", "social", "shape", "scene", "brand", "utility"] as const;
const THUMB_W = 160;
const THUMB_H = 90;
/** The template frame thumbnails show (settled entrance, before the exit). */
const THUMB_FRAME = 50;

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export interface GraphicsPlan {
    tracks: TimelineTrack[] | null;
    input: CreateClipInput;
}

/** Where a graphic lands: the first editable graphics track free at `at`, else a new graphics track. */
export function planGraphicsClip(
    timelineTracks: TimelineTrack[],
    clips: Pick<TimelineClip, "trackType" | "trackIndex" | "startTime" | "endTime">[],
    template: GraphicsTemplateDef,
    at: number,
): GraphicsPlan {
    const tracks = timelineTracks.length > 0 ? withRequiredBaseTimelineTracks(timelineTracks).tracks : defaultTracks;
    const start = roundTimelineTime(Math.max(0, at));
    const editable = tracks.filter((track) => track.type === "remotion" && !track.locked && track.visible !== false).sort((a, b) => a.index - b.index);
    const input = (trackIndex: number): CreateClipInput => ({
        trackType: "remotion",
        trackIndex,
        startTime: start,
        endTime: roundTimelineTime(start + GRAPHIC_SECONDS),
        label: template.name,
        remotionTemplateId: template.id,
        remotionPropsJson: JSON.stringify(defaultPropsFor(template.id)),
    });
    const free = resolveNonOverlappingTrackIndex(clips, "remotion", editable.map((track) => track.index), start, start + GRAPHIC_SECONDS);
    if (free !== null) return { tracks: null, input: input(free) };
    const added = nextTrackForType(tracks, "remotion") as TimelineTrack;
    return { tracks: [...tracks, added], input: input(added.index) };
}

/** Adds a built-in graphic at `at` and selects it: one `clip.create` (with a new track when needed), one undo step. */
export async function addGraphicsClip(controller: TimelineController, store: EditorStore, templateId: string, at: number): Promise<{ ok: true; clipId: string | null } | { ok: false }> {
    const template = GRAPHICS_TEMPLATES.find((entry) => entry.id === templateId);
    const timeline = store.getState().timelineData;
    if (!template || !timeline) return { ok: false };
    const plan = planGraphicsClip(timeline.tracks, timeline.clips, template, at);
    const created = await controller.execute({ type: "clip.create", input: plan.input, ...(plan.tracks ? { tracks: plan.tracks } : {}) }, { toastOnError: false });
    if (!created.ok) return { ok: false };
    const clipId = created.createdClipIds?.[0] ?? created.changed.clips?.[0] ?? null;
    if (clipId) store.getState().setSelectedClipIds(new Set([clipId]));
    return { ok: true, clipId };
}

let fontsReady: Promise<unknown> | null = null;
function graphicsFonts(): Promise<unknown> {
    if (fontsReady) return fontsReady;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fontsReady = fonts ? Promise.allSettled(GRAPHICS_FONT_FACES.map((face) => fonts.load(`${face.style} ${face.weight} 32px "${face.family}"`))) : Promise.resolve();
    return fontsReady;
}

function GraphicThumb({ template }: { template: GraphicsTemplateDef }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let alive = true;
        const draw = () => {
            const canvas = ref.current;
            const ctx = canvas?.getContext("2d");
            if (!canvas || !ctx || !alive) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawGraphicsFrame(ctx as unknown as GraphicsContext, {
                trackType: "remotion", startTime: 0, endTime: 4, remotionTemplateId: template.id, remotionPropsJson: null, remotionCode: null,
            }, { width: canvas.width, height: canvas.height, frame: THUMB_FRAME });
        };
        draw();
        void graphicsFonts().then(draw);
        return () => {
            alive = false;
        };
    }, [template.id]);
    return <canvas ref={ref} width={THUMB_W * 2} height={THUMB_H * 2} className="on-graphic-thumb" aria-hidden="true" />;
}

export function GraphicsTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<(typeof GRAPHICS_CATEGORIES)[number] | "all">("all");
    const shown = useMemo(() => {
        const q = fold(query);
        return GRAPHICS_TEMPLATES.filter((template) => (category === "all" || template.category === category)
            && (!q || fold(`${template.name} ${template.description} ${template.category}`).includes(q)));
    }, [query, category]);
    const add = (template: GraphicsTemplateDef) => {
        void addGraphicsClip(controller, storeApi, template.id, storeApi.getState().currentTime).then((result) => {
            if (!result.ok) toast.error(t("gfx_addFailed"));
        });
    };
    return (
        <div className="on-tabpanel on-graphics" data-testid="library-graphics">
            <div className="on-panel-head">
                <h2 className="on-panel-title">{t("gfx_tab")}</h2>
                <span className="on-count" aria-live="polite">{t("resultsCount", { n: shown.length })}</span>
            </div>
            <p className="on-panel-sub">{t("gfx_hint")}</p>
            <label className="on-search">
                <Search aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    placeholder={t("gfx_search")}
                    aria-label={t("gfx_search")}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && query) {
                            e.stopPropagation();
                            setQuery("");
                        }
                    }}
                />
            </label>
            <div className="on-chips" role="group" aria-label={t("categories")}>
                {(["all", ...GRAPHICS_CATEGORIES] as const).map((id) => (
                    <button key={id} type="button" className="on-chip" aria-pressed={category === id} onClick={() => setCategory(id)}>
                        {id === "all" ? t("categoryAll") : t(`gfx_cat_${id}` as never)}
                    </button>
                ))}
            </div>
            <div className="on-scroll">
                {shown.length === 0 ? (
                    <div className="on-empty">
                        <p className="on-sticker-empty-title">{t("gfx_empty")}</p>
                        <p className="on-sticker-empty-hint">{t("stk_emptyHint")}</p>
                    </div>
                ) : (
                    <ul className="on-graphic-grid">
                        {shown.map((template) => (
                            <li key={template.id}>
                                <button
                                    type="button"
                                    className="on-graphic"
                                    data-testid={`graphic-card-${template.id}`}
                                    title={template.description}
                                    aria-label={t("gfx_add", { name: template.name })}
                                    draggable
                                    onClick={() => add(template)}
                                    onDragStart={(e) => {
                                        e.dataTransfer.effectAllowed = "copy";
                                        e.dataTransfer.setData("application/json", JSON.stringify({ kind: "remotion", templateId: template.id, name: template.name }));
                                    }}
                                >
                                    <GraphicThumb template={template} />
                                    <span className="on-graphic-name">{template.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
