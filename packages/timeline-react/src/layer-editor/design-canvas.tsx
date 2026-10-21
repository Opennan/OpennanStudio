// packages/timeline-react/src/layer-editor/design-canvas.tsx
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { applyDesignOps, type DesignOp } from "@opennan/timeline-core/design/ops";
import type { LayerDesign, LayerFrame, TextLayer } from "@opennan/timeline-core/design/model";
import { anchoredCornerScale, cornerCursor, cornerPoints, hitTestHandles, pointerAngle, rotateKnob, snapRotation, unwrapDelta, CORNER_HANDLE_RADIUS, ROTATE_KNOB_RADIUS, type Corner, type HandleBox } from "../preview/motion/handles";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { LayerImageCache } from "./image-cache";
import { drawDesign, layerAt } from "./draw-design";
import { clickSelection, selectionFrame, selectionTarget, type Selection } from "./selection";

export interface DesignCanvasProps {
    design: LayerDesign;
    selection: Selection | null;
    onSelect(sel: Selection | null): void;
    /** Mid-gesture design (no history entry). */
    onPreview(design: LayerDesign): void;
    /** One finished edit; `before` is the design at gesture start. */
    onCommit(design: LayerDesign, before: LayerDesign): void;
    resolveSrc(src: string): string;
    /** Overrides the measured width (tests, fixed layouts). */
    viewWidth?: number;
    showOriginal?: boolean;
}

type Gesture =
    | { kind: "move"; start: LayerDesign; x: number; y: number; moved: boolean }
    | { kind: "scale"; start: LayerDesign; box: HandleBox; corner: Corner }
    | { kind: "rotate"; start: LayerDesign; box: HandleBox; angle: number; total: number };

const toBox = (f: LayerFrame): HandleBox => ({ cx: f.cx, cy: f.cy, w: f.w, h: f.h, rotation: f.rotation });

