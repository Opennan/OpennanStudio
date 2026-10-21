"use client";
// Transitions, Filters, and Effects libraries.
import { useCallback, useEffect, useMemo, useState } from "react";
import { looksCatalog } from "@opennan/timeline-core/looks/catalog";
import { effectById, effectParams } from "@opennan/timeline-core/looks/effects";
import { DEFAULT_FILTER_INTENSITY, normalizeFilterId } from "@opennan/timeline-core/looks/filters";
import { itemFilterIntensity, itemLook } from "@opennan/timeline-core/looks/look-plan";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing-navigation";
import { FrameSnapshots } from "@opennan/timeline-media/looks/frame-snapshots";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { useTimelineMedia } from "../../hooks/use-timeline-media";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { useTimelineToast } from "../../hooks/use-timeline-toast";
import { addEffect, applyFilter, applyTransition } from "../actions";
import { lookTargetOf, useSelectionTarget } from "../selection";
import { groupLookTargets, useGroupSelection } from "../multi-selection";
import { SliderRow } from "../controls";
import { LibraryPanel } from "./library-panel";
import { LookThumb, THUMB_H, THUMB_W, sampleFrames } from "./look-thumb";

const CATALOG = looksCatalog();

/** Static thumbnails show the transition mid-way; dips and flashes read best before their peak. */
const STATIC_PROGRESS: Record<string, number> = { dip_black: 0.28, dip_white: 0.28, flash: 0.2, luma_fade: 0.5, glitch: 0.45 };

/** A ping-pong progress for animated transition thumbnails (0 → 1 → hold → 0 …). */
function loopProgress(t: number): number {
    const cycle = t % 2.4;
    if (cycle < 1.1) return cycle / 1.1;
    if (cycle < 1.5) return 1;
    return Math.max(0, 1 - (cycle - 1.5) / 0.9);
}

function Card({ name, applied, onActivate, onDragStart, children, testId }: {
    name: string; applied?: boolean; onActivate(): void; onDragStart?(e: React.DragEvent): void; children: React.ReactNode; testId?: string;
}) {
    return (
        <button
            type="button"
            className="on-card"
            data-applied={applied || undefined}
            data-testid={testId}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart}
            onClick={onActivate}
            title={name}
        >
            <span className="on-card-thumb">{children}</span>
            <span className="on-card-name">{name}</span>
        </button>
    );
}

function useHover(): [boolean, { onMouseEnter(): void; onMouseLeave(): void; onFocus(): void; onBlur(): void }] {
    const [hover, setHover] = useState(false);
    return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onFocus: () => setHover(true), onBlur: () => setHover(false) }];
}

// ── transitions ──────────────────────────────────────────

function TransitionCard({ id, name, applied, onApply }: { id: string; name: string; applied: boolean; onApply(): void }) {
    const [hover, handlers] = useHover();
    const paint = useCallback((renderer: LookRenderer, t: number) => {
        const def = transitionById(id);
        const [a, b] = sampleFrames();
        if (!def) return null;
        const out = renderer.transition(renderer.upload(a, THUMB_W, THUMB_H), renderer.upload(b, THUMB_W, THUMB_H), def, hover ? loopProgress(t) : t);
        renderer.present(out, THUMB_W, THUMB_H);
        return renderer.canvas;
    }, [id, hover]);
    return (
        <span {...handlers} style={{ display: "contents" }}>
            <Card
                name={name}
                applied={applied}
                testId={`transition-card-${id}`}
                onActivate={onApply}
                onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/x-transition-id", id);
                    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "transition", transitionId: id, name }));
                }}
            >
                <LookThumb paint={paint} active={hover} staticTime={STATIC_PROGRESS[id] ?? 0.42} />
            </Card>
        </span>
    );
}

