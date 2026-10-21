"use client";
// Timeline keyframe diamonds you can use (phase 10c). The selected clip's or scene's diamonds are hit targets
// (core hit-detector): a press selects the keyframe (store selectedKeyframe, drawn white with a ring), a click
// seeks the playhead to it, a horizontal drag retimes it (30 fps grid and the playhead magnet, live ghost,
// ONE keyframe.retime on release, Escape cancels), Delete / Backspace removes it (every channel at that time,
// one keyframe.remove), and right-click opens a menu: easing, delete, and the graph editor. The keyboard
// layer (keyframe-keyboard-layer.tsx, phase 10d) opens the same menu (openMenu) and reports the focused diamond.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChartLine, Check, Diamond, Trash2 } from "lucide-react";
import type { SelectedKeyframe } from "@opennan/timeline-core";
import { DEFAULT_BEZIER, EASING_IDS, type EasingId } from "@opennan/timeline-core/motion/easing";
import { pointAt, pointEasing } from "@opennan/timeline-core/motion/keyframes";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { snapKeyframeTime } from "@opennan/timeline-core/timeline/canvas/keyframe-markers";
import { getKeyframeItemGeometry } from "@opennan/timeline-core/timeline/canvas/timeline-renderer";
import type { CanvasState, HitResult } from "@opennan/timeline-core/timeline/canvas/types";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { CTX_MENU_ITEM_CLASS, CTX_MENU_SHELL_CLASS, CTX_MENU_SHORTCUT_CLASS, CtxSeparator, getContextMenuStyle } from "./canvas-context-menu";

export type KeyframeTarget = { clipId: string } | { sceneId: string };
type Target = KeyframeTarget;

/** How a keyboard-opened menu hands focus back: closed (Escape, a choice) or the keyframe was deleted. */
export type KeyframeMenuRestore = (reason: "close" | "deleted") => void;

interface KeyframeDrag {
    target: Target;
    from: number;
    to: number;
    /** Item start (timeline seconds) and length. */
    start: number;
    duration: number;
    /** World x (px) of the press. */
    startWorldX: number;
    armed: boolean;
}

interface KeyframeMenu {
    x: number;
    y: number;
    target: Target;
    time: number;
    /** The keyframe's easing when the menu opened. */
    easing: ReturnType<typeof pointEasing> | null;
    /** Set when the keyboard opened the menu: focus goes back to the diamond when it closes. */
    restore?: KeyframeMenuRestore;
}

export interface TimelineKeyframeEnv {
    /** The canvas state the hit was computed on (scroll, zoom, layout, playhead). */
    getState(): CanvasState;
    /** The canvas element's client rect. */
    getCanvasRect(): DOMRect | null;
    requestRender(): void;
    setCursor(cursor: string): void;
}

export interface TimelineKeyframes {
    /** Left press: true when it landed on a diamond (the canvas stops there); otherwise drops the keyframe selection. */
    handleMouseDown(e: ReactMouseEvent, hit: HitResult | null): boolean;
    /** Right-click: true when it opened the keyframe menu. */
    handleContextMenu(e: ReactMouseEvent, hit: HitResult | null): boolean;
    isDragging(): boolean;
    /** Fields the renderer reads: the selected keyframe, the retime ghost, and the keyboard-focused diamond. */
    overlayState(): Pick<CanvasState, "selectedKeyframe" | "keyframeDrag" | "focusedKeyframe">;
    /** Opens the easing menu for a keyframe at client (x, y); `restore` hands focus back when it closes. */
    openMenu(target: KeyframeTarget, time: number, x: number, y: number, restore?: KeyframeMenuRestore): void;
    /** The diamond whose keyboard button has focus (null on blur): the canvas draws its focus ring. */
    setFocusedKeyframe(keyframe: SelectedKeyframe | null): void;
    menu: ReactNode;
}

const DRAG_THRESHOLD_PX = 3;
const MENU_WIDTH = 220;
const MENU_HEIGHT = 300;

