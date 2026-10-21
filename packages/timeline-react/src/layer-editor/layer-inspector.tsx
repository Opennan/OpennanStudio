// packages/timeline-react/src/layer-editor/layer-inspector.tsx
import { glyphLibrary, layoutText } from "@opennan/timeline-core/design/glyphs";
import type { DesignOp } from "@opennan/timeline-core/design/ops";
import type { LayerDesign, TextLayer } from "@opennan/timeline-core/design/model";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { selectionLayers, type Selection } from "./selection";

export interface LayerInspectorProps {
    design: LayerDesign;
    selection: Selection | null;
    /** `live`: mid-edit (typing, sliding) — preview only; otherwise one history step. */
    onOps(ops: DesignOp[], live?: boolean): void;
    onCommitLive(): void;
    fonts: readonly string[];
}

export function LayerInspector({ design, selection, onOps, onCommitLive, fonts }: LayerInspectorProps) {
    const t = useTimelineMessages("studioEditor");
    const layers = selectionLayers(design, selection);
    if (!selection || !layers.length) return <p className="on-layer-empty">{t("layerNothingSelected")}</p>;
    const target = selection.id;

    if (layers.length === 1 && layers[0].kind === "text") {
        const l = layers[0] as TextLayer;
        const out = layoutText(l, glyphLibrary(design));
        const note = out.mode === "original" ? t("layerLetteringOriginal")
            : out.mode === "glyphs" ? t("layerLetteringGlyphs")
            : out.missing.length ? t("layerLetteringMissing", { chars: out.missing.join(", "), font: l.style.font })
            : t("layerLetteringFont", { font: l.style.font });
        const choices = fonts.includes(l.style.font) ? fonts : [l.style.font, ...fonts];
        return (
            <div className="on-layer-inspector">
                <label className="on-layer-field">
                    <span>{t("layerText")}</span>
                    <textarea rows={2} value={l.text} onChange={(e) => onOps([{ op: "set_text", target, text: e.target.value.replace(/\n/g, " ") }], true)} onBlur={onCommitLive} />
                </label>
                <p className={`on-layer-mode is-${out.mode}`}>{note}</p>
                <label className="on-layer-field">
                    <span>{t("layerLettering")}</span>
                    <select value={l.lettering} onChange={(e) => onOps([{ op: "set_style", target, style: { lettering: e.target.value as "auto" | "font" } }])}>
                        <option value="auto">{t("layerLetteringAuto")}</option>
                        <option value="font">{t("layerLetteringForceFont")}</option>
                    </select>
                </label>
                <div className="on-layer-row2">
                    <label className="on-layer-field">
                        <span>{t("layerFont")}</span>
                        <select value={l.style.font} onChange={(e) => onOps([{ op: "set_style", target, style: { font: e.target.value } }])}>
                            {choices.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                    </label>
                    <label className="on-layer-field">
                        <span>{t("layerWeight")}</span>
                        <select value={l.style.weight} onChange={(e) => onOps([{ op: "set_style", target, style: { weight: Number(e.target.value) } }])}>
                            {[400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                        </select>
                    </label>
                </div>
                <div className="on-layer-row2">
                    <label className="on-layer-field">
                        <span>{t("layerFill")}</span>
                        <input type="color" value={l.style.fill} onChange={(e) => onOps([{ op: "set_style", target, style: { fill: e.target.value } }], true)} onBlur={onCommitLive} />
                    </label>
                    <label className="on-layer-field">
                        <span>{t("layerOutline")}</span>
                        <input type="color" value={l.style.stroke ?? "#000000"} onChange={(e) => onOps([{ op: "set_style", target, style: { stroke: e.target.value, strokeWidth: l.style.strokeWidth || 1.5 } }], true)} onBlur={onCommitLive} />
                    </label>
                </div>
                <label className="on-layer-check">
                    <input type="checkbox" checked={l.style.shadow} onChange={(e) => onOps([{ op: "set_style", target, style: { shadow: e.target.checked } }])} />
                    {t("layerShadowToggle")}
                </label>
            </div>
        );
    }

    const opacity = Math.round(layers[0].opacity * 100);
    return (
        <div className="on-layer-inspector">
            <p className="on-layer-kind">{selection.kind === "group" ? t("layerPieceCount", { count: layers.length }) : t("layerImage")}</p>
            <label className="on-layer-field">
                <span>{t("layerOpacity")}</span>
                <input type="range" min={0} max={100} value={opacity} onChange={(e) => onOps([{ op: "set_opacity", target, opacity: Number(e.target.value) / 100 }], true)} onPointerUp={onCommitLive} />
            </label>
            <div className="on-layer-row2">
                <button type="button" onClick={() => onOps([{ op: "reorder", target, to: "forward" }])}>{t("layerBringForward")}</button>
                <button type="button" onClick={() => onOps([{ op: "reorder", target, to: "backward" }])}>{t("layerSendBack")}</button>
            </div>
            <div className="on-layer-row2">
                <button type="button" onClick={() => onOps([{ op: "set_visible", target, visible: false }])}>{t("layerHide")}</button>
                <button type="button" onClick={() => onOps(layers.map((l) => ({ op: "rotate", target: l.id, degrees: -l.transform.rotation })))}>{t("layerResetRotation")}</button>
            </div>
        </div>
    );
}