export function TransitionsTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const selection = useSelectionTarget();
    const appliedId = useEditorStore((s) => {
        const sel = s.selectedTransition;
        if (sel?.kind === "clip") {
            const clip = s.timelineData?.clips.find((c) => c.id === sel.id);
            return clip ? normalizeTimelineTransitionType(clip.transitionType ?? "none") : null;
        }
        if (sel?.kind !== "scene") return null;
        const scene = s.serverScenes.find((sc) => sc.id === sel.id);
        return scene ? normalizeTimelineTransitionType(scene.visualTransition ?? "none") : null;
    });
    const items = useMemo(() => CATALOG.transitions.map((tr) => ({ id: tr.id, category: tr.category, name: t(`tr_${tr.id}` as never) })), [t]);
    const categories = useMemo(() => ["basic", "slide", "wipe", "camera", "distort"].map((id) => ({ id, label: t(`trCat_${id}` as never) })), [t]);
    return (
        <LibraryPanel
            testId="library-transitions"
            title={t("tabTransitions")}
            hint={t("transitionsHint")}
            searchLabel={t("searchTransitions")}
            items={items}
            categories={categories}
            renderItem={(item) => (
                <TransitionCard
                    id={item.id}
                    name={item.name}
                    applied={appliedId === item.id}
                    onApply={() => {
                        void applyTransition(controller, storeApi, selection, item.id).then((result) => {
                            if (result.ok) toast.success(t("transitionApplied", { name: item.name }));
                            else toast.info(t("noCutForTransition"));
                        });
                    }}
                />
            )}
        />
    );
}

// ── filters ──────────────────────────────────────────────

/** A still of the selected item's media (its own snapshot element), else the sample frame. */
function useFilterSource(item: { id: string; mediaUrl?: string | null; mediaType?: string; videoUrl?: string | null; sourceVideoUrl?: string | null; startImageUrl?: string | null; cardType?: string | null } | null): { get(): { source: TexImageSource; width: number; height: number }; version: string } {
    const media = useTimelineMedia();
    const [ready, setReady] = useState(0);
    const snapshots = useMemo(() => new FrameSnapshots({ resolveUrl: (url) => media.resolveMediaUrl(url), onReady: () => setReady((n) => n + 1), limit: 4 }), [media]);
    useEffect(() => () => snapshots.dispose(), [snapshots]);
    const url = item ? item.mediaUrl ?? item.videoUrl ?? (item.cardType === "source_clip" ? item.sourceVideoUrl : null) ?? item.startImageUrl ?? null : null;
    const isImage = Boolean(item && (item.mediaType === "image" || (!item.mediaUrl && !item.videoUrl && !item.sourceVideoUrl) || /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(url ?? "")));
    const get = useCallback(() => {
        const snap = url ? (isImage ? snapshots.image(url) : snapshots.video(url, 1)) : null;
        if (snap) return snap;
        const [a] = sampleFrames();
        return { source: a as TexImageSource, width: THUMB_W, height: THUMB_H };
    }, [url, isImage, snapshots]);
    return { get, version: `${url ?? "sample"}|${ready}` };
}

function FilterCard({ id, name, intensity, applied, version, source, onApply }: {
    id: string; name: string; intensity: number; applied: boolean; version: string; source: () => { source: TexImageSource; width: number; height: number }; onApply(): void;
}) {
    const paint = useCallback((renderer: LookRenderer) => {
        const plan = itemLook({ kind: "scene", visualFilter: id, filterIntensity: intensity });
        const { source: element, width, height } = source();
        const fitted = renderer.resize(renderer.upload(element, width, height), THUMB_W, THUMB_H);
        renderer.present(renderer.look(fitted, plan, 0), THUMB_W, THUMB_H);
        return renderer.canvas;
    }, [id, intensity, source]);
    return (
        <Card
            name={name}
            applied={applied}
            testId={`filter-card-${id}`}
            onActivate={onApply}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/x-look-filter", id);
                e.dataTransfer.setData("application/json", JSON.stringify({ kind: "filter", filterId: id, name }));
            }}
        >
            <LookThumb paint={paint} active={false} version={version} />
        </Card>
    );
}

