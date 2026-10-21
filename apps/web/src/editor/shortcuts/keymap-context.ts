// Shared pieces of the editor keymap, the host-level keyboard handler the source
// editor ran (SRC/app/(dashboard)/video/[projectId]/editor-layout.tsx:1700-3838).
// Each rule ports one `if (...)` branch of that handler, in source order. A rule's
// run() returns true where the branch returned and false where it fell through.
import {
    commits, editing, selectLiveScenes,
    type EditorState, type EditorStore, type SceneData, type TimelineClip, type TimelineClipCommand, type TimelineClipUpdateCommit,
    type TimelineTrack, type TimelineController,
} from "@opennan/timeline-core";
// The type comes from the module path, as NleTimeline imports it (nle-timeline.tsx:125-126): the bundled
// declarations turn types inside the `editing` namespace into values, so `editing.TimelineDuplicateClip` is not a type there.
import type { TimelineDuplicateClip } from "@opennan/timeline-core/lib/timeline-editing";
import type { AttributeActions, TimelineCommandAdapters, TimelineToastOptions } from "@opennan/timeline-react";

export interface EditorKeymapContext {
    store: EditorStore;
    /** Runs the multi-item commands (phase 10c: items.delete / items.duplicate / items.paste). */
    controller: Pick<TimelineController, "execute">;
    /** The same clip runners the timeline uses (useTimelineCommandAdapters); the source called timelineRef.current. */
    ops: TimelineCommandAdapters;
    /** TimelineHandle.splitAtPlayhead, which replaced the timeline-split-at-playhead window event (:1826-1832). */
    splitAtPlayhead(activeTrackOnly: boolean): void;
    toast(message: string, options?: TimelineToastOptions): void;
    messages: { audioLockedDelete: string };
    /** Request ids: Date.now() for addTextRequest (:2993), performance.now() for deleteSelectionRequest (:2749). */
    now(): number;
    /** Copy attributes / open the Paste attributes picker for the selection (phase 10c, useAttributeActions). */
    attributes: Pick<AttributeActions, "copy" | "openPaste">;
}

export interface ShortcutRun {
    event: KeyboardEvent;
    ctx: EditorKeymapContext;
    /** State at keydown, read once like the source's useEditorStore.getState() (:1725); its actions write the live store. */
    store: EditorState;
    clips: TimelineClip[];
    /** The same clips typed for the duplicate/paste planners, cast as NleTimeline does (nle-timeline.tsx:2043). */
    clipRows: TimelineDuplicateClip[];
    tracks: TimelineTrack[];
    /** Live scenes (the source's liveScenes, :603). */
    scenes: SceneData[];
    clipId: string | null;
}

export interface ShortcutRule {
    id: string;
    /** editor-layout.tsx lines this rule ports. */
    source: string;
    when(event: KeyboardEvent): boolean;
    run(run: ShortcutRun): boolean;
}

export const mod = (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey;
export const is = (event: KeyboardEvent, ...keys: string[]): boolean => keys.includes(event.key);
/** No modifier at all, the source's `!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey`. */
export const plain = (event: KeyboardEvent): boolean => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
export const altOnly = (event: KeyboardEvent): boolean => event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
export const altShift = (event: KeyboardEvent): boolean => event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
export const deleteKey = (event: KeyboardEvent): boolean => is(event, "Delete", "Backspace");

/** :1703-1714. Keys aimed at a field, a button, or a text box never reach the shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON"
        || target.isContentEditable
        || Boolean(target.closest("[role=\"textbox\"], [contenteditable=\"true\"], [data-chat-panel]"));
}

/** :1715-1722. With page text selected, Ctrl/Cmd+C, X, A stay native. */
export function nativeTextCopyWins(event: KeyboardEvent): boolean {
    if (!(mod(event) && is(event, "c", "C", "x", "X", "a", "A"))) return false;
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim().length > 0);
}

