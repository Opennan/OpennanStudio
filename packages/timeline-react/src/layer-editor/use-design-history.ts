// packages/timeline-react/src/layer-editor/use-design-history.ts
// Undo/redo for the layer editor. `preview` shows a design mid-gesture without a history entry;
// `commit(next, before)` records one step (before = the design at gesture start).
import { useCallback, useState } from "react";
import type { LayerDesign } from "@opennan/timeline-core/design/model";

const LIMIT = 100;

interface State {
    design: LayerDesign;
    past: LayerDesign[];
    future: LayerDesign[];
}

export interface DesignHistory {
    design: LayerDesign;
    canUndo: boolean;
    canRedo: boolean;
    preview(next: LayerDesign): void;
    commit(next: LayerDesign, before?: LayerDesign): void;
    undo(): void;
    redo(): void;
    reset(design: LayerDesign): void;
}

export function useDesignHistory(initial: LayerDesign): DesignHistory {
    const [s, set] = useState<State>({ design: initial, past: [], future: [] });
    const preview = useCallback((next: LayerDesign) => set((p) => ({ ...p, design: next })), []);
    const commit = useCallback((next: LayerDesign, before?: LayerDesign) => set((p) => {
        const base = before ?? p.design;
        if (base === next) return { ...p, design: next };
        return { design: next, past: [...p.past, base].slice(-LIMIT), future: [] };
    }), []);
    const undo = useCallback(() => set((p) => p.past.length ? { design: p.past[p.past.length - 1], past: p.past.slice(0, -1), future: [p.design, ...p.future] } : p), []);
    const redo = useCallback(() => set((p) => p.future.length ? { design: p.future[0], past: [...p.past, p.design], future: p.future.slice(1) } : p), []);
    const reset = useCallback((design: LayerDesign) => set({ design, past: [], future: [] }), []);
    return { design: s.design, canUndo: s.past.length > 0, canRedo: s.future.length > 0, preview, commit, undo, redo, reset };
}
