// Copy attributes / Paste attributes (phase 10c): the actions behind the timeline context menus, the inspector
// header, and the editor shortcuts (⌥⌘C / ⌥⌘V). Copy stores a snapshot in the store's attributeClipboard; paste
// opens the picker (store attributePastePicker), which runs one attributes.paste command.
import { useMemo } from "react";
import {
    ATTRIBUTE_KINDS, selectLiveScenes, snapshotAttributes,
    type AttributeItem, type AttributeKind, type AttributePasteReport, type AttributeTarget, type CommandResult, type EditorState, type EditorStore,
    type TimelineController,
} from "@opennan/timeline-core";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { useTimelineToast } from "../../hooks/use-timeline-toast";

/**
 * The item "Copy attributes" copies: the selected scene, else the primary selected clip. A scene that is only synced
 * to the playhead (sceneSelectedByUser false) is not a selection, so ⌥⌘C falls through to the marker-range copy.
 */
export function selectionAttributeItem(state: EditorState): AttributeItem | null {
    if (state.selectedSceneId && state.sceneSelectedByUser) {
        const scene = selectLiveScenes(state).find((s) => s.id === state.selectedSceneId);
        if (scene) return { kind: "scene", scene };
    }
    const clipId = state.selectedClipId ?? [...state.selectedClipIds][0];
    const clip = clipId ? state.timelineData?.clips.find((c) => c.id === clipId) : undefined;
    return clip ? { kind: "clip", clip } : null;
}

/**
 * The items "Paste attributes" pastes onto: every selected clip and every selected scene (phase 10c), else the selected
 * scene. Scenes count only when the user selected them, not the scene synced to the playhead.
 */
export function selectionAttributeTargets(state: EditorState): AttributeTarget[] {
    const ids = state.selectedClipIds.size > 0 ? [...state.selectedClipIds] : state.selectedClipId ? [state.selectedClipId] : [];
    const byUser = state.sceneSelectedByUser;
    const sceneIds = state.selectedSceneIds.size > 0 && byUser ? [...state.selectedSceneIds]
        : ids.length === 0 && byUser && state.selectedSceneId ? [state.selectedSceneId] : [];
    return [...ids.map((clipId) => ({ clipId })), ...sceneIds.map((sceneId) => ({ sceneId }))];
}

/** Kinds the user unticked last time (among the ones they could tick); the rest start ticked. */
export const PASTE_ATTRIBUTES_STORAGE_KEY = "opennan-studio:paste-attributes";

export function loadExcludedAttributeKinds(): AttributeKind[] {
    try {
        const raw = globalThis.localStorage?.getItem(PASTE_ATTRIBUTES_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        const excluded = (parsed as { excluded?: unknown } | null)?.excluded;
        return Array.isArray(excluded) ? ATTRIBUTE_KINDS.filter((kind) => excluded.includes(kind)) : [];
    } catch {
        return [];
    }
}

export function saveExcludedAttributeKinds(excluded: readonly AttributeKind[]): void {
    try {
        globalThis.localStorage?.setItem(PASTE_ATTRIBUTES_STORAGE_KEY, JSON.stringify({ excluded }));
    } catch {
        // Private mode or a full quota: the choice is just not remembered.
    }
}

/** ⌥⌘C / ⌥⌘V on Apple platforms, Ctrl+Alt+C / Ctrl+Alt+V elsewhere (menu hints). */
export function attributeShortcutLabel(key: "C" | "V"): string {
    const platform = typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
    return /Mac|iPhone|iPad/i.test(platform) ? `⌥ ⌘ ${key}` : `Ctrl Alt ${key}`;
}

export interface AttributeActions {
    /** Copies the item's attributes (default: the selection's). False when there was nothing to copy. */
    copy(item?: AttributeItem | null): boolean;
    /** Opens the paste picker for the targets (default: the selection). False when it cannot open. */
    openPaste(targets?: AttributeTarget[]): boolean;
    /** Pastes the kinds of the clipboard onto the targets (one attributes.paste) and announces the result. */
    paste(kinds: AttributeKind[], targets: AttributeTarget[]): Promise<CommandResult | null>;
}

export interface AttributeActionDeps {
    store: EditorStore;
    controller: Pick<TimelineController, "execute">;
    notify(kind: "success" | "info", message: string): void;
    t: (key: AttributeMessageKey, values?: Record<string, string | number>) => string;
}

type AttributeMessageKey =
    | "attrSelectToCopy" | "attrNothingToCopy" | "attrCopied" | "attrClipboardEmpty" | "attrSelectToPaste"
    | "attrPasted" | "attrPartlySkipped" | "attrNothingPasted" | `attrKind_${AttributeKind}`;

/** The actions without React (the editor keymap and tests build them from the store and controller). */
export function createAttributeActions({ store, controller, notify, t }: AttributeActionDeps): AttributeActions {
    return {
        copy(item) {
            const source = item === undefined ? selectionAttributeItem(store.getState()) : item;
            if (!source) {
                notify("info", t("attrSelectToCopy"));
                return false;
            }
            const snapshot = snapshotAttributes(source);
            if (snapshot.kinds.length === 0) {
                notify("info", t("attrNothingToCopy"));
                return false;
            }
            store.getState().setAttributeClipboard(snapshot);
            notify("success", t("attrCopied", { list: snapshot.kinds.map((kind) => t(`attrKind_${kind}`)).join(", ") }));
            return true;
        },
        openPaste(targets) {
            const state = store.getState();
            if (!state.attributeClipboard) {
                notify("info", t("attrClipboardEmpty"));
                return false;
            }
            const list = targets ?? selectionAttributeTargets(state);
            if (list.length === 0) {
                notify("info", t("attrSelectToPaste"));
                return false;
            }
            state.setAttributePastePicker({ targets: list });
            return true;
        },
        async paste(kinds, targets) {
            const snapshot = store.getState().attributeClipboard;
            if (!snapshot || kinds.length === 0 || targets.length === 0) return null;
            const result = await controller.execute({ type: "attributes.paste", source: snapshot, targets, attributes: kinds });
            const report = result.output as AttributePasteReport | undefined;
            if (result.ok && report) {
                const count = report.applied.length;
                const partly = report.skipped.some((entry) => entry.reason !== "source");
                if (count > 0) notify("success", t(partly ? "attrPartlySkipped" : "attrPasted", { count }));
                else notify("info", t("attrNothingPasted"));
            } else if (!result.ok && report) {
                // Nothing applied (no backend call, so the controller did not toast).
                notify("info", t("attrNothingPasted"));
            }
            return result;
        },
    };
}

export function useAttributeActions(): AttributeActions {
    const store = useEditorStoreApi();
    const controller = useTimelineController();
    const toast = useTimelineToast();
    const t = useTimelineMessages("studioEditor");
    return useMemo(() => createAttributeActions({
        store, controller, t: (key, values) => t(key as never, values),
        notify: (kind, message) => {
            toast[kind](message);
        },
    }), [store, controller, toast, t]);
}
