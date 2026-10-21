"use client";
// Stickers library (CapCut layout): search, category chips, a square thumbnail grid of the bundled catalog
// (timeline-core/stickers). A click adds a centred 3 s sticker clip at the playhead; a drag carries
// { kind: "sticker", stickerId } to the timeline (nle-timeline's onTrackDrop), which lands it at the drop.
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { EditorStore, TimelineClip, TimelineController, TimelineTrack } from "@opennan/timeline-core";
import type { CreateClipInput } from "@opennan/timeline-core/backend/types";
import { resolveTimelineDropStart, roundTimelineTime } from "@opennan/timeline-core/lib/timeline-editing-shared";
import { nextTrackForType, resolveNonOverlappingTrackIndex } from "@opennan/timeline-core/lib/timeline-tracks";
import {
    STICKERS, STICKER_CATEGORIES, TWEMOJI_ATTRIBUTION, searchStickers, stickerById, stickerDataUrl,
    type Sticker, type StickerCategory,
} from "@opennan/timeline-core/stickers/catalog";
import { defaultTracks, withRequiredBaseTimelineTracks } from "@opennan/timeline-core/timeline/scene-helpers";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { useTimelineToast } from "../../hooks/use-timeline-toast";

/** Length of a sticker added from the library. */
export const STICKER_SECONDS = 3;
/** Drag marker type (readable during dragover, unlike the JSON payload). */
export const STICKER_DRAG_MIME = "application/x-sticker-id";
const THUMB_PX = 96;

