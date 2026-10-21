"use client";
// Keyframe diamonds for the inspector (phase 10b, CapCut behaviour). A diamond is filled when its property
// has a keyframe under the playhead (±1 frame), outlined when the property is keyed elsewhere, and empty
// otherwise; a click adds a keyframe with the current values or removes the one under the playhead. While a
// property is keyed its sliders show the interpolated value at the playhead and write keyframes there
// instead of the static field. Only these rows follow the playhead (throttled, see use-playhead.ts).
import type { ReactNode } from "react";
import { ChartLine, ChevronLeft, ChevronRight } from "lucide-react";
import { hasChannel, pointEasing } from "@opennan/timeline-core/motion/keyframes";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { SliderRow } from "../controls";
import { EasingControl } from "./easing-control";
import { adjacentKeyframeTime, groupValuesAt, keyframeState, localTime, nearKeyframe, type ChannelSpec, type KeyframeState } from "./keyframe-model";
import { usePlayhead } from "./use-playhead";

/** A clip or scene as the keyframe rows see it. */
export interface KeyItem {
    id: string;
    target: { clipId: string } | { sceneId: string };
    /** Timeline seconds. */
    start: number;
    duration: number;
    points: TimelineKeyframePoint[];
}

export interface KeyframeGroup {
    keyed: boolean;
    state: KeyframeState;
    /** The playhead is over the item. */
    inside: boolean;
    /** Current values (channel units): interpolated at the playhead when keyed, else the static ones. */
    values: Record<string, number>;
    toggle(): void;
    /** Writes a keyed channel at the playhead (one coalesced step per drag); false when not keyed or outside. */
    write(channel: string, value: number): boolean;
}

const clampTime = (t: number, duration: number) => Math.min(duration, Math.max(0, t));

export function useKeyframeGroup(item: KeyItem, specs: readonly ChannelSpec[], name: string): KeyframeGroup {
    const controller = useTimelineController();
    const api = useEditorStoreApi();
    const channels = specs.map((spec) => spec.channel);
    const keyed = channels.some((channel) => hasChannel(item.points, channel));
    const inside = useEditorStore((s) => localTime(s.currentTime, item.start, item.duration) !== null);
    const playhead = usePlayhead(keyed);
    const local = keyed ? localTime(playhead, item.start, item.duration) : null;
    const { state } = keyframeState(item.points, channels, local);
    const values = groupValuesAt(item.points, specs, clampTime(playhead - item.start, item.duration));
    const nowLocal = () => localTime(api.getState().currentTime, item.start, item.duration);
    return {
        keyed,
        state,
        inside,
        values,
        toggle() {
            const t = nowLocal();
            if (t === null) return;
            const near = nearKeyframe(item.points, t, channels);
            if (near) void controller.execute({ type: "keyframe.remove", ...item.target, time: near.time, channels });
            else void controller.execute({ type: "keyframe.set", ...item.target, time: t, values: groupValuesAt(item.points, specs, t) });
        },
        write(channel, value) {
            if (!keyed) return false;
            const t = nowLocal();
            if (t === null) return false;
            const near = nearKeyframe(item.points, t, channels);
            void controller.execute(
                { type: "keyframe.set", ...item.target, time: near?.time ?? t, values: { ...groupValuesAt(item.points, specs, t), [channel]: value } },
                { coalesceKey: `kf-${item.id}-${name}`, debounceMs: 120 },
            );
            return true;
        },
    };
}

/** The diamond button. Right-click on a keyed property opens the graph editor on `graphChannel`. */
export function KeyframeToggle({ group, label, testId, graphChannel }: { group: KeyframeGroup; label: string; testId?: string; graphChannel?: string }) {
    const t = useTimelineMessages("studioEditor");
    const api = useEditorStoreApi();
    const aria = group.state === "on" ? t("kf_remove", { name: label }) : group.state === "keyed" ? t("kf_keyedElsewhere", { name: label }) : t("kf_add", { name: label });
    return (
        <button
            type="button"
            className="on-kf-toggle"
            data-state={group.state}
            data-testid={testId}
            aria-pressed={group.state === "on"}
            aria-label={aria}
            title={group.inside ? aria : t("kf_outside")}
            disabled={!group.inside}
            onClick={group.toggle}
            onContextMenu={(e) => {
                if (!group.keyed) return;
                e.preventDefault();
                api.getState().setKeyframeGraph({ open: true, ...(graphChannel ? { channel: graphChannel } : {}) });
            }}
        >
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" /></svg>
        </button>
    );
}