const targetOf = (hit: { clipId?: string; sceneId?: string }): Target | null =>
    hit.clipId ? { clipId: hit.clipId } : hit.sceneId ? { sceneId: hit.sceneId } : null;

/** Keys aimed at a field, a button, a text box, or the graph editor (it handles its own) are not the timeline's. */
export function isKeyframeKeyTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).closest !== "function") return true;
    const element = target as Element;
    if (element.closest("[data-keyframe-graph], [data-keyframe-keys]")) return false;
    if (!(element instanceof HTMLElement)) return true;
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || element.isContentEditable) return false;
    return !element.closest("[role=\"textbox\"], [contenteditable=\"true\"], [role=\"menu\"]");
}

/** The keyframe points of the item a target names, as the timeline shows it. */
function itemPoints(state: Pick<CanvasState, "clips" | "scenes">, target: Target) {
    if ("clipId" in target) return parseTimelineKeyframes(state.clips.find((c) => c.id === target.clipId)?.keyframesJson ?? null);
    return parseTimelineKeyframes(state.scenes.find((s) => s.id === target.sceneId)?.keyframesJson ?? null);
}

export function useTimelineKeyframes(env: TimelineKeyframeEnv, options: { shortcutsEnabled?: boolean } = {}): TimelineKeyframes {
    const storeApi = useEditorStoreApi();
    const controller = useTimelineController();
    const t = useTimelineMessages("studioEditor");
    const envRef = useRef(env);
    envRef.current = env;
    const dragRef = useRef<KeyframeDrag | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    const [menu, setMenu] = useState<KeyframeMenu | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const focusedRef = useRef<SelectedKeyframe | null>(null);
    const shortcutsEnabled = options.shortcutsEnabled ?? true;

    // A selection change (here or anywhere) redraws the ring.
    useEffect(() => storeApi.subscribe((s) => s.selectedKeyframe, () => envRef.current.requestRender()), [storeApi]);

    const endDrag = useCallback(() => {
        detachRef.current?.();
        detachRef.current = null;
        dragRef.current = null;
        envRef.current.requestRender();
    }, []);

    useEffect(() => () => detachRef.current?.(), []);

    const worldXOf = (clientX: number) => {
        const rect = envRef.current.getCanvasRect();
        return clientX - (rect?.left ?? 0) + envRef.current.getState().scrollLeft;
    };

    const seek = useCallback((seconds: number) => {
        void controller.execute({ type: "playhead.seek", seconds: Math.max(0, seconds) });
    }, [controller]);

    const handleMouseDown = useCallback((e: ReactMouseEvent, hit: HitResult | null): boolean => {
        const store = storeApi.getState();
        if (!hit || hit.type !== "keyframe" || hit.keyframeTime === undefined) {
            if (store.selectedKeyframe) store.selectKeyframe(null);
            return false;
        }
        const target = targetOf(hit);
        const state = envRef.current.getState();
        const geometry = getKeyframeItemGeometry(state);
        if (!target || !geometry) return false;
        e.preventDefault();
        setMenu(null);
        const time = hit.keyframeTime;
        store.selectKeyframe({ ...target, time } as SelectedKeyframe);
        detachRef.current?.();
        dragRef.current = {
            target, from: time, to: time, start: geometry.start, duration: geometry.duration,
            startWorldX: worldXOf(e.clientX), armed: false,
        };
        const onMove = (event: MouseEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            const current = envRef.current.getState();
            const dx = worldXOf(event.clientX) - drag.startWorldX;
            if (!drag.armed && Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
            drag.armed = true;
            drag.to = snapKeyframeTime(drag.from + dx / current.zoom, {
                duration: drag.duration,
                localPlayhead: current.currentTime - drag.start,
                zoom: current.zoom,
                snapEnabled: current.snapEnabled,
            }).time;
            envRef.current.setCursor("grabbing");
            envRef.current.requestRender();
        };
        const onUp = () => {
            const drag = dragRef.current;
            endDrag();
            envRef.current.setCursor("grab");
            if (!drag) return;
            if (!drag.armed) {
                seek(drag.start + drag.from);
                return;
            }
            if (Math.abs(drag.to - drag.from) < 0.0005) return;
            void controller.execute({ type: "keyframe.retime", ...drag.target, from: drag.from, to: drag.to }).then((result) => {
                // Refused (a locked track, a stale point): keep the keyframe where it is selected.
                if (!result.ok) storeApi.getState().selectKeyframe({ ...drag.target, time: drag.from } as SelectedKeyframe);
            });
            storeApi.getState().selectKeyframe({ ...drag.target, time: drag.to } as SelectedKeyframe);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !dragRef.current) return;
            // Cancel the retime, and keep Escape from also clearing the selection.
            event.preventDefault();
            event.stopPropagation();
            endDrag();
            envRef.current.setCursor("grab");
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("keydown", onKey, true);
        detachRef.current = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("keydown", onKey, true);
        };
        envRef.current.requestRender();
        return true;
    }, [controller, endDrag, seek, storeApi]);

    const handleContextMenu = useCallback((e: ReactMouseEvent, hit: HitResult | null): boolean => {
        if (!hit || hit.type !== "keyframe" || hit.keyframeTime === undefined) return false;
        const target = targetOf(hit);
        if (!target) return false;
        e.preventDefault();
        storeApi.getState().selectKeyframe({ ...target, time: hit.keyframeTime } as SelectedKeyframe);
        const point = pointAt(itemPoints(envRef.current.getState(), target), hit.keyframeTime);
        setMenu({ x: e.clientX, y: e.clientY, target, time: hit.keyframeTime, easing: point ? pointEasing(point) : null });
        return true;
    }, [storeApi]);

    const openMenu = useCallback((target: Target, time: number, x: number, y: number, restore?: KeyframeMenuRestore) => {
        const point = pointAt(itemPoints(envRef.current.getState(), target), time);
        setMenu({ x, y, target, time, easing: point ? pointEasing(point) : null, restore });
    }, []);

    const setFocusedKeyframe = useCallback((keyframe: SelectedKeyframe | null) => {
        const current = focusedRef.current;
        if (current === keyframe || (current && keyframe && current.time === keyframe.time
            && current.clipId === keyframe.clipId && current.sceneId === keyframe.sceneId)) return;
        focusedRef.current = keyframe;
        envRef.current.requestRender();
    }, []);

    // Delete / Backspace removes the selected keyframe. Capture phase on window: before the editor keymap
    // (document) and the canvas scene keys (window bubble), which then see defaultPrevented and stand down.
    useEffect(() => {
        if (!shortcutsEnabled) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Delete" && event.key !== "Backspace") return;
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const selected = storeApi.getState().selectedKeyframe;
            if (!selected || !isKeyframeKeyTarget(event.target)) return;
            const target = targetOf(selected);
            if (!target) return;
            // The keyframe went away (removed or moved elsewhere): Delete is the clip shortcuts' again.
            if (!pointAt(itemPoints(envRef.current.getState(), target), selected.time)) {
                storeApi.getState().selectKeyframe(null);
                return;
            }
            event.preventDefault();
            void controller.execute({ type: "keyframe.remove", ...target, time: selected.time });
            storeApi.getState().selectKeyframe(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [controller, shortcutsEnabled, storeApi]);

    // The menu closes on a press outside it, Escape, or scrolling; it takes focus for the keyboard.
    useEffect(() => {
        if (!menu) return;
        const close = (event: Event) => {
            if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
            setMenu(null);
        };
        window.addEventListener("mousedown", close, true);
        window.addEventListener("wheel", close, { capture: true, passive: true });
        menuRef.current?.querySelector<HTMLElement>("[role^=\"menuitem\"]")?.focus();
        return () => {
            window.removeEventListener("mousedown", close, true);
            window.removeEventListener("wheel", close, { capture: true });
        };
    }, [menu]);

    const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            menu?.restore?.("close");
            return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^=\"menuitem\"]") ?? [])];
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
    };

    let menuNode: ReactNode = null;
    if (menu) {
        const current = menu.easing;
        const setEasing = (id: EasingId) => {
            setMenu(null);
            menu.restore?.("close");
            const bezier = id === "bezier" ? [...(current?.bezier ?? DEFAULT_BEZIER)] as [number, number, number, number] : undefined;
            void controller.execute({ type: "keyframe.easing", ...menu.target, time: menu.time, easing: id, ...(bezier ? { bezier } : {}) });
            if (id === "bezier") {
                // Shape the curve: the graph editor shows the segment's handles, the easing bar its bezier editor.
                const geometry = getKeyframeItemGeometry(envRef.current.getState());
                if (geometry) seek(geometry.start + menu.time);
                storeApi.getState().setKeyframeGraph({ open: true });
            }
        };
        const easingLabel = (id: EasingId) => (id === "bezier" ? t("kf_customBezier") : t(`ease_${id}` as never));
        menuNode = (
            <div
                ref={menuRef}
                role="menu"
                aria-label={t("kf_menu", { time: `${menu.time.toFixed(2)} s` })}
                data-testid="keyframe-menu"
                className={CTX_MENU_SHELL_CLASS}
                style={getContextMenuStyle(menu.x, menu.y, MENU_WIDTH, MENU_HEIGHT)}
                onKeyDown={onMenuKeyDown}
                onContextMenu={(event) => event.preventDefault()}
            >
                <div className="flex h-7 items-center gap-2 px-3 text-[11px] leading-none opacity-60" aria-hidden="true">
                    <Diamond className="h-3 w-3" />
                    {t("kf_menu", { time: `${menu.time.toFixed(2)} s` })}
                </div>
                {EASING_IDS.map((id) => (
                    <button
                        key={id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current?.id === id}
                        data-testid={`keyframe-menu-ease-${id}`}
                        className={CTX_MENU_ITEM_CLASS}
                        onClick={() => setEasing(id)}
                    >
                        <span aria-hidden="true" className="w-3.5 shrink-0">{current?.id === id && <Check className="h-3.5 w-3.5" />}</span>
                        <span className="min-w-0 flex-1 truncate">{easingLabel(id)}</span>
                    </button>
                ))}
                <CtxSeparator />
                <button
                    type="button"
                    role="menuitem"
                    data-testid="keyframe-menu-graph"
                    className={CTX_MENU_ITEM_CLASS}
                    onClick={() => {
                        setMenu(null);
                        menu.restore?.("close");
                        storeApi.getState().setKeyframeGraph({ open: true });
                    }}
                >
                    <span aria-hidden="true" className="shrink-0"><ChartLine className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate">{t("kf_openGraph")}</span>
                </button>
                <button
                    type="button"
                    role="menuitem"
                    data-testid="keyframe-menu-delete"
                    className={CTX_MENU_ITEM_CLASS}
                    onClick={() => {
                        setMenu(null);
                        void controller.execute({ type: "keyframe.remove", ...menu.target, time: menu.time });
                        storeApi.getState().selectKeyframe(null);
                        menu.restore?.("deleted");
                    }}
                >
                    <span aria-hidden="true" className="shrink-0"><Trash2 className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate">{t("kf_delete")}</span>
                    <span className={CTX_MENU_SHORTCUT_CLASS}>⌫</span>
                </button>
            </div>
        );
    }

    return {
        handleMouseDown,
        handleContextMenu,
        isDragging: () => dragRef.current !== null,
        overlayState: () => {
            const drag = dragRef.current;
            return {
                selectedKeyframe: storeApi.getState().selectedKeyframe,
                keyframeDrag: drag?.armed ? { ...drag.target, from: drag.from, to: drag.to } : null,
                focusedKeyframe: focusedRef.current,
            };
        },
        openMenu,
        setFocusedKeyframe,
        menu: menuNode,
    };
}