/** "twemoji:1f60d" → "stk_n_twemoji_1f60d" (the studioEditor message holding the sticker's display name). */
export function stickerMessageKey(id: string): string {
    return `stk_n_${id.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

const thumbs = new Map<string, string>();
function thumbUrl(sticker: Sticker): string {
    let url = thumbs.get(sticker.id);
    if (!url) {
        const fit = THUMB_PX / Math.max(sticker.width, sticker.height);
        url = stickerDataUrl(sticker.id, { width: sticker.width * fit, height: sticker.height * fit }) ?? "";
        thumbs.set(sticker.id, url);
    }
    return url;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export interface StickerPlan {
    /** The full track list to write first (a new sticker track), or null when an existing track takes it. */
    tracks: TimelineTrack[] | null;
    input: CreateClipInput;
}

/**
 * Where a sticker lands. A drop on a sticker track (`preferredTrackIndex`) stays on it, shifted to the nearest
 * free spot; otherwise the first editable sticker track free at `at`, else a new sticker track (CapCut stacks a
 * new row rather than moving the sticker off the playhead). Null when the drop target is locked or full.
 */
export function planStickerClip(
    timelineTracks: TimelineTrack[],
    clips: Pick<TimelineClip, "trackType" | "trackIndex" | "startTime" | "endTime">[],
    stickerId: string,
    label: string,
    at: number,
    preferredTrackIndex?: number,
): StickerPlan | null {
    const tracks = timelineTracks.length > 0 ? withRequiredBaseTimelineTracks(timelineTracks).tracks : defaultTracks;
    const start = roundTimelineTime(Math.max(0, at));
    const editable = tracks
        .filter((track) => track.type === "sticker" && !track.locked && track.visible !== false)
        .sort((a, b) => a.index - b.index);
    const input = (trackIndex: number, startTime: number): CreateClipInput => ({
        trackType: "sticker",
        trackIndex,
        startTime: roundTimelineTime(startTime),
        endTime: roundTimelineTime(startTime + STICKER_SECONDS),
        mediaType: "sticker",
        stickerId,
        label,
        positionX: 0.5,
        positionY: 0.5,
        scale: 1,
        opacity: 1,
    });
    if (typeof preferredTrackIndex === "number" && preferredTrackIndex > 0) {
        const preferred = tracks.find((track) => track.type === "sticker" && track.index === preferredTrackIndex);
        if (preferred) {
            if (!editable.includes(preferred)) return null;
            const blockers = clips.filter((clip) => clip.trackType === "sticker" && clip.trackIndex === preferred.index);
            const resolved = resolveTimelineDropStart(start, STICKER_SECONDS, blockers);
            return resolved === null ? null : { tracks: null, input: input(preferred.index, resolved) };
        }
    }
    const free = resolveNonOverlappingTrackIndex(clips, "sticker", editable.map((track) => track.index), start, start + STICKER_SECONDS);
    if (free !== null) return { tracks: null, input: input(free, start) };
    const added = nextTrackForType(tracks, "sticker") as TimelineTrack;
    return { tracks: [...tracks, added], input: input(added.index, start) };
}

/**
 * Adds a bundled sticker at `at` and selects it: one `clip.create` (with the new track list when no sticker track is
 * free there), so adding a sticker is always one undo step; a failed create leaves no empty track.
 */
export async function addStickerClip(
    controller: TimelineController,
    store: EditorStore,
    stickerId: string,
    at: number,
    options: { preferredTrackIndex?: number; label?: string; position?: { x: number; y: number } } = {},
): Promise<{ ok: true; clipId: string | null } | { ok: false }> {
    const sticker = stickerById(stickerId);
    const timeline = store.getState().timelineData;
    if (!sticker || !timeline) return { ok: false };
    const plan = planStickerClip(timeline.tracks, timeline.clips, stickerId, options.label ?? sticker.name, at, options.preferredTrackIndex);
    if (!plan) return { ok: false };
    // `position`: positionX/Y (0..1 of the free space), e.g. a drop on the preview centred on the pointer.
    const input = options.position ? { ...plan.input, positionX: options.position.x, positionY: options.position.y } : plan.input;
    // A new sticker track (when none is free) and the clip land in one command: one undo step.
    const created = await controller.execute({ type: "clip.create", input, ...(plan.tracks ? { tracks: plan.tracks } : {}) }, { toastOnError: false });
    if (!created.ok) return { ok: false };
    const clipId = created.createdClipIds?.[0] ?? created.changed.clips?.[0] ?? null;
    if (clipId) store.getState().setSelectedClipIds(new Set([clipId]));
    return { ok: true, clipId };
}

function StickerCard({ sticker, name, addLabel, onAdd }: { sticker: Sticker; name: string; addLabel: string; onAdd(): void }) {
    return (
        <button
            type="button"
            className="on-sticker"
            data-testid={`sticker-card-${sticker.id}`}
            title={addLabel}
            draggable
            onClick={onAdd}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData(STICKER_DRAG_MIME, sticker.id);
                e.dataTransfer.setData("application/json", JSON.stringify({ kind: "sticker", stickerId: sticker.id, name }));
            }}
        >
            <img src={thumbUrl(sticker)} alt={name} loading="lazy" decoding="async" draggable={false} width={THUMB_PX} height={THUMB_PX} />
        </button>
    );
}

export function StickersTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<StickerCategory | "all">("all");
    const nameOf = useMemo(() => {
        const names = new Map<string, string>();
        for (const sticker of STICKERS) {
            const key = stickerMessageKey(sticker.id);
            const text = t(key as never);
            // An unknown key comes back as the key (or "namespace.key"): fall back to the catalog's English name.
            names.set(sticker.id, !text || text === key || text.endsWith(`.${key}`) ? sticker.name : text);
        }
        return (sticker: Sticker) => names.get(sticker.id) ?? sticker.name;
    }, [t]);
    const shown = useMemo(() => {
        const scope = category === "all" ? undefined : category;
        const found = searchStickers(query, scope);
        const q = fold(query);
        if (!q) return found;
        // Translated names match too (the catalog index is English).
        const ids = new Set(found.map((sticker) => sticker.id));
        const extra = STICKERS.filter((sticker) => !ids.has(sticker.id) && (!scope || sticker.category === scope) && fold(nameOf(sticker)).includes(q));
        return [...found, ...extra];
    }, [query, category, nameOf]);
    const add = (sticker: Sticker) => {
        void addStickerClip(controller, storeApi, sticker.id, storeApi.getState().currentTime, { label: nameOf(sticker) }).then((result) => {
            if (!result.ok) toast.error(t("stk_addFailed"));
        });
    };
    return (
        <div className="on-tabpanel on-stickers" data-testid="library-stickers">
            <div className="on-panel-head">
                <h2 className="on-panel-title">{t("stk_tab")}</h2>
                <span className="on-count" aria-live="polite">{t("resultsCount", { n: shown.length })}</span>
            </div>
            <p className="on-panel-sub">{t("stk_hint")}</p>
            <label className="on-search">
                <Search aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    placeholder={t("stk_search")}
                    aria-label={t("stk_search")}
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
                {(["all", ...STICKER_CATEGORIES] as const).map((id) => (
                    <button key={id} type="button" className="on-chip" aria-pressed={category === id} onClick={() => setCategory(id)}>
                        {id === "all" ? t("categoryAll") : t(`stk_cat_${id.replace(/-/g, "_")}` as never)}
                    </button>
                ))}
            </div>
            <div className="on-scroll">
                {shown.length === 0 ? (
                    <div className="on-empty">
                        <p className="on-sticker-empty-title">{t("stk_empty")}</p>
                        <p className="on-sticker-empty-hint">{t("stk_emptyHint")}</p>
                    </div>
                ) : (
                    <ul className="on-sticker-grid">
                        {shown.map((sticker) => {
                            const name = nameOf(sticker);
                            return (
                                <li key={sticker.id}>
                                    <StickerCard sticker={sticker} name={name} addLabel={t("stk_add", { name })} onAdd={() => add(sticker)} />
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            <p className="on-sticker-credit">{TWEMOJI_ATTRIBUTION}</p>
        </div>
    );
}
