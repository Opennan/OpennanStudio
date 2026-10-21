"use client";
// The shell every library tab shares: title, hint, search, category chips, and a card grid.
import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";

export interface LibraryItem {
    id: string;
    name: string;
    category: string;
}

export interface LibraryPanelProps<T extends LibraryItem> {
    title: string;
    hint?: string;
    searchLabel: string;
    items: readonly T[];
    categories: ReadonlyArray<{ id: string; label: string }>;
    renderItem(item: T): ReactNode;
    /** Extra controls under the hint (e.g. the applied filter's intensity). */
    toolbar?: ReactNode;
    testId?: string;
}

export function filterLibraryItems<T extends LibraryItem>(items: readonly T[], query: string, category: string): T[] {
    const q = query.trim().toLowerCase();
    return items.filter((item) => (category === "all" || item.category === category) && (!q || item.name.toLowerCase().includes(q) || item.id.includes(q)));
}

export function LibraryPanel<T extends LibraryItem>({ title, hint, searchLabel, items, categories, renderItem, toolbar, testId }: LibraryPanelProps<T>) {
    const t = useTimelineMessages("studioEditor");
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("all");
    const shown = useMemo(() => filterLibraryItems(items, query, category), [items, query, category]);
    return (
        <div className="on-tabpanel" data-testid={testId}>
            <div className="on-panel-head">
                <h2 className="on-panel-title">{title}</h2>
                <span className="on-count" aria-live="polite">{t("resultsCount", { n: shown.length })}</span>
            </div>
            {hint && <p className="on-panel-sub">{hint}</p>}
            {toolbar}
            <label className="on-search">
                <Search aria-hidden="true" />
                <input type="search" value={query} placeholder={searchLabel} aria-label={searchLabel} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="on-chips" role="group" aria-label={t("categories")}>
                {[{ id: "all", label: t("categoryAll") }, ...categories].map((c) => (
                    <button key={c.id} type="button" className="on-chip" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.label}</button>
                ))}
            </div>
            <div className="on-scroll">
                {shown.length === 0 ? (
                    <p className="on-empty">{t("noResults", { query })}</p>
                ) : (
                    <ul className="on-grid">
                        {shown.map((item) => <li key={item.id}>{renderItem(item)}</li>)}
                    </ul>
                )}
            </div>
        </div>
    );
}
