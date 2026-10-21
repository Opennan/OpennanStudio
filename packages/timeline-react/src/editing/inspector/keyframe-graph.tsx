"use client";
// The keyframe graph editor (phase 10c): a resizable drawer under the inspector tabs that plots one channel of
// the selected clip or scene as value over item time, from the preview's own evaluation (channelValueAt:
// easing curves and bezier tables included). Points drag in time (keyframe.retime of the property's channels)
// and value (keyframe.set), one command per drag on release, Shift locks the smaller movement; bezier segments
// show draggable handles (keyframe.easing); a segment opens an easing menu; double-click adds a keyframe on the
// curve; Delete removes the selected point; arrows nudge it (time by a frame, value by a step). SVG, tokens only
// (keyframe-graph.css); the math lives in keyframe-graph-math.ts.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { X } from "lucide-react";
import { DEFAULT_BEZIER, EASING_IDS, type BezierHandles, type EasingId } from "@opennan/timeline-core/motion/easing";
import { channelValueAt, hasChannel, retimeKeyframe, setKeyframe, setKeyframeEasing } from "@opennan/timeline-core/motion/keyframes";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { KEYFRAME_FPS, snapKeyframeTime } from "@opennan/timeline-core/timeline/canvas/keyframe-markers";
import type { SelectedKeyframe } from "@opennan/timeline-core";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import type { KeyItem } from "./keyframe-toggle";
import { localTime } from "./keyframe-model";
import { usePlayhead } from "./use-playhead";
import {
    bezierFromPointer, bezierHandlePositions, channelFormat, channelGroup, channelPoints, channelSegments, clampToFormat, curvePath, dragTarget,
    formatValue, graphChannels, graphDomain, makeGraphScale, ticks, type GraphScale, type GraphSegment,
} from "./keyframe-graph-math";

type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;

export const GRAPH_HEIGHT = { min: 150, default: 230, max: 480, step: 16 } as const;
const HEIGHT_KEY = "opennan-studio:kf-graph-height";
const DEFAULT_SIZE = { width: 280, height: 150 };
const DRAG_THRESHOLD_PX = 3;
const HANDLE_STEP = 0.05;

const CHANNEL_LABELS: Record<string, string> = {
    scale: "scale", position_x: "positionX", position_y: "positionY", rotation_degrees: "rotation", opacity: "opacity", volume: "volume", filter_intensity: "intensity",
};

/** The inspector's label for a channel (Adjust channels share their slider keys); unknown channels show their name. */
export function channelLabel(t: Translate, channel: string): string {
    const key = CHANNEL_LABELS[channel] ?? (channel.startsWith("adj_") ? channel : null);
    return key ? t(key as never) : channel;
}

function readHeight(): number {
    try {
        const stored = Number(window.localStorage.getItem(HEIGHT_KEY));
        if (Number.isFinite(stored) && stored >= GRAPH_HEIGHT.min && stored <= GRAPH_HEIGHT.max) return stored;
    } catch {
        // Storage can be blocked: the default height works.
    }
    return GRAPH_HEIGHT.default;
}

function writeHeight(height: number): void {
    try {
        window.localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
    } catch {
        // A per-viewer convenience only.
    }
}

const clampHeight = (h: number) => Math.min(GRAPH_HEIGHT.max, Math.max(GRAPH_HEIGHT.min, h));

