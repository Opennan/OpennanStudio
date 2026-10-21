"use client";
// Keyboard keyframes (phase 10d). The selected clip's or scene's diamonds stay drawn on the canvas; this layer
// mirrors them as a horizontal listbox of visually hidden options placed over the drawn diamonds (world
// coordinates inside the scrolling timeline content, so they scroll and zoom with it, and pointer-events: none so
// the mouse keeps talking to the canvas). One tab stop for the group (roving tabindex):
//   focus             selects the keyframe (store selectedKeyframe) and seeks the playhead to it, as a click does;
//                     the canvas draws the focus ring (--on-ring) around that diamond
//   Left / Right      retime by one frame (Shift: ten) through keyframe.retime, one undo step per press, on the
//                     30 fps grid and clamped to the item like a drag; a move never merges into another keyframe
//                     (it hops over one in the way); the playhead follows
//   Alt+Left / Right  previous / next keyframe; Home / End: first / last
//   Delete, Backspace keyframe.remove, focus moves to the next keyframe (or the previous; the canvas after the last)
//   Enter, Space      the easing menu (the right-click menu); Escape or a choice returns focus to the diamond
// Handled keys stop here (preventDefault + stopPropagation), so the editor shortcuts (clip nudges, playhead
// arrows, clip Delete) never see them; Tab / Shift+Tab only stop propagating, so focus leaves the group natively
// instead of the editor's Tab (select the next clip); every other key (undo, play, ...) reaches the shortcuts.
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SelectedKeyframe } from "@opennan/timeline-core";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";
import { easingFromCode } from "@opennan/timeline-core/motion/easing";
import { KEYFRAME_CHANNELS, KEYFRAME_MERGE_TOLERANCE, KEYFRAME_META_KEYS } from "@opennan/timeline-core/motion/keyframes";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { KEYFRAME_FPS, KEYFRAME_HIT_HALF_HEIGHT, KEYFRAME_HIT_HALF_WIDTH, snapKeyframeTime } from "@opennan/timeline-core/timeline/canvas/keyframe-markers";
import { KEYFRAME_MARKER_INSET, type KeyframeItemGeometry } from "@opennan/timeline-core/timeline/canvas/timeline-renderer";
import { channelLabel } from "../../editing/inspector/keyframe-graph";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import type { KeyframeMenuRestore, KeyframeTarget, TimelineKeyframes } from "./keyframe-interaction";

type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;

export interface KeyframeKeyboardLayerProps {
    /** The selected item's diamonds as drawn (getKeyframeItemGeometry), null when it has none to edit. */
    geometry: KeyframeItemGeometry | null;
    /** The timeline's clips and scenes (the item's name, channels, and easing for the labels). */
    clips: readonly Pick<TimelineClip, "id" | "label" | "textContent" | "keyframesJson">[];
    scenes: readonly Pick<SceneData, "id" | "caption" | "keyframesJson">[];
    keyframes: Pick<TimelineKeyframes, "openMenu" | "setFocusedKeyframe">;
    /** Where focus goes when the last keyframe is deleted. */
    onEmpty(): void;
}

const CHANNEL_ORDER: readonly string[] = [...KEYFRAME_CHANNELS, "mask_x", "mask_y", "mask_w", "mask_h", "mask_rotation", "mask_feather"];
const same = (a: number, b: number) => Math.abs(a - b) <= KEYFRAME_MERGE_TOLERANCE + 1e-9;
const roundMs = (t: number) => Math.round(t * 1000) / 1000;

/** "Position, Scale": the point's channels by their inspector names, x/y pairs and mask channels once. */
function channelsText(t: Translate, point: TimelineKeyframePoint | undefined): string {
    if (!point) return "";
    const keys = Object.keys(point).filter((key) => !KEYFRAME_META_KEYS.includes(key) && typeof point[key] === "number");
    keys.sort((a, b) => (CHANNEL_ORDER.indexOf(a) + 1 || 999) - (CHANNEL_ORDER.indexOf(b) + 1 || 999));
    const labels: string[] = [];
    for (const key of keys) {
        const label = key === "position_x" || key === "position_y" ? t("kf_position")
            : key.startsWith("mask_") ? t("tabMask")
                : channelLabel(t, key);
        if (!labels.includes(label)) labels.push(label);
    }
    return labels.join(", ");
}

const NAME_MAX = 60;
const shortName = (text: string | null | undefined) => {
    const name = (text ?? "").replace(/\s+/g, " ").trim();
    return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
};

