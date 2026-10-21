// packages/timeline-react/src/layer-editor/layer-list.tsx
import type { DesignLayer, LayerDesign } from "@opennan/timeline-core/design/model";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import type { Selection } from "./selection";

export interface LayerListProps {
    design: LayerDesign;
    selection: Selection | null;
    onSelect(sel: Selection): void;
    onToggle(target: string, visible: boolean): void;
}

interface Row {
    sel: Selection;
    label: string;
    visible: boolean;
    child: boolean;
    locked: boolean;
    thumb?: string;
}

export function LayerList({ design, selection, onSelect, onToggle }: LayerListProps) {
    const t = useTimelineMessages("studioEditor");
    const labelOf = (l: DesignLayer) =>
        l.kind === "text" ? l.text : l.role === "background" ? t("layerBackground") : l.role === "shadow" ? t("layerShadow") : l.name ?? t("layerImage");
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const l of [...design.layers].reverse()) {
        if (l.group) {
            if (seen.has(l.group)) continue;
            seen.add(l.group);
            const members = design.layers.filter((m) => m.group === l.group);
            const texts = members.filter((m) => m.kind === "text").map(labelOf);
            const img = members.find((m) => m.kind === "image");
            rows.push({ sel: { kind: "group", id: l.group }, label: texts.join(" · ") || t("layerArtPiece"), visible: members.some((m) => m.visible), child: false, locked: false, thumb: img?.kind === "image" ? img.src : undefined });
            const open = selection && (selection.id === l.group || members.some((m) => m.id === selection.id));
            if (open) for (const m of [...members].reverse()) rows.push({ sel: { kind: "layer", id: m.id }, label: labelOf(m), visible: m.visible, child: true, locked: Boolean(m.locked), thumb: m.kind === "image" ? m.src : undefined });
        } else {
            rows.push({ sel: { kind: "layer", id: l.id }, label: labelOf(l), visible: l.visible, child: false, locked: Boolean(l.locked), thumb: l.kind === "image" ? l.src : undefined });
        }
    }
    return (
        <ul className="on-layer-list" aria-label={t("layerLayers")}>
            {rows.map((r) => (
                <li key={`${r.sel.kind}:${r.sel.id}`} className={`on-layer-row${r.child ? " is-child" : ""}${selection?.id === r.sel.id ? " is-selected" : ""}`}>
                    <button type="button" className="on-layer-row-main" disabled={r.locked} onClick={() => onSelect(r.sel)}>
                        <span className="on-layer-thumb" aria-hidden>{r.thumb ? "" : "T"}</span>
                        <span className="on-layer-row-label">{r.label}</span>
                    </button>
                    {!r.locked && (
                        <button type="button" className="on-layer-eye" aria-label={`${r.visible ? t("layerHide") : t("layerShow")} ${r.label}`} onClick={() => onToggle(r.sel.id, !r.visible)}>
                            {r.visible ? t("layerHide") : t("layerShow")}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}
