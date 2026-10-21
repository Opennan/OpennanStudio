"use client";
// The "Paste attributes" picker (phase 10c): which kinds of the copied item to paste onto the targets in
// store.attributePastePicker. Kinds the clipboard lacks or no target takes are shown disabled; the others start
// ticked except the ones the user unticked last time (remembered in localStorage). Paste runs one attributes.paste.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ATTRIBUTE_KINDS, acceptedAttributeKinds, selectLiveScenes, type AttributeItem, type AttributeKind } from "@opennan/timeline-core";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import { loadExcludedAttributeKinds, saveExcludedAttributeKinds, useAttributeActions } from "./use-attribute-actions";

export function AttributePastePicker() {
    const picker = useEditorStore((s) => s.attributePastePicker);
    const store = useEditorStoreApi();
    const close = () => store.getState().setAttributePastePicker(null);
    return (
        <Dialog open={picker !== null} onOpenChange={(open) => { if (!open) close(); }}>
            {/* New targets start a fresh choice (remount). */}
            {picker && <PickerBody key={JSON.stringify(picker.targets)} targets={picker.targets} onClose={close} />}
        </Dialog>
    );
}

function PickerBody({ targets, onClose }: { targets: Array<{ clipId?: string; sceneId?: string }>; onClose(): void }) {
    const t = useTimelineMessages("studioEditor");
    const actions = useAttributeActions();
    const snapshot = useEditorStore((s) => s.attributeClipboard);
    const timeline = useEditorStore((s) => s.timelineData);
    const scenes = useEditorStore((s) => selectLiveScenes(s));
    // Kinds at least one target takes.
    const accepted = useMemo(() => {
        const out = new Set<AttributeKind>();
        for (const target of targets) {
            const scene = target.sceneId ? scenes.find((s) => s.id === target.sceneId) : undefined;
            const clip = !target.sceneId && target.clipId ? timeline?.clips.find((c) => c.id === target.clipId) : undefined;
            const item: AttributeItem | null = scene ? { kind: "scene", scene } : clip ? { kind: "clip", clip } : null;
            if (item) for (const kind of acceptedAttributeKinds(item)) out.add(kind);
        }
        return out;
    }, [targets, scenes, timeline]);
    const available = useMemo(() => ATTRIBUTE_KINDS.filter((kind) => snapshot?.kinds.includes(kind) && accepted.has(kind)), [snapshot, accepted]);
    const [checked, setChecked] = useState<Set<AttributeKind>>(() => {
        const excluded = new Set(loadExcludedAttributeKinds());
        return new Set(available.filter((kind) => !excluded.has(kind)));
    });
    // Clipboard or selection changed under the open picker: keep only what can still be pasted.
    useEffect(() => {
        setChecked((current) => {
            const next = new Set([...current].filter((kind) => available.includes(kind)));
            return next.size === current.size ? current : next;
        });
    }, [available]);
    const toggle = (kind: AttributeKind, on: boolean) => setChecked((current) => {
        const next = new Set(current);
        if (on) next.add(kind);
        else next.delete(kind);
        return next;
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const kinds = ATTRIBUTE_KINDS.filter((kind) => checked.has(kind));
        if (kinds.length === 0) return;
        saveExcludedAttributeKinds(available.filter((kind) => !checked.has(kind)));
        onClose();
        void actions.paste(kinds, targets);
    };
    const source = snapshot?.source.label ?? t(snapshot?.source.itemType === "scene" ? "attrFromScene" : "attrFromClip");
    return (
        <DialogContent showCloseButton={false} className="on-editing on-attr-dialog" data-testid="paste-attributes-dialog">
            <form onSubmit={submit} className="on-attr-form">
                <div className="on-attr-head">
                    <DialogTitle className="on-attr-title">{t("attrPasteTitle")}</DialogTitle>
                    <DialogDescription className="on-attr-desc">
                        {t("attrFrom", { source })} · {t("attrOnto", { count: targets.length })}
                    </DialogDescription>
                </div>
                <fieldset className="on-attr-list">
                    <legend className="on-attr-legend">{t("attrKindsLabel")}</legend>
                    {ATTRIBUTE_KINDS.map((kind) => {
                        const enabled = available.includes(kind);
                        const reason = !snapshot?.kinds.includes(kind) ? t("attrNotCopied") : !accepted.has(kind) ? t("attrNotApplicable") : null;
                        const hintId = `paste-attr-${kind}-hint`;
                        return (
                            <label key={kind} className="on-attr-row" data-disabled={enabled ? undefined : "true"}>
                                <input
                                    type="checkbox"
                                    className="on-attr-check"
                                    name={kind}
                                    data-testid={`paste-attr-${kind}`}
                                    checked={enabled && checked.has(kind)}
                                    disabled={!enabled}
                                    aria-describedby={reason ? hintId : undefined}
                                    onChange={(e) => toggle(kind, e.currentTarget.checked)}
                                />
                                <span className="on-attr-name">{t(`attrKind_${kind}` as never)}</span>
                                {/* Read as the checkbox's description, not part of its name. */}
                                {reason && <span id={hintId} className="on-attr-hint" aria-hidden="true">{reason}</span>}
                            </label>
                        );
                    })}
                </fieldset>
                <div className="on-attr-actions">
                    <button type="button" className="on-btn on-btn-ghost" onClick={onClose}>{t("attrCancel")}</button>
                    <button type="submit" className="on-btn on-btn-primary" data-testid="paste-attributes-confirm" disabled={checked.size === 0} autoFocus>
                        {t("attrPasteButton")}
                    </button>
                </div>
            </form>
        </DialogContent>
    );
}
