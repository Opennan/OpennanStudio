// A keyboard- and pointer-resizable divider (role="separator").
import { useRef, useState } from "react";

export interface SplitterProps {
    orientation: "vertical" | "horizontal";
    label: string;
    value: number;
    min: number;
    max: number;
    /** Positive pointer/arrow movement (right or down) changes the size by `direction` × delta. */
    direction: 1 | -1;
    onResize(next: number): void;
    onCommit(): void;
    onReset(): void;
    className?: string;
}

export function Splitter({ orientation, label, value, min, max, direction, onResize, onCommit, onReset, className }: SplitterProps) {
    const start = useRef<{ pointer: number; value: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const clamp = (v: number) => Math.min(max, Math.max(min, v));
    return (
        <div
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-orientation={orientation}
            aria-valuenow={Math.round(value)}
            aria-valuemin={min}
            aria-valuemax={max}
            data-dragging={dragging || undefined}
            className={`on-splitter ${className ?? ""}`}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start.current = { pointer: orientation === "vertical" ? e.clientX : e.clientY, value };
                setDragging(true);
            }}
            onPointerMove={(e) => {
                if (!start.current) return;
                const delta = (orientation === "vertical" ? e.clientX : e.clientY) - start.current.pointer;
                onResize(clamp(start.current.value + delta * direction));
            }}
            onPointerUp={() => {
                if (!start.current) return;
                start.current = null;
                setDragging(false);
                onCommit();
            }}
            onDoubleClick={onReset}
            onKeyDown={(e) => {
                const step = e.shiftKey ? 48 : 16;
                const keys = orientation === "vertical" ? { dec: "ArrowLeft", inc: "ArrowRight" } : { dec: "ArrowUp", inc: "ArrowDown" };
                if (e.key !== keys.dec && e.key !== keys.inc && e.key !== "Home" && e.key !== "End") return;
                e.preventDefault();
                if (e.key === "Home") onResize(min);
                else if (e.key === "End") onResize(max);
                else onResize(clamp(value + (e.key === keys.inc ? step : -step) * direction));
                onCommit();
            }}
        />
    );
}
