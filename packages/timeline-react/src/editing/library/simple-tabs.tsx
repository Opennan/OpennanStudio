"use client";
// Text and Adjust library tabs. Text (phase 10b): Add text, search, category chips, the twenty text
// templates drawn with the preview's text code, the eight caption styles, and the bundled fonts.
// A click adds a text clip at the playhead (style and animation in one clip.create), or restyles the
// selected text clips; caption styles go to the selected captions, else to every caption.
import { useMemo, useState, type DragEvent } from "react";
import { Search, Type } from "lucide-react";
import type { TimelineClip } from "@opennan/timeline-core";
import { CAPTION_STYLES } from "@opennan/timeline-core/text/captions";
import { TEXT_FONTS, fontStack } from "@opennan/timeline-core/text/fonts";
import { TEXT_TEMPLATES } from "@opennan/timeline-core/text/templates";
import { useEditorStore, useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { useTimelineToast } from "../../hooks/use-timeline-toast";
import { AdjustControls } from "../adjust-controls";
import { lookTargetOf, useSelectionTarget } from "../selection";
import { filterLibraryItems } from "./library-panel";
import {
    DEFAULT_TEXT_TEMPLATE, TEXT_LIBRARY_CATEGORIES, TEXT_TEMPLATE_DRAG_KIND, TEXT_TEMPLATE_DRAG_MIME, addTextFromTemplate, applyCaptionStyle, applyTextTemplate,
    bundledFamilyOf, fontFamilyPatch, isCaptionClip, matchingCaptionStyleId, matchingTemplateId, selectedTextClips, styleField,
    type TextLibraryCategory,
} from "./text-library";
import { TextThumb } from "./text-thumb";

const NO_CLIPS: TimelineClip[] = [];
/** Thumbnail pixels (of TEXT_THUMB_H) under a card badge (.on-card-badge: 10 px text, 4 px from the bottom). */
const BADGE_STRIP = 24;

function useHover(): [boolean, { onMouseEnter(): void; onMouseLeave(): void; onFocus(): void; onBlur(): void }] {
    const [hover, setHover] = useState(false);
    return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onFocus: () => setHover(true), onBlur: () => setHover(false) }];
}

function StyleCard({ testId, name, text, styleJson, applied, karaoke, badge, onActivate, onDragStart }: {
    testId: string; name: string; text: string; styleJson: string; applied: boolean; karaoke?: boolean; badge?: string;
    onActivate(): void; onDragStart?(e: DragEvent): void;
}) {
    const [hover, handlers] = useHover();
    return (
        <button
            type="button"
            className="on-card on-text-card"
            data-testid={testId}
            data-applied={applied || undefined}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart}
            onClick={onActivate}
            title={name}
            {...handlers}
        >
            <span className="on-card-thumb on-text-thumb">
                {/* A badge covers the bottom strip of the thumbnail: the sample stays above it. */}
                <TextThumb text={text} styleJson={styleJson} karaoke={karaoke} active={hover} reserveBottom={badge ? BADGE_STRIP : 0} />
                {badge && <span className="on-card-badge">{badge}</span>}
            </span>
            <span className="on-card-name">{name}</span>
        </button>
    );
}

const TEMPLATE_STYLE_JSON = new Map(TEXT_TEMPLATES.map((tpl) => [tpl.id, JSON.stringify(tpl.style)]));
const CAPTION_STYLE_JSON = new Map(CAPTION_STYLES.map((c) => [c.id, JSON.stringify(c.style)]));