export function DesignCanvas(props: DesignCanvasProps) {
    const { design, selection, onSelect, onPreview, onCommit, resolveSrc } = props;
    const t = useTimelineMessages("studioEditor");
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [measured, setMeasured] = useState(0);
    const [tick, setTick] = useState(0);
    const [editing, setEditing] = useState<string | null>(null);
    const gesture = useRef<Gesture | null>(null);
    const editStart = useRef<LayerDesign | null>(null);
    const cache = useMemo(() => new LayerImageCache(resolveSrc, () => setTick((n) => n + 1)), [resolveSrc]);

    const cssW = props.viewWidth ?? measured;
    const k = cssW > 0 ? cssW / design.width : 1;
    const cssH = design.height * k;

    useEffect(() => {
        if (props.viewWidth !== undefined || !wrapRef.current) return;
        const el = wrapRef.current;
        setMeasured(el.clientWidth);
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => setMeasured(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, [props.viewWidth]);

    const frame = selectionFrame(design, selection);

    // ── draw ──
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx || cssW <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
        ctx.clearRect(0, 0, design.width, design.height);
        if (props.showOriginal && design.source) {
            const src = cache.get(design.source);
            if (src) ctx.drawImage(src, 0, 0, design.width, design.height);
        } else {
            drawDesign(ctx, design, cache, { skip: editing ? new Set([editing]) : undefined });
        }
        if (frame && !props.showOriginal) drawChrome(ctx, toBox(frame), k);
    }, [design, frame, k, cssW, cssH, cache, tick, editing, props.showOriginal]);

    // ── pointer ──
    const point = (e: { clientX: number; clientY: number }) => {
        const r = canvasRef.current!.getBoundingClientRect();
        return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
    };
    const commitOps = useCallback((start: LayerDesign, ops: DesignOp[], finish: boolean) => {
        const next = applyDesignOps(start, ops).design;
        if (finish) onCommit(next, start);
        else onPreview(next);
    }, [onCommit, onPreview]);

    const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
        const p = point(e);
        (e.target as Element).setPointerCapture?.(e.pointerId);
        if (frame && selection) {
            const box = toBox(frame);
            const hit = hitTestHandles(box, p.x, p.y, { cornerRadius: 10 / k, rotateRadius: 12 / k, rotateOffset: 24 / k });
            if (hit?.kind === "rotate") { gesture.current = { kind: "rotate", start: design, box, angle: pointerAngle(box.cx, box.cy, p.x, p.y), total: 0 }; return; }
            if (hit?.kind === "corner") { gesture.current = { kind: "scale", start: design, box, corner: hit.corner }; return; }
        }
        const layer = layerAt(design, p.x, p.y, (src, fx, fy) => cache.alphaAt(src, fx, fy));
        if (!layer) { onSelect(null); gesture.current = null; return; }
        const inside = selection && (selection.kind === "group" ? layer.group === selection.id : layer.id === selection.id);
        if (!inside) onSelect(clickSelection(layer));
        gesture.current = { kind: "move", start: design, x: p.x, y: p.y, moved: false };
    };

    const targetOf = (g: Gesture) => {
        const sel = selection ?? (g.kind === "move" ? clickSelection(layerAt(g.start, g.x, g.y, (s, fx, fy) => cache.alphaAt(s, fx, fy))!) : null);
        return sel ? selectionTarget(sel) : null;
    };

    const gestureOps = (g: Gesture, e: PointerEvent<HTMLCanvasElement>): DesignOp[] => {
        const p = point(e);
        const target = targetOf(g);
        if (!target) return [];
        if (g.kind === "move") return [{ op: "move", target, dx: p.x - g.x, dy: p.y - g.y }];
        if (g.kind === "scale") {
            const s = anchoredCornerScale({ box: g.box, corner: g.corner, pointer: p, aboutCenter: e.altKey, minFactor: 0.05 });
            return [{ op: "scale", target, factor: s.factor }, { op: "move", target, x: s.cx, y: s.cy }];
        }
        const a = pointerAngle(g.box.cx, g.box.cy, p.x, p.y);
        g.total += unwrapDelta(g.angle, a);
        g.angle = a;
        const base = (g.box.rotation * 180) / Math.PI;
        const snapped = snapRotation(base + g.total, { shift: e.shiftKey }).degrees;
        return [{ op: "rotate", target, degrees: snapped - base }];
    };

    const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
        const g = gesture.current;
        if (!g) {
            if (frame && canvasRef.current) {
                const hit = hitTestHandles(toBox(frame), point(e).x, point(e).y, { cornerRadius: 10 / k, rotateRadius: 12 / k, rotateOffset: 24 / k });
                canvasRef.current.style.cursor = hit?.kind === "corner" ? cornerCursor(hit.corner, toBox(frame)) : hit?.kind === "rotate" ? "grab" : hit ? "move" : "default";
            }
            return;
        }
        if (g.kind === "move") g.moved = true;
        commitOps(g.start, gestureOps(g, e), false);
    };

    const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
        const g = gesture.current;
        gesture.current = null;
        if (!g || (g.kind === "move" && !g.moved)) return;
        commitOps(g.start, gestureOps(g, e), true);
    };

    const onDoubleClick = (e: { clientX: number; clientY: number }) => {
        const p = point(e);
        const layer = layerAt(design, p.x, p.y, (src, fx, fy) => cache.alphaAt(src, fx, fy));
        if (!layer) return;
        onSelect({ kind: "layer", id: layer.id });
        if (layer.kind === "text") {
            editStart.current = design;
            setEditing(layer.id);
        }
    };

    // ── keys ──
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (editing || !selection) return;
        const target = selectionTarget(selection);
        const step = e.shiftKey ? 10 : 1;
        const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (nudge[e.key]) {
            e.preventDefault();
            commitOps(design, [{ op: "move", target, dx: nudge[e.key][0], dy: nudge[e.key][1] }], true);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            commitOps(design, [{ op: "set_visible", target, visible: false }], true);
            onSelect(null);
        } else if (e.key === "Escape") onSelect(null);
    };

    // ── inline text editor ──
    const editLayer = editing ? (design.layers.find((l) => l.id === editing) as TextLayer | undefined) : undefined;
    const editFrame = editLayer ? selectionFrame(design, { kind: "layer", id: editLayer.id }) : null;
    const closeEditor = () => {
        if (editStart.current && editLayer) onCommit(design, editStart.current);
        editStart.current = null;
        setEditing(null);
    };

    return (
        <div ref={wrapRef} className="on-layer-canvas" tabIndex={0} onKeyDown={onKeyDown}>
            <canvas
                ref={canvasRef}
                data-testid="layer-canvas"
                style={{ width: cssW, height: cssH }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onDoubleClick={onDoubleClick}
            />
            {editLayer && editFrame && (
                <textarea
                    aria-label={t("layerEditText")}
                    className="on-layer-text-input"
                    autoFocus
                    value={editLayer.text}
                    style={{
                        left: (editFrame.cx - editFrame.w / 2) * k - 8,
                        top: (editFrame.cy - editFrame.h / 2) * k - 8,
                        width: Math.max(90, editFrame.w * k + 16),
                        height: Math.max(34, editFrame.h * k + 16),
                    }}
                    onChange={(e) => onPreview(applyDesignOps(design, [{ op: "set_text", target: editLayer.id, text: e.target.value.replace(/\n/g, " ") }]).design)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); closeEditor(); } }}
                    onBlur={closeEditor}
                />
            )}
        </div>
    );
}

function drawChrome(ctx: CanvasRenderingContext2D, box: HandleBox, k: number): void {
    const px = 1 / k;
    ctx.save();
    ctx.strokeStyle = "#5b9bff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5 * px;
    const pts = cornerPoints(box);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const i of [1, 3, 2]) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    const { base, knob } = rotateKnob(box, 24 * px);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(knob.x, knob.y);
    ctx.stroke();
    for (const p of [...pts, knob]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, (p === knob ? ROTATE_KNOB_RADIUS : CORNER_HANDLE_RADIUS) * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}