export function FiltersTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const toast = useTimelineToast();
    const selection = useSelectionTarget();
    // A multi-selection (phase 10c) applies to every selected scene and visual clip in one step.
    const groupTargets = groupLookTargets(useGroupSelection());
    const single = lookTargetOf(selection);
    const target = groupTargets ?? single;
    const item = selection?.kind === "scene" ? selection.scene : selection?.kind === "clip" ? selection.clip : null;
    const frame = useFilterSource(single ? item : null);
    const applied = item ? normalizeFilterId(item.visualFilter) : "none";
    const intensity = item && applied !== "none" ? itemFilterIntensity(item) : DEFAULT_FILTER_INTENSITY;
    const version = frame.version;
    const items = useMemo(() => CATALOG.filters.map((f) => ({ id: f.id, category: f.category, name: t(`flt_${f.id}` as never) })), [t]);
    const categories = useMemo(() => ["life", "movies", "retro", "bw", "food", "landscape"].map((id) => ({ id, label: t(`fltCat_${id}` as never) })), [t]);
    const toolbar = target && applied !== "none" ? (
        <div style={{ padding: "0 12px 10px" }}>
            <SliderRow
                label={t("intensity")}
                value={Math.round(intensity * 100)}
                min={0}
                max={100}
                format={(v) => t("percent", { value: v })}
                defaultValue={Math.round(DEFAULT_FILTER_INTENSITY * 100)}
                onChange={(v) => void controller.execute({ type: "look.set", ...target, intensity: v / 100 }, { coalesceKey: `intensity-${item?.id}`, debounceMs: 120 })}
                testId="filter-intensity"
            />
        </div>
    ) : null;
    return (
        <LibraryPanel
            testId="library-filters"
            title={t("tabFilters")}
            hint={target ? undefined : t("filtersHint")}
            searchLabel={t("searchFilters")}
            items={items}
            categories={categories}
            toolbar={toolbar}
            renderItem={(f) => (
                <FilterCard
                    id={f.id}
                    name={f.name}
                    intensity={1}
                    applied={applied === f.id}
                    version={version}
                    source={frame.get}
                    onApply={() => {
                        void applyFilter(controller, target, applied === f.id ? "none" : f.id, intensity).then((result) => {
                            if (result.ok) toast.success(t("filterApplied", { name: f.name }));
                            else toast.info(t("filtersHint"));
                        });
                    }}
                />
            )}
        />
    );
}

// ── effects ──────────────────────────────────────────────

function EffectCard({ id, name, animated, onAdd }: { id: string; name: string; animated: boolean; onAdd(): void }) {
    const [hover, handlers] = useHover();
    const paint = useCallback((renderer: LookRenderer, time: number) => {
        const effect = effectById(id);
        if (!effect) return null;
        const plan = itemLook({ kind: "scene", effects: [{ id: "thumb", effectId: id, order: 0, enabled: true, paramsJson: JSON.stringify(effectParams(effect, null)) }] });
        const [a] = sampleFrames();
        renderer.present(renderer.look(renderer.upload(a, THUMB_W, THUMB_H), plan, time), THUMB_W, THUMB_H);
        return renderer.canvas;
    }, [id]);
    return (
        <span {...handlers} style={{ display: "contents" }}>
            <Card
                name={name}
                testId={`effect-card-${id}`}
                onActivate={onAdd}
                onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/x-effect-layer", id);
                    e.dataTransfer.setData("application/json", JSON.stringify({ kind: "effect", effectId: id, name }));
                }}
            >
                <LookThumb paint={paint} active={hover && animated} staticTime={0.6} />
            </Card>
        </span>
    );
}

export function EffectsTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const selection = useSelectionTarget();
    const target = groupLookTargets(useGroupSelection()) ?? lookTargetOf(selection);
    const items = useMemo(() => CATALOG.effects.map((e) => ({ id: e.id, category: e.category, name: t(`fx_${e.id.replace(/^fx_/, "")}` as never), animated: e.animated })), [t]);
    const categories = useMemo(() => ["basic", "color", "motion", "retro", "glitch"].map((id) => ({ id, label: t(`fxCat_${id}` as never) })), [t]);
    return (
        <LibraryPanel
            testId="library-effects"
            title={t("tabEffects")}
            hint={t("effectsHint")}
            searchLabel={t("searchEffects")}
            items={items}
            categories={categories}
            renderItem={(e) => (
                <EffectCard
                    id={e.id}
                    name={e.name}
                    animated={e.animated}
                    onAdd={() => {
                        void addEffect(controller, storeApi, target, e.id).then((result) => {
                            if (!result.ok) return;
                            toast.success(t(result.target === "layer" ? "effectLayerAdded" : "effectAdded", { name: e.name }));
                        });
                    }}
                />
            )}
        />
    );
}
