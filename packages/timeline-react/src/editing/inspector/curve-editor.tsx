"use client";
// The custom speed curve editor (phase 10b): points on a log speed axis (0.1x-10x, 1x in the middle) over
// the item's length. Drag a point (live preview, one speed.set on release), double-click to add (max 10),
// drag an inner point off the graph or select it and press Delete to remove (min 2); the ends stay at the
// start and end. Arrow keys move the focused point; Enter or + adds a point midway after it (before it on
// the last point) and focuses the new one. The hint (aria-describedby) says so. SVG with theme tokens only (see editing.css).
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { addCurvePoint, curvePolyline, isDragOut, moveCurvePoint, normToSpeed, removeCurvePoint, speedToNorm, type CurvePoints } from "./speed-math";

export const CURVE_W = 280;
export const CURVE_H = 140;
const GRID = [10, 1, 0.1];
export const VIEW_PAD = 8;

const fmtSpeed = (y: number) => (y < 1 ? y.toFixed(2) : y.toFixed(1));

export function CurveEditor({ points, onCommit, onPreview }: {
    points: CurvePoints;
    /** One speed.set: `coalesce` for keyboard nudges (one undo step per burst). */
    onCommit(points: CurvePoints, coalesce?: boolean): void;
    /** The curve while dragging (null when the drag ends), for the length readout. */
    onPreview?(points: CurvePoints | null): void;
}) {
    const t = useTimelineMessages("studioEditor");
    const svgRef = useRef<SVGSVGElement>(null);
    const [local, setLocal] = useState<CurvePoints>(points);
    const [selected, setSelected] = useState<number | null>(null);
    const [removing, setRemoving] = useState(false);
    const drag = useRef<{ index: number; pointerId: number; moved: boolean } | null>(null);
    const pointRefs = useRef<Array<SVGCircleElement | null>>([]);
    const focusAfterRender = useRef<number | null>(null);
    const hintId = useId();
    const key = JSON.stringify(points);
    useEffect(() => {
        if (!drag.current) setLocal(points);
    }, [key]);
    useEffect(() => {
        if (focusAfterRender.current === null) return;
        pointRefs.current[focusAfterRender.current]?.focus?.();
        focusAfterRender.current = null;
    }, [local]);

    // Client pixels → graph units (the viewBox has a VIEW_PAD margin around the graph).
    const toBox = (clientX: number, clientY: number) => {
        const rect = svgRef.current?.getBoundingClientRect();
        const sx = rect?.width ? (CURVE_W + 2 * VIEW_PAD) / rect.width : 1;
        const sy = rect?.height ? (CURVE_H + 2 * VIEW_PAD) / rect.height : 1;
        return { x: (clientX - (rect?.left ?? 0)) * sx - VIEW_PAD, y: (clientY - (rect?.top ?? 0)) * sy - VIEW_PAD };
    };
    const fromBox = (p: { x: number; y: number }): [number, number] => [p.x / CURVE_W, normToSpeed(1 - p.y / CURVE_H)];

    const onPointerDown = (index: number) => (e: PointerEvent<SVGCircleElement>) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        drag.current = { index, pointerId: e.pointerId, moved: false };
        setSelected(index);
        (e.currentTarget as SVGCircleElement).focus?.();
    };
    const onPointerMove = (e: PointerEvent<SVGCircleElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const box = toBox(e.clientX, e.clientY);
        const interior = d.index > 0 && d.index < local.length - 1;
        const out = interior && local.length > 2 && isDragOut(box, { width: CURVE_W, height: CURVE_H });
        setRemoving(out);
        if (out) {
            onPreview?.(removeCurvePoint(local, d.index));
            return;
        }
        const [x, y] = fromBox(box);
        const next = moveCurvePoint(local, d.index, x, y);
        d.moved = true;
        setLocal(next);
        onPreview?.(next);
    };
    const endDrag = (e: PointerEvent<SVGCircleElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        drag.current = null;
        onPreview?.(null);
        if (removing) {
            setRemoving(false);
            const next = removeCurvePoint(local, d.index);
            setSelected(null);
            if (next) {
                setLocal(next);
                onCommit(next);
            }
            return;
        }
        if (d.moved) onCommit(local);
    };
    const onDoubleClick = (e: MouseEvent<SVGSVGElement>) => {
        if ((e.target as Element).classList?.contains("on-curve-point")) return;
        const [x, y] = fromBox(toBox(e.clientX, e.clientY));
        const added = addCurvePoint(local, x, y);
        if (!added) return;
        setLocal(added.points);
        setSelected(added.index);
        onCommit(added.points);
    };
    const onKeyDown = (index: number) => (e: KeyboardEvent<SVGCircleElement>) => {
        if (e.key === "Enter" || e.key === "+") {
            // Midway (in time and on the log speed axis) between this point and the next, or the previous on the last.
            const after = index < local.length - 1 ? index : index - 1;
            const [x0, y0] = local[after];
            const [x1, y1] = local[after + 1];
            const added = addCurvePoint(local, (x0 + x1) / 2, normToSpeed((speedToNorm(y0) + speedToNorm(y1)) / 2));
            e.preventDefault();
            if (!added) return;
            setLocal(added.points);
            setSelected(added.index);
            focusAfterRender.current = added.index;
            onCommit(added.points);
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            const next = removeCurvePoint(local, index);
            if (!next) return;
            e.preventDefault();
            setLocal(next);
            setSelected(null);
            onCommit(next);
            return;
        }
        const big = e.shiftKey;
        const dx = e.key === "ArrowRight" ? (big ? 0.05 : 0.01) : e.key === "ArrowLeft" ? -(big ? 0.05 : 0.01) : 0;
        const dn = e.key === "ArrowUp" ? (big ? 0.1 : 0.025) : e.key === "ArrowDown" ? -(big ? 0.1 : 0.025) : 0;
        if (!dx && !dn) return;
        e.preventDefault();
        const [x, y] = local[index];
        const next = moveCurvePoint(local, index, x + dx, normToSpeed(speedToNorm(y) + dn));
        setLocal(next);
        onCommit(next, true);
    };

    const yOf = (speed: number) => (1 - speedToNorm(speed)) * CURVE_H;
    return (
        <div className="on-curve" data-testid="curve-editor">
            <svg
                ref={svgRef}
                className="on-curve-svg"
                viewBox={`${-VIEW_PAD} ${-VIEW_PAD} ${CURVE_W + 2 * VIEW_PAD} ${CURVE_H + 2 * VIEW_PAD}`}
                role="group"
                aria-label={t("speed_editor")}
                onDoubleClick={onDoubleClick}
                onPointerDown={() => setSelected(null)}
            >
                <rect className="on-curve-frame" x={0} y={0} width={CURVE_W} height={CURVE_H} />
                {GRID.map((g) => (
                    <g key={g}>
                        <line className="on-curve-grid" data-unit={g === 1 ? "true" : undefined} x1={0} x2={CURVE_W} y1={yOf(g)} y2={yOf(g)} />
                        <text className="on-curve-label" x={CURVE_W - 4} textAnchor="end" y={Math.min(CURVE_H - 4, Math.max(10, yOf(g) - 4))}>{`${g}×`}</text>
                    </g>
                ))}
                <polyline className="on-curve-line" points={curvePolyline(local, CURVE_W, CURVE_H)} />
                {local.map(([x, y], i) => (
                    <circle
                        key={i}
                        ref={(el) => { pointRefs.current[i] = el; }}
                        className="on-curve-point"
                        cx={x * CURVE_W}
                        cy={yOf(y)}
                        r={6}
                        tabIndex={0}
                        role="slider"
                        aria-label={t("speed_point", { index: i + 1, speed: fmtSpeed(y), position: Math.round(x * 100) })}
                        aria-valuemin={0.1}
                        aria-valuemax={10}
                        aria-valuenow={y}
                        aria-valuetext={`${fmtSpeed(y)}×`}
                        aria-describedby={hintId}
                        data-selected={selected === i ? "true" : undefined}
                        data-removing={removing && drag.current?.index === i ? "true" : undefined}
                        data-testid={`curve-point-${i}`}
                        onPointerDown={onPointerDown(i)}
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={() => {
                            drag.current = null;
                            setRemoving(false);
                            setLocal(points);
                            onPreview?.(null);
                        }}
                        onFocus={() => setSelected(i)}
                        onKeyDown={onKeyDown(i)}
                    />
                ))}
            </svg>
            <p className="on-hint" id={hintId}>{t("speed_editorHint")}</p>
        </div>
    );
}
