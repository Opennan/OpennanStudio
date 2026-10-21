"use client";
// Easing of the keyframe under the playhead (phase 10b): Linear, Ease in, Ease out, Ease in-out, Hold,
// Bezier. Bezier shows a small curve with two draggable handles (pointer: one keyframe.easing on release;
// arrows: 0.05 steps, Shift 0.1, coalesced; sliders valued by their y with both axes in the value text). Tokens only; the curve and handles take the current text colour.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_BEZIER, EASING_IDS, easeValue, normalizeBezier, type BezierHandles, type EasingId } from "@opennan/timeline-core/motion/easing";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";

const GLYPH_W = 24;
const GLYPH_H = 14;

/** A tiny polyline of an easing for its button. */
export function easingGlyphPath(id: EasingId, handles?: readonly number[] | null): string {
    const steps = 16;
    const out: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
        const u = i / steps;
        const y = id === "hold" ? (u < 1 ? 0 : 1) : easeValue(id, u, handles);
        out.push(`${(u * GLYPH_W).toFixed(1)},${((1 - y) * GLYPH_H).toFixed(1)}`);
    }
    return out.join(" ");
}

// Bezier editor geometry: x in [0, 1], y shown over [-0.5, 1.5] (normalizeBezier allows [-1, 2]).
const BOX_W = 168;
const BOX_H = 120;
const PAD = 10;
const Y_LO = -0.5;
const Y_HI = 1.5;
const toPx = (x: number, y: number): [number, number] => [PAD + x * (BOX_W - 2 * PAD), PAD + ((Y_HI - y) / (Y_HI - Y_LO)) * (BOX_H - 2 * PAD)];

/** Pointer (box pixels) → handle coordinates, clamped to the editable range. */
export function bezierHandleFromPx(px: number, py: number): [number, number] {
    const x = (px - PAD) / (BOX_W - 2 * PAD);
    const y = Y_HI - ((py - PAD) / (BOX_H - 2 * PAD)) * (Y_HI - Y_LO);
    const r = (v: number) => Math.round(v * 100) / 100;
    return [r(Math.min(1, Math.max(0, x))), r(Math.min(Y_HI, Math.max(Y_LO, y)))];
}

export function EasingControl({ easing, bezier, onChange }: {
    easing: EasingId;
    bezier: BezierHandles | null;
    onChange(easing: EasingId, bezier: BezierHandles | null, coalesce?: boolean): void;
}) {
    const t = useTimelineMessages("studioEditor");
    return (
        <div className="on-field" data-testid="kf-easing">
            <span className="on-field-label">{t("kf_easing")}</span>
            <div className="on-ease-grid" role="group" aria-label={t("kf_easing")}>
                {EASING_IDS.map((id) => (
                    <button
                        key={id}
                        type="button"
                        className="on-ease-btn"
                        aria-pressed={easing === id}
                        data-testid={`ease-${id}`}
                        onClick={() => onChange(id, id === "bezier" ? bezier ?? DEFAULT_BEZIER : null)}
                    >
                        <svg viewBox={`-1 -1 ${GLYPH_W + 2} ${GLYPH_H + 2}`} aria-hidden="true"><polyline points={easingGlyphPath(id, id === "bezier" ? bezier ?? DEFAULT_BEZIER : null)} /></svg>
                        <span>{t(`ease_${id}` as never)}</span>
                    </button>
                ))}
            </div>
            {easing === "bezier" && <BezierEditor handles={bezier ?? DEFAULT_BEZIER} onChange={(h, coalesce) => onChange("bezier", h, coalesce)} />}
        </div>
    );
}

