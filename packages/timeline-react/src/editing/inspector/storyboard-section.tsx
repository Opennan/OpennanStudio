"use client";
// The scene inspector's Storyboard section (phase 9c): the scene's drawn storyboard on OpenNan — each sheet's image and
// its panels, read only. A click opens an image large with Back, Next and Close (keyboard reachable). States by icon and
// words; --on-* tokens only.
import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import type { SceneData } from "@opennan/timeline-core";
import { useTimelineMedia } from "../../hooks/use-timeline-media";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { storyboardImages, storyboardOf } from "../storyboard";

export function StoryboardSection({ scene }: { scene: SceneData }) {
    const t = useTimelineMessages("studioEditor");
    const media = useTimelineMedia();
    const sheets = storyboardOf(scene);
    const images = storyboardImages(sheets);
    const [open, setOpen] = useState<number | null>(null);
    if (images.length === 0) return null;
    const panels = images.filter((image) => image.kind === "panel").length;
    const altOf = (image: (typeof images)[number]) => (image.kind === "sheet"
        ? t("storyboardSheetAlt", { n: image.sheet + 1 })
        : t("storyboardPanelAlt", { n: image.panel + 1, count: panels }));
    const shown = open === null ? null : images[open] ?? null;
    return (
        <section className="on-storyboard" data-testid="inspector-storyboard" aria-label={t("storyboardTitle")}>
            <div className="on-storyboard-head">
                <LayoutGrid aria-hidden="true" />
                <h3 className="on-section-title">{t("storyboardTitle")}</h3>
                <span className="on-hint">{t("storyboardCount", { count: panels })}</span>
            </div>
            {sheets.map((sheet, s) => (
                <div key={s} className="on-storyboard-sheet">
                    {sheet.imageUrl && (
                        <button type="button" className="on-storyboard-thumb on-storyboard-sheet-image" aria-label={t("storyboardSheetAlt", { n: s + 1 })}
                            onClick={() => setOpen(images.findIndex((image) => image.kind === "sheet" && image.sheet === s))}>
                            <img src={media.resolveMediaUrl(sheet.imageUrl)} alt="" loading="lazy" decoding="async" />
                        </button>
                    )}
                    <div className="on-storyboard-panels">
                        {images.filter((image) => image.kind === "panel" && image.sheet === s).map((image) => (
                            <button key={`${image.url}-${image.panel}`} type="button" className="on-storyboard-thumb" aria-label={altOf(image)} onClick={() => setOpen(images.indexOf(image))}>
                                <img src={media.resolveMediaUrl(image.url)} alt="" loading="lazy" decoding="async" />
                            </button>
                        ))}
                    </div>
                </div>
            ))}
            <p className="on-hint">{t("storyboardHint")}</p>
            {shown && open !== null && (
                <div
                    className="on-storyboard-large" data-testid="inspector-storyboard-large" role="group" aria-label={altOf(shown)}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.stopPropagation();
                        setOpen(null);
                    }}
                >
                    <img src={media.resolveMediaUrl(shown.url)} alt={altOf(shown)} />
                    <div className="on-storyboard-actions">
                        <button type="button" className="on-btn" disabled={open === 0} onClick={() => setOpen(open - 1)}>{t("storyboardBack")}</button>
                        <button type="button" className="on-btn" disabled={open >= images.length - 1} onClick={() => setOpen(open + 1)}>{t("storyboardNext")}</button>
                        <button type="button" className="on-btn" onClick={() => setOpen(null)}>{t("storyboardClose")}</button>
                    </div>
                </div>
            )}
        </section>
    );
}
