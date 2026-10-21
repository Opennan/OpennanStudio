"use client";
// The left column: an icon rail and the selected library (CapCut layout). Media and Audio come from
// the host (its media bin); AI (the host's generate dialog, phase 11), Text, Stickers, Graphics, Effects, Transitions,
// Filters, and Adjust are built in.
import { useState, type ReactNode } from "react";
import { ArrowLeftRight, Clapperboard, Music, Palette, Shapes, SlidersHorizontal, Sparkles, Sticker, Type, Wand2 } from "lucide-react";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { GraphicsTab } from "./graphics-tab";
import { EffectsTab, FiltersTab, TransitionsTab } from "./looks-tabs";
import { AdjustTab, TextTab } from "./simple-tabs";
import { StickersTab } from "./stickers-tab";
import { AiLibraryTab } from "../../ai/ai-library-tab";


export const LIBRARY_TABS = ["media", "ai", "audio", "text", "stickers", "graphics", "effects", "transitions", "filters", "adjust"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

const ICONS: Record<LibraryTab, typeof Clapperboard> = {
    media: Clapperboard, ai: Wand2, audio: Music, text: Type, stickers: Sticker, graphics: Shapes, effects: Sparkles, transitions: ArrowLeftRight, filters: Palette, adjust: SlidersHorizontal,
};
const LABELS = {
    media: "tabMedia", ai: "tabAi", audio: "tabAudio", text: "tabText", stickers: "stk_tab", graphics: "gfx_tab", effects: "tabEffects", transitions: "tabTransitions", filters: "tabFilters", adjust: "tabAdjust",
} as const;
const STORAGE_KEY = "opennan-studio:library-tab";

function storedTab(): LibraryTab {
    try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        return (LIBRARY_TABS as readonly string[]).includes(value ?? "") ? (value as LibraryTab) : "media";
    } catch {
        return "media";
    }
}

export interface EditorLibraryProps {
    media: ReactNode;
    audio: ReactNode;
    /** Controlled tab (optional). */
    tab?: LibraryTab;
    onTabChange?(tab: LibraryTab): void;
}

export function EditorLibrary({ media, audio, tab: controlled, onTabChange }: EditorLibraryProps) {
    const t = useTimelineMessages("studioEditor");
    const [internal, setInternal] = useState<LibraryTab>(storedTab);
    const tab = controlled ?? internal;
    const select = (next: LibraryTab) => {
        setInternal(next);
        onTabChange?.(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* private mode */
        }
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const i = LIBRARY_TABS.indexOf(tab);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = LIBRARY_TABS[(i + (e.key === "ArrowDown" ? 1 : LIBRARY_TABS.length - 1)) % LIBRARY_TABS.length];
            select(next);
            (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
        }
    };
    return (
        <div className="on-editing on-library" data-testid="editor-library">
            <div className="on-rail" role="tablist" aria-label={t("libraryLabel")} aria-orientation="vertical" onKeyDown={onKeyDown}>
                {LIBRARY_TABS.map((id) => {
                    const Icon = ICONS[id];
                    return (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            id={`library-tab-${id}`}
                            data-tab={id}
                            aria-selected={tab === id}
                            aria-controls={`library-panel-${id}`}
                            tabIndex={tab === id ? 0 : -1}
                            className="on-rail-tab"
                            onClick={() => select(id)}
                        >
                            <Icon aria-hidden="true" />
                            <span>{t(LABELS[id])}</span>
                        </button>
                    );
                })}
            </div>
            <div className="on-library-body" role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`} key={tab}>
                {tab === "media" && media}
                {tab === "ai" && <AiLibraryTab />}
                {tab === "audio" && audio}
                {tab === "text" && <TextTab />}
                {tab === "stickers" && <StickersTab />}
                {tab === "graphics" && <GraphicsTab />}
                {tab === "effects" && <EffectsTab />}
                {tab === "transitions" && <TransitionsTab />}
                {tab === "filters" && <FiltersTab />}
                {tab === "adjust" && <AdjustTab />}
            </div>
        </div>
    );
}
