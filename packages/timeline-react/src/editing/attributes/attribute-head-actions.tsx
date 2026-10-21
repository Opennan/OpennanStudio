"use client";
// Inspector header entry point for Copy attributes / Paste attributes (phase 10c).
import { ClipboardCopy, ClipboardPaste } from "lucide-react";
import type { AttributeItem } from "@opennan/timeline-core";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { attributeShortcutLabel, selectionAttributeTargets, useAttributeActions } from "./use-attribute-actions";

export function AttributeHeadActions({ item }: { item: AttributeItem }) {
    const t = useTimelineMessages("studioEditor");
    const actions = useAttributeActions();
    const store = useEditorStoreApi();
    const hasClipboard = useEditorStore((s) => s.attributeClipboard !== null);
    const copyLabel = t("attrCopy");
    const pasteLabel = t("attrPaste");
    return (
        <div className="on-inspector-actions">
            <button type="button" className="on-icon-btn" data-testid="inspector-copy-attributes" aria-label={copyLabel} title={`${copyLabel} (${attributeShortcutLabel("C")})`} onClick={() => actions.copy(item)}>
                <ClipboardCopy aria-hidden="true" />
            </button>
            <button
                type="button" className="on-icon-btn" data-testid="inspector-paste-attributes" aria-label={pasteLabel} title={`${pasteLabel} (${attributeShortcutLabel("V")})`}
                disabled={!hasClipboard} aria-haspopup="dialog"
                onClick={() => {
                    const targets = selectionAttributeTargets(store.getState());
                    actions.openPaste(targets.length > 0 ? targets : [item.kind === "clip" ? { clipId: item.clip.id } : { sceneId: item.scene.id }]);
                }}
            >
                <ClipboardPaste aria-hidden="true" />
            </button>
        </div>
    );
}
