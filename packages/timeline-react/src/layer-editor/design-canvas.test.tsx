// packages/timeline-react/src/layer-editor/design-canvas.test.tsx
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { testDesign } from "@opennan/timeline-core/design/test-design";
import type { LayerDesign, TextLayer } from "@opennan/timeline-core/design/model";
import { DesignCanvas } from "./design-canvas";
import type { Selection } from "./selection";

function setup() {
    let design: LayerDesign = testDesign();
    const onPreview = vi.fn((d: LayerDesign) => { design = d; });
    const onCommit = vi.fn((d: LayerDesign) => { design = d; });
    const onSelect = vi.fn();
    const utils = render(
        <DesignCanvas design={design} selection={null} onSelect={onSelect} onPreview={onPreview} onCommit={onCommit} resolveSrc={(s) => s} viewWidth={400} />,
    );
    return { ...utils, onPreview, onCommit, onSelect, get design() { return design; } };
}

describe("DesignCanvas", () => {
    it("selects a group on click", () => {
        const s = setup();
        const canvas = screen.getByTestId("layer-canvas");
        fireEvent.pointerDown(canvas, { clientX: 150, clientY: 40, pointerId: 1 });
        fireEvent.pointerUp(canvas, { clientX: 150, clientY: 40, pointerId: 1 });
        expect(s.onSelect).toHaveBeenCalledWith({ kind: "group", id: "coins" });
    });

    it("drags a selection and commits one move", () => {
        let design: LayerDesign = testDesign();
        const onCommit = vi.fn((d: LayerDesign) => { design = d; });
        render(<DesignCanvas design={design} selection={{ kind: "group", id: "coins" }} onSelect={() => {}} onPreview={() => {}} onCommit={onCommit} resolveSrc={(s) => s} viewWidth={400} />);
        const canvas = screen.getByTestId("layer-canvas");
        fireEvent.pointerDown(canvas, { clientX: 150, clientY: 40, pointerId: 1 });
        fireEvent.pointerMove(canvas, { clientX: 170, clientY: 50, pointerId: 1 });
        fireEvent.pointerUp(canvas, { clientX: 170, clientY: 50, pointerId: 1 });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(design.layers.find((l) => l.id === "pill")!.transform).toMatchObject({ dx: 20, dy: 10 });
    });

    it("edits text inline on double-click", () => {
        // stateful host, like LayerEditor: previews re-render the canvas with the new design
        const onCommit = vi.fn();
        function Host() {
            const [design, setDesign] = useState<LayerDesign>(testDesign());
            const [sel, setSel] = useState<Selection | null>(null);
            return <DesignCanvas design={design} selection={sel} onSelect={setSel} onPreview={setDesign} onCommit={(d) => { setDesign(d); onCommit(d); }} resolveSrc={(s) => s} viewWidth={400} />;
        }
        render(<Host />);
        fireEvent.doubleClick(screen.getByTestId("layer-canvas"), { clientX: 150, clientY: 40 });
        const box = screen.getByRole("textbox", { name: "Edit text" });
        fireEvent.change(box, { target: { value: "99" } });
        fireEvent.keyDown(box, { key: "Enter" });
        const committed = onCommit.mock.calls.at(-1)![0] as LayerDesign;
        expect((committed.layers.find((l) => l.id === "coins-text") as TextLayer).text).toBe("99");
    });
});