function BezierEditor({ handles, onChange }: { handles: BezierHandles; onChange(handles: BezierHandles, coalesce?: boolean): void }) {
    const t = useTimelineMessages("studioEditor");
    const [local, setLocal] = useState<BezierHandles>(handles);
    const drag = useRef<{ index: 0 | 1; pointerId: number } | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    useEffect(() => {
        if (!drag.current) setLocal(handles);
    }, [handles]);
    const [x1, y1, x2, y2] = local;
    const p0 = toPx(0, 0);
    const p3 = toPx(1, 1);
    const h1 = toPx(x1, y1);
    const h2 = toPx(x2, y2);
    const setHandle = (index: 0 | 1, x: number, y: number): BezierHandles => {
        const next = normalizeBezier(index === 0 ? [x, y, x2, y2] : [x1, y1, x, y]);
        setLocal(next);
        return next;
    };
    const boxPoint = (e: PointerEvent) => {
        const rect = svgRef.current!.getBoundingClientRect();
        const sx = rect.width ? BOX_W / rect.width : 1;
        const sy = rect.height ? BOX_H / rect.height : 1;
        return bezierHandleFromPx((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
    };
    const onDown = (index: 0 | 1) => (e: PointerEvent<SVGCircleElement>) => {
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        drag.current = { index, pointerId: e.pointerId };
    };
    const onMove = (e: PointerEvent<SVGCircleElement>) => {
        if (!drag.current || drag.current.pointerId !== e.pointerId) return;
        const [x, y] = boxPoint(e);
        setHandle(drag.current.index, x, y);
    };
    const onUp = (e: PointerEvent<SVGCircleElement>) => {
        if (!drag.current || drag.current.pointerId !== e.pointerId) return;
        const [x, y] = boxPoint(e);
        const next = setHandle(drag.current.index, x, y);
        drag.current = null;
        onChange(next);
    };
    const onKey = (index: 0 | 1) => (e: KeyboardEvent<SVGCircleElement>) => {
        const step = e.shiftKey ? 0.1 : 0.05;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        const [hx, hy] = index === 0 ? [x1, y1] : [x2, y2];
        const r = (v: number) => Math.round(v * 100) / 100;
        onChange(setHandle(index, r(Math.min(1, Math.max(0, hx + dx))), r(Math.min(Y_HI, Math.max(Y_LO, hy + dy)))), true);
    };
    const handle = (index: 0 | 1, [cx, cy]: [number, number], [hx, hy]: [number, number]) => (
        <circle
            className="on-bezier-handle"
            cx={cx}
            cy={cy}
            r={6}
            tabIndex={0}
            role="slider"
            aria-label={t("ease_handle", { n: index + 1 })}
            // A 2-D handle: the slider value is its progress (y, what Up/Down move); the text gives both axes.
            aria-valuenow={hy}
            aria-valuemin={Y_LO}
            aria-valuemax={Y_HI}
            aria-valuetext={`${hx.toFixed(2)}, ${hy.toFixed(2)}`}
            data-testid={`bezier-handle-${index + 1}`}
            onPointerDown={onDown(index)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => { drag.current = null; setLocal(handles); }}
            onKeyDown={onKey(index)}
        />
    );
    return (
        <div className="on-bezier" data-testid="bezier-editor">
            <svg ref={svgRef} viewBox={`0 0 ${BOX_W} ${BOX_H}`} role="group" aria-label={t("ease_editor")}>
                <rect className="on-bezier-frame" x={p0[0]} y={p3[1]} width={p3[0] - p0[0]} height={p0[1] - p3[1]} />
                <line className="on-bezier-arm" x1={p0[0]} y1={p0[1]} x2={h1[0]} y2={h1[1]} />
                <line className="on-bezier-arm" x1={p3[0]} y1={p3[1]} x2={h2[0]} y2={h2[1]} />
                <path className="on-bezier-curve" d={`M${p0[0]},${p0[1]} C${h1[0]},${h1[1]} ${h2[0]},${h2[1]} ${p3[0]},${p3[1]}`} />
                {handle(0, h1, [x1, y1])}
                {handle(1, h2, [x2, y2])}
            </svg>
            <button type="button" className="on-btn on-btn-ghost" onClick={() => onChange(DEFAULT_BEZIER)}>{t("ease_reset")}</button>
        </div>
    );
}
