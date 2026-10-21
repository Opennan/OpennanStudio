// packages/timeline-react/src/layer-editor/use-design-history.test.tsx
import { act, renderHook } from "@testing-library/react";
import { testDesign } from "@opennan/timeline-core/design/test-design";
import { applyDesignOps } from "@opennan/timeline-core/design/ops";
import { useDesignHistory } from "./use-design-history";

describe("useDesignHistory", () => {
    it("commits, previews without history, undoes and redoes", () => {
        const d0 = testDesign();
        const { result } = renderHook(() => useDesignHistory(d0));
        const d1 = applyDesignOps(d0, [{ op: "move", target: "pill", dx: 5 }]).design;
        act(() => result.current.preview(d1));
        expect(result.current.design).toBe(d1);
        expect(result.current.canUndo).toBe(false);
        act(() => result.current.commit(d1, d0));
        expect(result.current.canUndo).toBe(true);
        act(() => result.current.undo());
        expect(result.current.design).toBe(d0);
        act(() => result.current.redo());
        expect(result.current.design).toBe(d1);
    });
});