/** The drawer: header (title, property picker, close), the graph, and a resize handle. */
export function KeyframeGraphDrawer({ item, kind }: { item: KeyItem; kind: "clip" | "scene" }) {
    const t = useTimelineMessages("studioEditor");
    const api = useEditorStoreApi();
    const wanted = useEditorStore((s) => s.keyframeGraph.channel);
    const channels = useMemo(() => graphChannels(item.points), [item.points]);
    const channel = wanted && channels.includes(wanted) ? wanted : channels[0] ?? null;
    const [height, setHeight] = useState(readHeight);
    const resize = useRef<{ startY: number; startHeight: number; pointerId: number } | null>(null);
    const pickerId = useId();
    const setAndStore = (h: number) => {
        const next = clampHeight(h);
        setHeight(next);
        writeHeight(next);
    };
    return (
        <section className="on-kfg" data-keyframe-graph="" data-testid="kf-graph" aria-label={t("kf_graphTitle")} style={{ height }}>
            <div className="on-kfg-head">
                <span className="on-kfg-title">{t("kf_graphTitle")}</span>
                {channels.length > 0 && (
                    <>
                        <label className="sr-only" htmlFor={pickerId}>{t("kf_graphChannel")}</label>
                        <select
                            id={pickerId}
                            className="on-select on-kfg-picker"
                            data-testid="kf-graph-channel"
                            value={channel ?? ""}
                            onChange={(e) => api.getState().setKeyframeGraph({ channel: e.target.value })}
                        >
                            {channels.map((c) => <option key={c} value={c}>{channelLabel(t, c)}</option>)}
                        </select>
                    </>
                )}
                <button type="button" className="on-icon-btn" aria-label={t("kf_graphClose")} data-testid="kf-graph-close" onClick={() => api.getState().setKeyframeGraph({ open: false })}>
                    <X aria-hidden="true" />
                </button>
            </div>
            {channel ? <KeyframeGraph key={`${item.id}-${channel}`} item={item} kind={kind} channel={channel} /> : <p className="on-hint on-kfg-empty" data-testid="kf-graph-empty">{t("kf_graphEmpty")}</p>}
            <div
                className="on-kfg-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("kf_graphResize")}
                aria-valuemin={GRAPH_HEIGHT.min}
                aria-valuemax={GRAPH_HEIGHT.max}
                aria-valuenow={height}
                tabIndex={0}
                data-testid="kf-graph-resize"
                onPointerDown={(e) => {
                    e.preventDefault();
                    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                    resize.current = { startY: e.clientY, startHeight: height, pointerId: e.pointerId };
                }}
                onPointerMove={(e) => {
                    const r = resize.current;
                    if (r && r.pointerId === e.pointerId) setHeight(clampHeight(r.startHeight + e.clientY - r.startY));
                }}
                onPointerUp={(e) => {
                    const r = resize.current;
                    if (!r || r.pointerId !== e.pointerId) return;
                    resize.current = null;
                    setAndStore(r.startHeight + e.clientY - r.startY);
                }}
                onPointerCancel={() => { resize.current = null; }}
                onKeyDown={(e) => {
                    const delta = e.key === "ArrowDown" ? GRAPH_HEIGHT.step : e.key === "ArrowUp" ? -GRAPH_HEIGHT.step : 0;
                    if (!delta) return;
                    e.preventDefault();
                    setAndStore(height + delta);
                }}
            />
        </section>
    );
}

type Preview =
    | { kind: "point"; from: number; time: number; value: number }
    | { kind: "handle"; segment: number; bezier: BezierHandles }
    | null;

interface PointDrag {
    kind: "point";
    pointerId: number;
    from: number;
    origin: { time: number; value: number };
    startX: number;
    startY: number;
    moved: boolean;
    scale: GraphScale;
}

interface HandleDrag {
    kind: "handle";
    pointerId: number;
    segment: GraphSegment;
    which: 0 | 1;
    scale: GraphScale;
    moved: boolean;
}

interface EasingMenu {
    segment: GraphSegment;
    x: number;
    y: number;
    /** Return focus here when the menu closes. */
    returnTo: Element | null;
}