export interface KeyframedRow {
    channel: string;
    /** The static field value in channel units. */
    base: number;
    label: string;
    testId?: string;
    min: number;
    max: number;
    step?: number;
    defaultValue?: number;
    format?(value: number): string;
    /** Channel units → slider units and back. */
    toSlider(value: number): number;
    toChannel(value: number): number;
    /** Writes the static field (the property is not keyed). */
    onStatic(value: number): void;
}

/**
 * Sliders of one keyframable property (one channel, or position's x and y together). One row carries its
 * diamond beside the value; a group of rows gets a small heading with the diamond.
 */
export function KeyframedSliders({ item, name, label, rows, testId }: { item: KeyItem; name: string; label: string; rows: KeyframedRow[]; testId?: string }) {
    const group = useKeyframeGroup(item, rows.map((row) => ({ channel: row.channel, base: row.base })), name);
    const toggle = <KeyframeToggle group={group} label={label} testId={testId ?? `kf-toggle-${name}`} graphChannel={rows[0]?.channel} />;
    const sliders = rows.map((row) => (
        <SliderRow
            key={row.channel}
            label={row.label}
            testId={row.testId}
            value={row.toSlider(group.values[row.channel])}
            min={row.min}
            max={row.max}
            step={row.step}
            defaultValue={row.defaultValue}
            format={row.format}
            disabled={group.keyed && !group.inside}
            adornment={rows.length === 1 ? toggle : undefined}
            onChange={(v) => {
                if (!group.write(row.channel, row.toChannel(v))) row.onStatic(v);
            }}
        />
    ));
    if (rows.length === 1) return sliders[0];
    return (
        <div className="on-kf-group">
            <div className="on-kf-head">
                <span className="on-field-label">{label}</span>
                {toggle}
            </div>
            {sliders}
        </div>
    );
}

/** Prev / next keyframe and the easing of the keyframe under the playhead. Hidden while the item has none. */
export function KeyframeBar({ item, children }: { item: KeyItem; children?: ReactNode }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const api = useEditorStoreApi();
    const graphOpen = useEditorStore((s) => s.keyframeGraph.open);
    const any = item.points.length > 0;
    const playhead = usePlayhead(any);
    if (!any) return null;
    const local = clampTime(playhead - item.start, item.duration);
    const inside = localTime(playhead, item.start, item.duration) !== null;
    const point = inside ? nearKeyframe(item.points, local) : undefined;
    const prev = adjacentKeyframeTime(item.points, playhead - item.start, -1);
    const next = adjacentKeyframeTime(item.points, playhead - item.start, 1);
    // From the live playhead (the rendered one may lag by the throttle interval).
    const seek = (direction: -1 | 1) => {
        const time = adjacentKeyframeTime(item.points, api.getState().currentTime - item.start, direction);
        if (time !== null) void controller.execute({ type: "playhead.seek", seconds: item.start + time });
    };
    const easing = point ? pointEasing(point) : null;
    return (
        <div className="on-kf-bar" data-testid="kf-bar">
            <div className="on-row-between">
                <button type="button" className="on-icon-btn" aria-label={t("kf_prev")} data-testid="kf-prev" disabled={prev === null} onClick={() => seek(-1)}><ChevronLeft aria-hidden="true" /></button>
                <span className="on-kf-bar-label">
                    <svg viewBox="0 0 12 12" aria-hidden="true" data-on={point ? "true" : undefined}><path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" /></svg>
                    {point ? t("kf_atPlayhead", { time: `${point.time.toFixed(2)} s` }) : t("kf_count", { count: new Set(item.points.map((p) => p.time)).size })}
                </span>
                <button type="button" className="on-icon-btn" aria-label={t("kf_next")} data-testid="kf-next" disabled={next === null} onClick={() => seek(1)}><ChevronRight aria-hidden="true" /></button>
                <button
                    type="button"
                    className="on-icon-btn on-kf-graph-btn"
                    aria-pressed={graphOpen}
                    aria-label={graphOpen ? t("kf_graphClose") : t("kf_graphOpen")}
                    title={t("kf_graph")}
                    data-testid="kf-graph-toggle"
                    onClick={() => api.getState().setKeyframeGraph({ open: !graphOpen })}
                >
                    <ChartLine aria-hidden="true" />
                </button>
            </div>
            {point && easing && (
                <EasingControl
                    key={point.time}
                    easing={easing.id}
                    bezier={easing.bezier}
                    onChange={(id, bezier, coalesce) => void controller.execute(
                        { type: "keyframe.easing", ...item.target, time: point.time, easing: id, ...(bezier ? { bezier: [...bezier] as [number, number, number, number] } : {}) },
                        coalesce ? { coalesceKey: `kf-ease-${item.id}-${point.time}`, debounceMs: 120 } : undefined,
                    )}
                />
            )}
            {children}
        </div>
    );
}
