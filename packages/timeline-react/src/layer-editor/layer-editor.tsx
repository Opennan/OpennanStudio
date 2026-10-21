// packages/timeline-react/src/layer-editor/layer-editor.tsx
// Canva-style editor for a layered design. Every change is a design op, so `ref.apply(ops)` (the agent's
// path) and the mouse go through the same code and the same undo history.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { applyDesignOps, type ApplyResult, type DesignOp } from "@opennan/timeline-core/design/ops";
import { describeDesign, type DesignSummary } from "@opennan/timeline-core/design/summary";
import type { LayerDesign } from "@opennan/timeline-core/design/model";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { DesignCanvas } from "./design-canvas";
import { LayerInspector } from "./layer-inspector";
import { LayerList } from "./layer-list";
import type { Selection } from "./selection";
import { useDesignHistory } from "./use-design-history";

export interface LayerEditorHandle {
    apply(ops: DesignOp[]): ApplyResult;
    describe(): DesignSummary;
    getDesign(): LayerDesign;
    select(sel: Selection | null): void;
    undo(): void;
    redo(): void;
}

export interface LayerEditorProps {
    initialDesign: LayerDesign;
    onChange?(design: LayerDesign): void;
    /** Maps a design src to a loadable URL (relative files, media ids). */
    resolveSrc?(src: string): string;
    /** Font families the host has loaded, offered in the inspector. */
    fonts?: readonly string[];
    ref?: Ref<LayerEditorHandle>;
}

const identity = (s: string) => s;

export function LayerEditor({ initialDesign, onChange, resolveSrc = identity, fonts = [], ref }: LayerEditorProps) {
    const t = useTimelineMessages("studioEditor");
    const history = useDesignHistory(initialDesign);
    const [selection, setSelection] = useState<Selection | null>(null);
    const [showOriginal, setShowOriginal] = useState(false);
    const liveStart = useRef<LayerDesign | null>(null);
    const designRef = useRef(history.design);
    designRef.current = history.design;

    useEffect(() => { onChange?.(history.design); }, [history.design, onChange]);

    const apply = useCallback((ops: DesignOp[]) => {
        const out = applyDesignOps(designRef.current, ops);
        if (out.changed) history.commit(out.design, designRef.current);
        designRef.current = out.design;
        return out;
    }, [history]);

    const onInspectorOps = useCallback((ops: DesignOp[], live?: boolean) => {
        const base = designRef.current;
        const out = applyDesignOps(base, ops);
        if (!out.changed) return;
        if (live) {
            liveStart.current ??= base;
            history.preview(out.design);
        } else {
            history.commit(out.design, liveStart.current ?? base);
            liveStart.current = null;
        }
        designRef.current = out.design;
    }, [history]);

    const commitLive = useCallback(() => {
        if (liveStart.current) history.commit(designRef.current, liveStart.current);
        liveStart.current = null;
    }, [history]);

    useImperativeHandle(ref, () => ({
        apply,
        describe: () => describeDesign(designRef.current),
        getDesign: () => designRef.current,
        select: setSelection,
        undo: history.undo,
        redo: history.redo,
    }), [apply, history.undo, history.redo]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
            if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
            e.preventDefault();
            if (e.shiftKey) history.redo();
            else history.undo();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [history]);

    return (
        <section className="on-layer-editor" aria-label={t("layerEditorLabel")}>
            <div className="on-layer-toolbar">
                <button type="button" aria-pressed={showOriginal} onPointerDown={() => setShowOriginal(true)} onPointerUp={() => setShowOriginal(false)} onPointerLeave={() => setShowOriginal(false)} disabled={!history.design.source}>
                    {t("layerShowOriginal")}
                </button>
                <button type="button" onClick={history.undo} disabled={!history.canUndo}>{t("layerUndo")}</button>
                <button type="button" onClick={history.redo} disabled={!history.canRedo}>{t("layerRedo")}</button>
            </div>
            <div className="on-layer-body">
                <div className="on-layer-stage">
                    <DesignCanvas
                        design={history.design}
                        selection={selection}
                        onSelect={setSelection}
                        onPreview={(d) => { designRef.current = d; history.preview(d); }}
                        onCommit={(d, before) => { designRef.current = d; history.commit(d, before); }}
                        resolveSrc={resolveSrc}
                        showOriginal={showOriginal}
                    />
                </div>
                <aside className="on-layer-side">
                    <div className="on-layer-panel">
                        <h3>{t("layerSelected")}</h3>
                        <LayerInspector design={history.design} selection={selection} onOps={onInspectorOps} onCommitLive={commitLive} fonts={fonts} />
                    </div>
                    <div className="on-layer-panel">
                        <h3>{t("layerLayers")}</h3>
                        <LayerList design={history.design} selection={selection} onSelect={setSelection} onToggle={(target, visible) => apply([{ op: "set_visible", target, visible }])} />
                    </div>
                </aside>
            </div>
        </section>
    );
}