function useElementSize<T extends Element>(): [React.RefObject<T | null>, { width: number; height: number }] {
    const ref = useRef<T | null>(null);
    const [size, setSize] = useState(DEFAULT_SIZE);
    useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const measure = () => {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) setSize((s) => (s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    return [ref, size];
}

const sec = (t: number) => `${t.toFixed(2)} s`;

export function KeyframeGraph({ item, kind, channel }: { item: KeyItem; kind: "clip" | "scene"; channel: string }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const api = useEditorStoreApi();
    const hintId = useId();
    const [wrapRef, size] = useElementSize<HTMLDivElement>();
    const svgRef = useRef<SVGSVGElement>(null);
    const [preview, setPreview] = useState<Preview>(null);
    const drag = useRef<PointDrag | HandleDrag | null>(null);
    const [menu, setMenu] = useState<EasingMenu | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const pointRefs = useRef(new Map<number, SVGCircleElement>());
    const focusTime = useRef<number | null>(null);
    const format = channelFormat(channel, kind);
    const group = channelGroup(channel);
    const target = item.target;
    const duration = Math.max(0.001, item.duration);

    // The selected point follows the store (a timeline click selects it here too).
    const storeSelected = useEditorStore((s) => {
        const k = s.selectedKeyframe;
        if (!k) return null;
        const same = "clipId" in target ? k.clipId === target.clipId : k.sceneId === target.sceneId;
        return same ? k.time : null;
    });

    // Points as drawn: the item's, with a drag applied (core helpers, so the preview equals the result).
    const shown = useMemo<TimelineKeyframePoint[]>(() => {
        if (!preview) return item.points;
        if (preview.kind === "handle") {
            const segment = channelSegments(item.points, channel)[preview.segment];
            return segment ? setKeyframeEasing(item.points, segment.t0, "bezier", preview.bezier) : item.points;
        }
        const moved = Math.abs(preview.time - preview.from) >= 0.0005 ? retimeKeyframe(item.points, preview.from, preview.time, group) : item.points;
        return setKeyframe(moved, preview.time, { [channel]: preview.value });
    }, [item.points, preview, channel, group]);

    const cps = useMemo(() => channelPoints(shown, channel), [shown, channel]);
    const segments = useMemo(() => channelSegments(shown, channel), [shown, channel]);
    const base = cps[0]?.value ?? 0;
    const liveDomain = useMemo(() => graphDomain(shown, channel, base, duration, kind), [shown, channel, base, duration, kind]);
    // The axis holds still while a drag is on (the point stays under the pointer).
    const scale = drag.current?.scale ?? makeGraphScale(size, duration, liveDomain);
    const playhead = usePlayhead(true);
    const localPlayhead = localTime(playhead, item.start, item.duration);
    const selectedTime = preview?.kind === "point" ? preview.time : storeSelected;

    useEffect(() => {
        if (focusTime.current === null) return;
        const match = [...pointRefs.current.entries()].find(([time]) => Math.abs(time - focusTime.current!) < 0.0005);
        if (match) match[1].focus();
        focusTime.current = null;
    });

    const select = (time: number | null) => api.getState().selectKeyframe(time === null ? null : { ...target, time } as SelectedKeyframe);
    const seek = (time: number) => void controller.execute({ type: "playhead.seek", seconds: item.start + time });

    /** Client pixels → graph pixels (the SVG is drawn 1:1 with its measured box). */
    const toGraph = (clientX: number, clientY: number) => {
        const rect = svgRef.current?.getBoundingClientRect();
        const sx = rect?.width ? size.width / rect.width : 1;
        const sy = rect?.height ? size.height / rect.height : 1;
        return { x: (clientX - (rect?.left ?? 0)) * sx, y: (clientY - (rect?.top ?? 0)) * sy };
    };

    const commitPoint = (from: number, to: number, value: number, originValue: number) => {
        const timeChanged = Math.abs(to - from) >= 0.0005;
        const valueChanged = value !== originValue;
        if (timeChanged) {
            void controller.execute({ type: "keyframe.retime", ...target, from, to, channels: group, ...(valueChanged ? { values: { [channel]: value } } : {}) });
            select(to);
        } else if (valueChanged) {
            void controller.execute({ type: "keyframe.set", ...target, time: from, values: { [channel]: value } });
        }
    };

    // ── points ───────────────────────────────────────────
    const onPointDown = (time: number, value: number) => (e: PointerEvent<SVGCircleElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        (e.currentTarget as SVGCircleElement).focus?.();
        const p = toGraph(e.clientX, e.clientY);
        drag.current = { kind: "point", pointerId: e.pointerId, from: time, origin: { time, value }, startX: p.x, startY: p.y, moved: false, scale };
        select(time);
    };
    const onPointerMove = (e: PointerEvent<SVGElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const p = toGraph(e.clientX, e.clientY);
        if (d.kind === "handle") {
            d.moved = true;
            const current = d.segment.bezier ?? DEFAULT_BEZIER;
            setPreview({ kind: "handle", segment: d.segment.index, bezier: bezierFromPointer(d.segment, d.scale, d.which, p.x, p.y, current) });
            return;
        }
        const dx = p.x - d.startX;
        const dy = p.y - d.startY;
        if (!d.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
        d.moved = true;
        const next = dragTarget(d.origin, { dx, dy }, d.scale, { duration, playhead: localPlayhead, format, shift: e.shiftKey });
        setPreview({ kind: "point", from: d.from, time: next.time, value: next.value });
    };
    const onPointerUp = (e: PointerEvent<SVGElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        drag.current = null;
        const last = preview;
        setPreview(null);
        if (d.kind === "handle") {
            if (d.moved && last?.kind === "handle") {
                void controller.execute({ type: "keyframe.easing", ...target, time: d.segment.t0, easing: "bezier", bezier: [...last.bezier] as [number, number, number, number] });
            }
            return;
        }
        if (!d.moved) {
            seek(d.from);
            return;
        }
        if (last?.kind === "point") {
            focusTime.current = last.time;
            commitPoint(d.from, last.time, last.value, d.origin.value);
        }
    };
    const cancelDrag = () => {
        drag.current = null;
        setPreview(null);
    };

    const nudge = (time: number, value: number) => (e: KeyboardEvent<SVGCircleElement>) => {
        if (e.key === "Escape" && drag.current) {
            e.preventDefault();
            e.stopPropagation();
            cancelDrag();
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            void controller.execute({ type: "keyframe.remove", ...target, time, channels: group });
            select(null);
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            select(time);
            seek(time);
            return;
        }
        const big = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            const raw = time + ((e.key === "ArrowRight" ? 1 : -1) * big) / KEYFRAME_FPS;
            const to = snapKeyframeTime(raw, { duration, localPlayhead: null, zoom: 1, snapEnabled: false }).time;
            if (Math.abs(to - time) < 0.0005) return;
            focusTime.current = to;
            void controller.execute({ type: "keyframe.retime", ...target, from: time, to, channels: group });
            select(to);
            return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            const next = clampToFormat(value + (e.key === "ArrowUp" ? 1 : -1) * big * format.step, format);
            const rounded = Number((Math.round(next / (format.step / 100)) * (format.step / 100)).toPrecision(12));
            if (rounded === value) return;
            focusTime.current = time;
            void controller.execute(
                { type: "keyframe.set", ...target, time, values: { [channel]: rounded } },
                { coalesceKey: `kfg-${item.id}-${channel}-${time}`, debounceMs: 120 },
            );
        }
    };

    // ── bezier handles ───────────────────────────────────
    const onHandleDown = (segment: GraphSegment, which: 0 | 1) => (e: PointerEvent<SVGCircleElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        (e.currentTarget as SVGCircleElement).focus?.();
        drag.current = { kind: "handle", pointerId: e.pointerId, segment, which, scale, moved: false };
    };
    const onHandleKey = (segment: GraphSegment, which: 0 | 1) => (e: KeyboardEvent<SVGCircleElement>) => {
        const step = e.shiftKey ? HANDLE_STEP * 2 : HANDLE_STEP;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        e.stopPropagation();
        const current = [...(segment.bezier ?? DEFAULT_BEZIER)];
        const r = (v: number) => Math.round(v * 100) / 100;
        current[which * 2] = r(Math.min(1, Math.max(0, current[which * 2] + dx)));
        current[which * 2 + 1] = r(Math.min(2, Math.max(-1, current[which * 2 + 1] + dy)));
        void controller.execute(
            { type: "keyframe.easing", ...target, time: segment.t0, easing: "bezier", bezier: current as [number, number, number, number] },
            { coalesceKey: `kfg-ease-${item.id}-${segment.t0}`, debounceMs: 120 },
        );
    };

    // ── segments and the easing menu ─────────────────────
    const openMenu = (segment: GraphSegment, clientX: number, clientY: number, returnTo: Element | null) => {
        const wrap = wrapRef.current?.getBoundingClientRect();
        setMenu({ segment, x: clientX - (wrap?.left ?? 0), y: clientY - (wrap?.top ?? 0), returnTo });
    };
    const closeMenu = (refocus: boolean) => {
        const back = menu?.returnTo;
        setMenu(null);
        if (refocus && back instanceof SVGElement) back.focus?.();
    };
    useEffect(() => {
        if (!menu) return;
        menuRef.current?.querySelector<HTMLElement>("[role=\"menuitemradio\"]")?.focus();
        const close = (event: Event) => {
            if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
            setMenu(null);
        };
        window.addEventListener("pointerdown", close, true);
        return () => window.removeEventListener("pointerdown", close, true);
    }, [menu]);
    const chooseEasing = (segment: GraphSegment, easing: EasingId) => {
        closeMenu(true);
        const bezier = easing === "bezier" ? [...(segment.bezier ?? DEFAULT_BEZIER)] as [number, number, number, number] : undefined;
        void controller.execute({ type: "keyframe.easing", ...target, time: segment.t0, easing, ...(bezier ? { bezier } : {}) });
    };
    const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(true);
            return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        e.stopPropagation();
        const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=\"menuitemradio\"]") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };

    // ── double-click: a keyframe on the curve ────────────
    const onDoubleClick = (e: MouseEvent<SVGSVGElement>) => {
        const el = e.target as Element;
        if (el.closest?.(".on-kfg-point, .on-kfg-handle")) return;
        setMenu(null);
        const p = toGraph(e.clientX, e.clientY);
        if (p.x < scale.left - 4 || p.x > scale.right + 4) return;
        const time = snapKeyframeTime(scale.t(p.x), { duration, localPlayhead, zoom: (scale.right - scale.left) / duration, snapEnabled: true }).time;
        const values: Record<string, number> = {};
        for (const c of group) if (c === channel || hasChannel(item.points, c)) values[c] = channelValueAt(item.points, c, time, base);
        focusTime.current = time;
        void controller.execute({ type: "keyframe.set", ...target, time, values });
        select(time);
    };

    const valueTicks = ticks(scale.lo, scale.hi, Math.max(2, Math.floor((scale.bottom - scale.top) / 26)));
    const timeTicks = ticks(0, duration, Math.max(1, Math.floor((scale.right - scale.left) / 64)));
    const segmentPath = (s: GraphSegment) => {
        const n = Math.max(2, Math.ceil((scale.x(s.t1) - scale.x(s.t0)) / 3));
        const parts: string[] = [];
        for (let i = 0; i <= n; i += 1) {
            const time = s.t0 + ((s.t1 - s.t0) * i) / n;
            const v = s.easing === "hold" ? s.v0 : channelValueAt(shown, channel, time, base);
            parts.push(`${scale.x(time).toFixed(1)},${scale.y(v).toFixed(1)}`);
        }
        return `M${parts.join(" L")}`;
    };
    const easingName = (id: EasingId) => (id === "bezier" ? t("ease_bezier") : t(`ease_${id}` as never));

    return (
        <div className="on-kfg-body" ref={wrapRef}>
            <svg
                ref={svgRef}
                className="on-kfg-svg"
                width={size.width}
                height={size.height}
                viewBox={`0 0 ${size.width} ${size.height}`}
                role="group"
                aria-label={t("kf_graphTitle")}
                aria-describedby={hintId}
                data-testid="kf-graph-svg"
                onDoubleClick={onDoubleClick}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={cancelDrag}
            >
                <rect className="on-kfg-frame" x={scale.left} y={scale.top} width={scale.right - scale.left} height={scale.bottom - scale.top} />
                {valueTicks.map((v) => (
                    <g key={`v${v}`}>
                        <line className="on-kfg-grid" x1={scale.left} x2={scale.right} y1={scale.y(v)} y2={scale.y(v)} />
                        <text className="on-kfg-label" x={scale.left - 5} y={scale.y(v) + 3} textAnchor="end">{formatValue(v, format)}</text>
                    </g>
                ))}
                {timeTicks.map((time) => (
                    <text key={`t${time}`} className="on-kfg-label" x={scale.x(time)} y={scale.bottom + 13} textAnchor="middle">{`${Number(time.toFixed(2))}s`}</text>
                ))}
                <path className="on-kfg-curve" d={curvePath(shown, channel, base, scale)} data-testid="kf-graph-curve" />
                {localPlayhead !== null && (
                    <line className="on-kfg-playhead" x1={scale.x(localPlayhead)} x2={scale.x(localPlayhead)} y1={scale.top} y2={scale.bottom} data-testid="kf-graph-playhead" aria-label={t("kf_graphPlayhead")} />
                )}
                {segments.map((s) => (
                    <path
                        key={`s${s.t0}`}
                        className="on-kfg-segment"
                        d={segmentPath(s)}
                        tabIndex={0}
                        role="button"
                        aria-haspopup="menu"
                        aria-label={t("kf_graphSegment", { from: sec(s.t0), to: sec(s.t1), easing: easingName(s.easing) })}
                        data-testid={`kf-graph-segment-${s.index}`}
                        onClick={(e) => openMenu(s, e.clientX, e.clientY, e.currentTarget)}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = svgRef.current?.getBoundingClientRect();
                            const mid = (s.t0 + s.t1) / 2;
                            openMenu(s, (rect?.left ?? 0) + scale.x(mid), (rect?.top ?? 0) + scale.y(channelValueAt(shown, channel, mid, base)), e.currentTarget);
                        }}
                    />
                ))}
                {segments.map((s) => {
                    if (s.easing !== "bezier") return null;
                    const handles = bezierHandlePositions(s, scale);
                    if (!handles) return null;
                    const bezier = s.bezier ?? DEFAULT_BEZIER;
                    return (
                        <g key={`h${s.t0}`}>
                            <line className="on-kfg-arm" x1={scale.x(s.t0)} y1={scale.y(s.v0)} x2={handles[0][0]} y2={handles[0][1]} />
                            <line className="on-kfg-arm" x1={scale.x(s.t1)} y1={scale.y(s.v1)} x2={handles[1][0]} y2={handles[1][1]} />
                            {([0, 1] as const).map((which) => (
                                <circle
                                    key={which}
                                    className="on-kfg-handle"
                                    cx={handles[which][0]}
                                    cy={handles[which][1]}
                                    r={5}
                                    tabIndex={0}
                                    role="slider"
                                    aria-label={t("kf_graphHandle", { n: which + 1, from: sec(s.t0) })}
                                    aria-valuemin={-1}
                                    aria-valuemax={2}
                                    aria-valuenow={bezier[which * 2 + 1]}
                                    aria-valuetext={`${bezier[which * 2].toFixed(2)}, ${bezier[which * 2 + 1].toFixed(2)}`}
                                    data-testid={`kf-graph-handle-${s.index}-${which + 1}`}
                                    onPointerDown={onHandleDown(s, which)}
                                    onKeyDown={onHandleKey(s, which)}
                                />
                            ))}
                        </g>
                    );
                })}
                {cps.map((p, i) => (
                    <circle
                        key={`p${i}`}
                        ref={(el) => {
                            if (el) pointRefs.current.set(p.time, el);
                            else pointRefs.current.delete(p.time);
                        }}
                        className="on-kfg-point"
                        cx={scale.x(p.time)}
                        cy={scale.y(p.value)}
                        r={selectedTime !== null && Math.abs(selectedTime - p.time) < 0.0005 ? 6 : 4.5}
                        tabIndex={0}
                        role="slider"
                        aria-label={t("kf_graphPoint", { time: sec(p.time), value: formatValue(p.value, format) })}
                        aria-valuemin={format.min !== undefined ? format.min * format.factor : undefined}
                        aria-valuemax={format.max !== undefined ? format.max * format.factor : undefined}
                        aria-valuenow={Number((p.value * format.factor).toFixed(4))}
                        aria-valuetext={formatValue(p.value, format)}
                        aria-describedby={hintId}
                        data-selected={selectedTime !== null && Math.abs(selectedTime - p.time) < 0.0005 ? "true" : undefined}
                        data-testid={`kf-graph-point-${i}`}
                        onPointerDown={onPointDown(p.time, p.value)}
                        onKeyDown={nudge(p.time, p.value)}
                        onFocus={() => {
                            if (!drag.current && storeSelected !== p.time) select(p.time);
                        }}
                    />
                ))}
            </svg>
            <p className="sr-only" id={hintId}>{t("kf_graphHint")}</p>
            {menu && (
                <div
                    ref={menuRef}
                    className="on-kfg-menu"
                    role="menu"
                    aria-label={t("kf_graphSegmentEasing", { from: sec(menu.segment.t0) })}
                    data-testid="kf-graph-easing-menu"
                    style={{ left: Math.max(4, Math.min(menu.x, size.width - 150)), top: Math.max(4, Math.min(menu.y + 8, size.height - 8)) }}
                    onKeyDown={onMenuKey}
                >
                    {EASING_IDS.map((id) => (
                        <button
                            key={id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={menu.segment.easing === id}
                            className="on-kfg-menu-item"
                            data-testid={`kf-graph-ease-${id}`}
                            onClick={() => chooseEasing(menu.segment, id)}
                        >
                            {easingName(id)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