export function dispatchShortcut(rules: readonly ShortcutRule[], event: KeyboardEvent, ctx: EditorKeymapContext): void {
    if (isTypingTarget(event.target)) return;
    if (nativeTextCopyWins(event)) return;
    const store = ctx.store.getState();
    const clips = store.timelineData?.clips ?? [];
    const run: ShortcutRun = {
        event,
        ctx,
        store,
        clips,
        clipRows: clips as unknown as TimelineDuplicateClip[],
        tracks: store.timelineData?.tracks ?? [],
        scenes: selectLiveScenes(store),
        clipId: store.selectedClipId,
    };
    for (const rule of rules) {
        if (rule.when(event) && rule.run(run)) return;
    }
}

/** :1727-1734 getEditableSelection. */
export function editableSelection(r: ShortcutRun): Set<string> {
    return editing.getEditableTimelineSelectionClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId);
}

/** :1735 hasTimelineSelection. */
export function hasTimelineSelection(r: ShortcutRun): boolean {
    return r.store.selectedClipIds.size > 0 || Boolean(r.clipId);
}

/** :1736-1741 selectCreatedSplitClips, also the `created.filter(Boolean)` selection after creates. */
export function selectCreated(r: ShortcutRun, created: ReadonlyArray<{ id?: string | null } | null>): void {
    const ids = created.map((clip) => clip?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) r.store.setSelectedClipIds(new Set(ids));
}

export function updateRunner(r: ShortcutRun) {
    return { updateClip: r.ctx.ops.onUpdateClip, updateClips: r.ctx.ops.onUpdateClips };
}

export function splitRunner(r: ShortcutRun) {
    return { splitClip: r.ctx.ops.onSplitClip, splitClips: r.ctx.ops.onSplitClips };
}

export function createRunner(r: ShortcutRun) {
    return { createClip: r.ctx.ops.onCreateClip, createClips: r.ctx.ops.onCreateClips };
}

export function commandRunner(r: ShortcutRun) {
    return {
        ...createRunner(r),
        ...updateRunner(r),
        deleteClip: r.ctx.ops.onDeleteClip,
        deleteClips: r.ctx.ops.onDeleteClips,
        clipCommand: r.ctx.ops.onCommitClipCommand,
    };
}

/** The source's `if (commits.length > 0) void commitTimelineClipUpdates(...)`. */
export function commitUpdates(r: ShortcutRun, list: TimelineClipUpdateCommit[]): void {
    if (list.length > 0) void commits.commitTimelineClipUpdates(list, updateRunner(r));
}

/** The many property branches: preventDefault, compute commits for the selection, commit them when there are any. */
export function commitRule(
    id: string,
    source: string,
    when: (event: KeyboardEvent) => boolean,
    plan: (run: ShortcutRun) => TimelineClipUpdateCommit[],
): ShortcutRule {
    return {
        id,
        source,
        when,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, plan(r));
            return true;
        },
    };
}

/** commitTimelineClipCommand, optionally selecting what it created. */
export function commitBatch(r: ShortcutRun, command: TimelineClipCommand, selectAfter: boolean): void {
    void commits.commitTimelineClipCommand(command, commandRunner(r)).then((created) => {
        if (selectAfter) selectCreated(r, created);
    });
}

export function commitCreates(r: ShortcutRun, inputs: Parameters<typeof commits.commitTimelineClipCreates>[0]): void {
    void commits.commitTimelineClipCreates(inputs, createRunner(r)).then((created) => selectCreated(r, created));
}

export function commitSplits(r: ShortcutRun, clipIds: string[], atSeconds: number): void {
    void commits.commitTimelineClipSplits(clipIds, atSeconds, splitRunner(r)).then((created) => selectCreated(r, created));
}

/** setSelectedClipId(null) + setSelectedClipIds(ids), the source's range-select pair. */
export function replaceSelection(r: ShortcutRun, ids: Set<string>): void {
    r.store.setSelectedClipId(null);
    r.store.setSelectedClipIds(ids);
}

/** setSeekRequest + setShuttleSpeed(0), the source's jump pair. */
export function seek(r: ShortcutRun, seconds: number): void {
    r.store.setSeekRequest(seconds);
    r.store.setShuttleSpeed(0);
}