export function KeyframeKeyboardLayer({ geometry, clips, scenes, keyframes, onEmpty }: KeyframeKeyboardLayerProps) {
    const t = useTimelineMessages("studioEditor");
    const storeApi = useEditorStoreApi();
    const controller = useTimelineController();
    const selected = useEditorStore((s) => s.selectedKeyframe);
    const hintId = useId();
    const listRef = useRef<HTMLDivElement | null>(null);
    const [announcement, setAnnouncement] = useState("");
    // Where the tab stop last sat (per item) when no keyframe is selected, and a time to move DOM focus to
    // once the timeline shows it.
    const [active, setActive] = useState<{ item: string; time: number } | null>(null);
    const pendingFocusRef = useRef<number | null>(null);

    const target: KeyframeTarget | null = geometry?.clipId ? { clipId: geometry.clipId } : geometry?.sceneId ? { sceneId: geometry.sceneId } : null;
    const times = useMemo(() => {
        const out: number[] = [];
        for (const time of geometry?.times ?? []) if (!out.some((t) => same(t, time))) out.push(time);
        return out;
    }, [geometry?.times]);
    const clip = geometry?.clipId ? clips.find((c) => c.id === geometry.clipId) : undefined;
    const sceneIndex = geometry?.sceneId ? scenes.findIndex((s) => s.id === geometry.sceneId) : -1;
    const scene = sceneIndex >= 0 ? scenes[sceneIndex] : undefined;
    const keyframesJson = (clip ?? scene)?.keyframesJson ?? null;
    const points = useMemo(() => parseTimelineKeyframes(keyframesJson), [keyframesJson]);
    const itemName = clip
        ? shortName(clip.label) || shortName(clip.textContent) || t("kf_keysClip")
        : shortName(scene?.caption) || t("kf_keysScene", { n: sceneIndex + 1 });

    const itemKey = geometry?.clipId ? `clip:${geometry.clipId}` : `scene:${geometry?.sceneId ?? ""}`;
    const setActiveTime = (time: number) => setActive({ item: itemKey, time });
    const ofItem = (k: SelectedKeyframe | null) => Boolean(k && target && (("clipId" in target && k.clipId === target.clipId) || ("sceneId" in target && k.sceneId === target.sceneId)));
    const selectedIndex = ofItem(selected) ? times.findIndex((time) => same(time, selected!.time)) : -1;
    // The tab stop: the selected keyframe, else where it last was, else the first.
    const activeIndex = (() => {
        if (selectedIndex >= 0) return selectedIndex;
        const index = active?.item === itemKey ? times.findIndex((time) => same(time, active.time)) : -1;
        return Math.max(0, index);
    })();

    const sec = (time: number) => t("seconds", { value: time.toFixed(2) });
    const keyOf = (time: number) => ({ ...target, time }) as SelectedKeyframe;

    const seek = (time: number) => {
        if (!geometry) return;
        const seconds = Math.max(0, geometry.start + time);
        if (Math.abs(storeApi.getState().currentTime - seconds) < 1e-6) return;
        void controller.execute({ type: "playhead.seek", seconds });
    };

    /** Selects + seeks a keyframe and makes it the tab stop (what focusing a diamond means). */
    const activate = (time: number) => {
        const store = storeApi.getState();
        const current = store.selectedKeyframe;
        if (!ofItem(current) || !same(current!.time, time)) store.selectKeyframe(keyOf(time));
        setActiveTime(time);
        seek(time);
    };

    const optionFor = (time: number) => [...(listRef.current?.querySelectorAll<HTMLElement>("[role=\"option\"]") ?? [])]
        .find((el) => same(Number(el.dataset.time), time)) ?? null;

    const focusTime = (time: number) => {
        const option = optionFor(time);
        if (option) option.focus();
        else pendingFocusRef.current = time;
    };

    // After the timeline updates (a retime landed, a keyframe went away), move DOM focus to the keyframe it asked for.
    useLayoutEffect(() => {
        const time = pendingFocusRef.current;
        if (time === null) return;
        const option = optionFor(time);
        if (!option) return;
        pendingFocusRef.current = null;
        if (document.activeElement !== option) option.focus();
    });

    const remove = (time: number, alreadyRemoved: boolean) => {
        if (!target) return;
        const index = times.findIndex((t) => same(t, time));
        const neighbour = times[index + 1] ?? times[index - 1];
        if (!alreadyRemoved) void controller.execute({ type: "keyframe.remove", ...target, time });
        setAnnouncement(t("kf_keysDeleted", { time: sec(time) }));
        if (neighbour === undefined) {
            keyframes.setFocusedKeyframe(null);
            storeApi.getState().selectKeyframe(null);
            onEmpty();
            return;
        }
        // Until the timeline drops the removed keyframe its option still exists: focus the neighbour's now,
        // and again once the options shift.
        pendingFocusRef.current = neighbour;
        activate(neighbour);
        keyframes.setFocusedKeyframe(keyOf(neighbour));
        optionFor(neighbour)?.focus();
    };

    const retime = (time: number, direction: 1 | -1, frames: number) => {
        if (!geometry || !target) return;
        const others = times.filter((t) => !same(t, time));
        const land = (raw: number) => snapKeyframeTime(raw, { duration: geometry.duration, localPlayhead: null, zoom: geometry.w / Math.max(0.001, geometry.duration), snapEnabled: false }).time;
        let to = land(time + (direction * frames) / KEYFRAME_FPS);
        // Never merge: hop over keyframes in the way; stop when the item's edge is taken.
        for (let guard = 0; others.some((t) => same(t, to)) && guard < 10000; guard++) {
            const next = land(to + direction / KEYFRAME_FPS);
            if (same(next, to)) return;
            to = next;
        }
        if (same(to, time) || others.some((t) => same(t, to))) return;
        to = roundMs(to);
        const from = time;
        void controller.execute({ type: "keyframe.retime", ...target, from, to }).then((result) => {
            if (result.ok) return;
            // Refused (a locked track, a stale point): the keyframe stays where it was.
            storeApi.getState().selectKeyframe(keyOf(from));
            setActiveTime(from);
            pendingFocusRef.current = from;
            keyframes.setFocusedKeyframe(keyOf(from));
        });
        storeApi.getState().selectKeyframe(keyOf(to));
        setActiveTime(to);
        pendingFocusRef.current = to;
        keyframes.setFocusedKeyframe(keyOf(to));
        seek(to);
        setAnnouncement(t("kf_keysMoved", { time: sec(to) }));
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
        const time = times[index];
        if (time === undefined || !target || event.ctrlKey || event.metaKey) return;
        if (event.key === "Tab") {
            // Native focus traversal out of the group; the editor keymap's Tab (select the next clip) stays out.
            event.stopPropagation();
            return;
        }
        const { key, altKey, shiftKey } = event;
        let handled = true;
        if ((key === "ArrowLeft" || key === "ArrowRight") && altKey) {
            const next = times[index + (key === "ArrowRight" ? 1 : -1)];
            if (next !== undefined) focusTime(next);
        } else if ((key === "ArrowLeft" || key === "ArrowRight") && !altKey) {
            retime(time, key === "ArrowRight" ? 1 : -1, shiftKey ? 10 : 1);
        } else if ((key === "Home" || key === "End") && !altKey && !shiftKey) {
            focusTime(times[key === "Home" ? 0 : times.length - 1]);
        } else if ((key === "Delete" || key === "Backspace") && !altKey && !shiftKey) {
            remove(time, false);
        } else if ((key === "Enter" || key === " ") && !altKey) {
            const rect = event.currentTarget.getBoundingClientRect();
            const restore: KeyframeMenuRestore = (reason) => {
                if (reason === "deleted") remove(time, true);
                else focusTime(time);
            };
            keyframes.openMenu(target, time, rect.left + rect.width / 2, rect.bottom, restore);
        } else {
            handled = false;
        }
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
    };

    const d = Math.max(0.001, geometry?.duration ?? 0);
    const cy = geometry ? geometry.y + geometry.h - KEYFRAME_MARKER_INSET : 0;

    return (
        <>
            {geometry && target && times.length > 0 && (
                <div
                    ref={listRef}
                    role="listbox"
                    aria-orientation="horizontal"
                    aria-label={t("kf_keysGroup", { name: itemName })}
                    aria-describedby={hintId}
                    data-keyframe-keys=""
                    data-testid="keyframe-keys"
                    className="pointer-events-none absolute left-0 top-0 z-10 h-0 w-0"
                >
                    {times.map((time, index) => {
                        const point = points.find((p) => same(p.time, time));
                        const easing = t(`ease_${easingFromCode(point?.easing)}` as never);
                        const cx = geometry.x + (time / d) * geometry.w;
                        return (
                            <div
                                // Index keys: a retime that keeps the order keeps the same focused element.
                                key={index}
                                role="option"
                                tabIndex={index === activeIndex ? 0 : -1}
                                aria-selected={index === selectedIndex}
                                aria-label={t("kf_keysItem", { time: sec(time), channels: channelsText(t, point), easing })}
                                data-time={time}
                                data-testid={`keyframe-key-${index}`}
                                className="absolute bg-transparent outline-none"
                                style={{
                                    left: `${cx - KEYFRAME_HIT_HALF_WIDTH}px`,
                                    top: `${cy - KEYFRAME_HIT_HALF_HEIGHT}px`,
                                    width: `${KEYFRAME_HIT_HALF_WIDTH * 2}px`,
                                    height: `${KEYFRAME_HIT_HALF_HEIGHT * 2}px`,
                                }}
                                onFocus={() => {
                                    activate(time);
                                    keyframes.setFocusedKeyframe(keyOf(time));
                                }}
                                onBlur={(event) => {
                                    if (!listRef.current?.contains(event.relatedTarget as Node | null)) keyframes.setFocusedKeyframe(null);
                                }}
                                onKeyDown={(event) => onKeyDown(event, index)}
                            />
                        );
                    })}
                </div>
            )}
            {geometry && <span id={hintId} hidden>{t("kf_keysHint")}</span>}
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
        </>
    );
}
