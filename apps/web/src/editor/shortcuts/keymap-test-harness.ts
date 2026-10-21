// Test harness for the keymap: a real controller over LocalBackend and the same
// adapters the timeline uses. Imported by *.test.ts files only.
import {
    LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, optimistic,
    type SceneData, type TimelineClip, type TimelineTrack,
} from "@opennan/timeline-core";
import { createAttributeActions, createTimelineCommandAdapters } from "@opennan/timeline-react";
import { dispatchShortcut, type EditorKeymapContext, type ShortcutRule } from "./keymap-context";

export function track(type: TimelineTrack["type"], index: number, extra: Partial<TimelineTrack> = {}): TimelineTrack {
    return { type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1, ...extra };
}

export const TRACKS: TimelineTrack[] = [track("video", 1), track("audio", 1), track("text", 1), track("text", 2)];

export function textClip(id: string, startTime: number, endTime: number, extra: Partial<TimelineClip> = {}): TimelineClip {
    return {
        ...optimistic.optimisticTimelineClipFromInput(
            { trackType: "text", trackIndex: 1, startTime, endTime, mediaType: "text", textContent: id, label: id }, "p1", id,
        ),
        ...extra,
    };
}

export interface KeymapHarness {
    store: ReturnType<typeof createEditorStore>;
    controller: TimelineController;
    ctx: EditorKeymapContext;
    splitCalls: boolean[];
    toasts: Array<{ message: string; icon?: string }>;
    clips(): TimelineClip[];
    press(init: KeyboardEventInit & { key: string }, target?: EventTarget): KeyboardEvent;
    dispatch(event: KeyboardEvent): void;
}

export async function createKeymapHarness(
    rules: readonly ShortcutRule[],
    seed: { clips?: TimelineClip[]; scenes?: SceneData[]; tracks?: TimelineTrack[] } = {},
): Promise<KeymapHarness> {
    let n = 0;
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `srv-${++n}` });
    await backend.seedProject("p1", { tracks: seed.tracks ?? TRACKS, clips: seed.clips ?? [], scenes: seed.scenes ?? [] });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "p1" });
    await controller.load();
    const splitCalls: boolean[] = [];
    const toasts: Array<{ message: string; icon?: string }> = [];
    const ctx: EditorKeymapContext = {
        store,
        controller,
        ops: createTimelineCommandAdapters(controller, store),
        splitAtPlayhead: (activeTrackOnly) => splitCalls.push(activeTrackOnly),
        toast: (message, options) => toasts.push({ message, icon: options?.icon }),
        messages: { audioLockedDelete: "Locked" },
        now: () => 42,
        attributes: createAttributeActions({ store, controller, t: (key) => key, notify: (_kind, message) => toasts.push({ message }) }),
    };
    return {
        store,
        controller,
        ctx,
        splitCalls,
        toasts,
        clips: () => store.getState().timelineData?.clips ?? [],
        press(init, target) {
            const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
            if (target) Object.defineProperty(event, "target", { value: target });
            dispatchShortcut(rules, event, ctx);
            return event;
        },
        dispatch: (event) => dispatchShortcut(rules, event, ctx),
    };
}
