// A stable, serializable listing of everything the looks engine ships, for the editor's libraries and
// for agents (MCP list tools). Names are English fallbacks; the UI translates by id.
import { ADJUSTMENT_KEYS, adjustmentRange, type AdjustmentKey } from "./adjust";
import { EFFECTS, type EffectCategory } from "./effects";
import { FILTERS, type FilterCategory } from "./filters";
import { TRANSITIONS, type TransitionCategory } from "./transitions";
import type { EffectParam } from "../model/effects";

export interface CatalogTransition { id: string; category: TransitionCategory; defaultDuration: number; name: string }
export interface CatalogFilter { id: string; category: FilterCategory; name: string }
export interface CatalogEffect { id: string; category: EffectCategory; name: string; params: EffectParam[]; animated: boolean }
export interface CatalogAdjustment { key: AdjustmentKey; min: number; max: number }

export interface LooksCatalog {
    transitions: CatalogTransition[];
    filters: CatalogFilter[];
    effects: CatalogEffect[];
    adjustments: CatalogAdjustment[];
}

/** "teal_orange" → "Teal orange"; ids are snake case. */
export function displayName(id: string): string {
    const words = id.replace(/^fx_/, "").split("_");
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

const TRANSITION_NAMES: Record<string, string> = {
    cross_dissolve: "Dissolve", dip_black: "Dip to black", dip_white: "Dip to white", blur_dissolve: "Blur", circle_open: "Iris",
    luma_fade: "Luma fade", clock_wipe: "Clock wipe",
};
const FILTER_NAMES: Record<string, string> = { teal_orange: "Teal & orange", bw: "B&W", seventies: "70s", fresh_greens: "Fresh greens" };

export function looksCatalog(): LooksCatalog {
    return {
        transitions: TRANSITIONS.map((t) => ({ id: t.id, category: t.category, defaultDuration: t.defaultDuration, name: TRANSITION_NAMES[t.id] ?? displayName(t.id) })),
        filters: FILTERS.map((f) => ({ id: f.id, category: f.category, name: FILTER_NAMES[f.id] ?? displayName(f.id) })),
        effects: EFFECTS.map((e) => ({ id: e.id, category: e.category, name: e.name, params: e.params.map((p) => ({ ...p })), animated: Boolean(e.passes) })),
        adjustments: ADJUSTMENT_KEYS.map((key) => {
            const [min, max] = adjustmentRange(key);
            return { key, min, max };
        }),
    };
}