export function TextTab() {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const clips = useEditorStore((s) => s.timelineData?.clips ?? NO_CLIPS);
    const selectedIds = useEditorStore((s) => s.selectedClipIds);
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<TextLibraryCategory>("all");

    const selectedText = useMemo(() => selectedTextClips(clips, selectedIds), [clips, selectedIds]);
    const selectedCaptions = useMemo(() => selectedText.filter(isCaptionClip), [selectedText]);
    const firstTemplate = selectedText.length > 0 ? matchingTemplateId(selectedText[0].textStyle) : null;
    const appliedTemplate = firstTemplate && selectedText.every((c) => matchingTemplateId(c.textStyle) === firstTemplate) ? firstTemplate : null;
    const appliedCaption = selectedCaptions.length > 0 ? matchingCaptionStyleId(selectedCaptions[0].textStyle) : null;
    const firstFamily = selectedText.length > 0 ? styleField(selectedText[0].textStyle, "fontFamily") : null;
    const appliedFamily = typeof firstFamily === "string" ? bundledFamilyOf(firstFamily) : null;

    const templates = useMemo(() => TEXT_TEMPLATES.map((tpl) => ({ id: tpl.id, category: tpl.category as string, name: t(`txt_tpl_${tpl.id}` as never), text: tpl.defaultText })), [t]);
    const captions = useMemo(() => CAPTION_STYLES.map((c) => ({ id: c.id, category: "captions", name: t(`cap_${c.id}` as never), karaoke: c.karaoke })), [t]);
    const q = query.trim().toLowerCase();
    const shownTemplates = category === "captions" ? [] : filterLibraryItems(templates, query, category);
    const shownCaptions = category === "all" || category === "captions" ? filterLibraryItems(captions, query, "all") : [];
    const shownFonts = category === "all" ? TEXT_FONTS.filter((f) => !q || f.family.toLowerCase().includes(q)) : [];
    const total = shownTemplates.length + shownCaptions.length + shownFonts.length;
    const sample = t("cap_sample");

    const add = (templateId: string, stylePatch?: Record<string, unknown>) => {
        void addTextFromTemplate(controller, storeApi, templateId, { stylePatch }).then((result) => {
            if (!result.ok) toast.error(t("txt_addFailed"));
        });
    };
    const onTemplate = (templateId: string) => {
        if (selectedText.length === 0) {
            add(templateId);
            return;
        }
        void applyTextTemplate(controller, selectedText.map((c) => c.id), templateId).then((result) => {
            if (!result.ok) toast.error(t("txt_applyFailed"));
        });
    };
    const onCaption = (styleId: string, name: string) => {
        void applyCaptionStyle(controller, clips, selectedIds, styleId).then((result) => {
            if (result.ok) toast.success(t("cap_applied", { name }));
            else if (result.reason === "no-target") toast.info(t("cap_none"));
            else toast.error(t("txt_applyFailed"));
        });
    };
    const onFont = (family: string) => {
        if (selectedText.length === 0) {
            add(DEFAULT_TEXT_TEMPLATE, fontFamilyPatch(family, "700"));
            return;
        }
        const weight = styleField(selectedText[0].textStyle, "fontWeight") ?? 400;
        void controller.execute({ type: "text.style.set", clipIds: selectedText.map((c) => c.id), patch: fontFamilyPatch(family, weight) }, { toastOnError: false })
            .then((result) => { if (!result.ok) toast.error(t("txt_applyFailed")); });
    };

    return (
        <div className="on-tabpanel" data-testid="library-text">
            <div className="on-panel-head">
                <h2 className="on-panel-title">{t("tabText")}</h2>
                <span className="on-count" aria-live="polite">{t("resultsCount", { n: total })}</span>
            </div>
            <p className="on-panel-sub">{selectedText.length > 0 ? t("txt_hintSelected") : t("textHint")}</p>
            <div className="on-text-add">
                <button type="button" className="on-btn on-btn-primary on-btn-pill" data-testid="text-add" onClick={() => add(DEFAULT_TEXT_TEMPLATE)}>
                    <Type aria-hidden="true" />{t("textAdd")}
                </button>
            </div>
            <label className="on-search">
                <Search aria-hidden="true" />
                <input type="search" value={query} placeholder={t("txt_search")} aria-label={t("txt_search")} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="on-chips" role="group" aria-label={t("categories")}>
                {(["all", ...TEXT_LIBRARY_CATEGORIES] as const).map((id) => (
                    <button key={id} type="button" className="on-chip" aria-pressed={category === id} onClick={() => setCategory(id)}>
                        {id === "all" ? t("categoryAll") : t(`txt_cat_${id}` as never)}
                    </button>
                ))}
            </div>
            <div className="on-scroll">
                {total === 0 && <p className="on-empty">{t("noResults", { query })}</p>}
                {shownTemplates.length > 0 && (
                    <section className="on-section on-text-section" aria-label={t("txt_templates")}>
                        <h3 className="on-section-title">{t("txt_templates")}</h3>
                        <ul className="on-grid on-text-grid">
                            {shownTemplates.map((tpl) => (
                                <li key={tpl.id}>
                                    <StyleCard
                                        testId={`text-template-${tpl.id}`}
                                        name={tpl.name}
                                        text={tpl.text}
                                        styleJson={TEMPLATE_STYLE_JSON.get(tpl.id)!}
                                        applied={appliedTemplate === tpl.id}
                                        onActivate={() => onTemplate(tpl.id)}
                                        onDragStart={(e) => {
                                            e.dataTransfer.effectAllowed = "copy";
                                            e.dataTransfer.setData(TEXT_TEMPLATE_DRAG_MIME, tpl.id);
                                            e.dataTransfer.setData("application/json", JSON.stringify({ kind: TEXT_TEMPLATE_DRAG_KIND, templateId: tpl.id, name: tpl.name }));
                                        }}
                                    />
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                {shownCaptions.length > 0 && (
                    <section className="on-section on-text-section" aria-label={t("cap_title")}>
                        <h3 className="on-section-title">{t("cap_title")}</h3>
                        <p className="on-hint">{selectedCaptions.length > 0 ? t("cap_hintSelected") : t("cap_hint")}</p>
                        <ul className="on-grid on-text-grid">
                            {shownCaptions.map((c) => (
                                <li key={c.id}>
                                    <StyleCard
                                        testId={`caption-style-${c.id}`}
                                        name={c.name}
                                        text={sample}
                                        styleJson={CAPTION_STYLE_JSON.get(c.id)!}
                                        karaoke={c.karaoke}
                                        badge={c.karaoke ? t("cap_wordByWord") : undefined}
                                        applied={appliedCaption === c.id}
                                        onActivate={() => onCaption(c.id, c.name)}
                                    />
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                {shownFonts.length > 0 && (
                    <section className="on-section on-text-section" aria-label={t("txt_fonts")}>
                        <h3 className="on-section-title">{t("txt_fonts")}</h3>
                        <ul className="on-font-strip">
                            {shownFonts.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        className="on-font-chip"
                                        data-testid={`text-font-${f.id}`}
                                        data-applied={appliedFamily === f.family || undefined}
                                        title={f.family}
                                        style={{ fontFamily: fontStack(f.family), fontWeight: f.weights.includes(700) ? 700 : f.weights[0] }}
                                        onClick={() => onFont(f.family)}
                                    >
                                        <span className="on-font-chip-sample" aria-hidden="true">Aa</span>
                                        <span className="on-font-chip-name">{f.family}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </div>
    );
}

export function AdjustTab() {
    const t = useTimelineMessages("studioEditor");
    const selection = useSelectionTarget();
    const target = lookTargetOf(selection);
    const item = selection?.kind === "scene" ? selection.scene : selection?.kind === "clip" ? selection.clip : null;
    return (
        <div className="on-tabpanel" data-testid="library-adjust">
            <div className="on-panel-head"><h2 className="on-panel-title">{t("tabAdjust")}</h2></div>
            <div className="on-scroll">
                {target && item ? <AdjustControls target={target} item={item} /> : <p className="on-empty">{t("adjustEmpty")}</p>}
            </div>
        </div>
    );
}
