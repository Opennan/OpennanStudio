// The editor's right dock (phase 9b): tabs Inspector | AI. The AI tab holds the AI director (chat, the storyboard
// board, the script wizard). The chosen tab is remembered per browser; ⌘J (Ctrl+J) and the top bar's AI button
// toggle it. Width is the inspector splitter's.
import { useEffect, useRef, type ReactNode } from "react";
import { useTimelineMessages } from "@opennan/timeline-react";

export type RightDockTab = "inspector" | "ai";
export const RIGHT_DOCK_STORAGE_KEY = "opennan-studio:right-dock";

export function loadRightDockTab(storage: Pick<Storage, "getItem"> | null = safeStorage()): RightDockTab {
    try {
        return storage?.getItem(RIGHT_DOCK_STORAGE_KEY) === "ai" ? "ai" : "inspector";
    } catch {
        return "inspector";
    }
}

export function saveRightDockTab(tab: RightDockTab, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
    try {
        storage?.setItem(RIGHT_DOCK_STORAGE_KEY, tab);
    } catch {
        // not remembered
    }
}

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

/** ⌘J / Ctrl+J toggles the AI tab (also from inside text fields: it is a modifier shortcut). */
export function isToggleAiKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
    return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j";
}

export function RightDock({ tab, onTab, inspector, ai, enabled = true }: {
    tab: RightDockTab;
    onTab(tab: RightDockTab): void;
    inspector: ReactNode;
    ai: ReactNode;
    /** Off while a dialog owns the keyboard. */
    enabled?: boolean;
}) {
    const t = useTimelineMessages("aiDirector");
    const current = useRef(tab);
    current.current = tab;
    useEffect(() => {
        if (!enabled) return;
        const onKey = (event: KeyboardEvent) => {
            if (!isToggleAiKey(event)) return;
            event.preventDefault();
            onTab(current.current === "ai" ? "inspector" : "ai");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [enabled, onTab]);
    const choose = (next: RightDockTab) => {
        onTab(next);
    };
    const onTabKey = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const next = tab === "ai" ? "inspector" : "ai";
            choose(next);
            (event.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
        }
    };
    return (
        <div className="right-dock">
            <div className="right-dock-tabs" role="tablist" aria-label={t("dockLabel")}>
                {(["inspector", "ai"] as const).map((id) => (
                    <button
                        key={id} type="button" role="tab" id={`right-dock-tab-${id}`} data-tab={id} aria-selected={tab === id} aria-controls={`right-dock-panel-${id}`}
                        tabIndex={tab === id ? 0 : -1} className="right-dock-tab" onClick={() => choose(id)} onKeyDown={onTabKey}
                        title={id === "ai" ? t("topbarAiTitle") : undefined} aria-label={id === "ai" ? t("tabAiLabel") : undefined}
                    >
                        {t(id === "inspector" ? "tabInspector" : "tabAi")}
                    </button>
                ))}
            </div>
            <div className="right-dock-panel" role="tabpanel" id={`right-dock-panel-${tab}`} aria-labelledby={`right-dock-tab-${tab}`}>
                {tab === "inspector" ? inspector : ai}
            </div>
        </div>
    );
}
