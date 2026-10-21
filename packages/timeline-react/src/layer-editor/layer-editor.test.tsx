// packages/timeline-react/src/layer-editor/layer-editor.test.tsx
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { testDesign } from "@opennan/timeline-core/design/test-design";
import { LayerEditor, type LayerEditorHandle } from "./layer-editor";

describe("LayerEditor", () => {
    it("applies agent ops through the handle and reports lettering", () => {
        const ref = createRef<LayerEditorHandle>();
        const onChange = vi.fn();
        render(<LayerEditor ref={ref} initialDesign={testDesign()} onChange={onChange} resolveSrc={(s) => s} />);
        let out!: ReturnType<LayerEditorHandle["apply"]>;
        act(() => { out = ref.current!.apply([{ op: "set_text", target: "385", text: "97" }]); });
        expect(out.results[0].ok).toBe(true);
        expect(ref.current!.describe().layers.find((l) => l.id === "level")?.missingGlyphs).toEqual(["9", "7"]);
        expect(onChange).toHaveBeenCalled();
        act(() => ref.current!.undo());
        expect(ref.current!.describe().layers.find((l) => l.id === "level")?.text).toBe("385");
    });

    it("lists groups and toggles visibility from the layer list", () => {
        render(<LayerEditor initialDesign={testDesign()} resolveSrc={(s) => s} />);
        expect(screen.getByRole("button", { name: "12,450" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Hide 385" }));
        expect(screen.getByRole("button", { name: "Show 385" })).toBeInTheDocument();
    });

    it("shows the text inspector for a selected text layer", () => {
        const ref = createRef<LayerEditorHandle>();
        render(<LayerEditor ref={ref} initialDesign={testDesign()} resolveSrc={(s) => s} />);
        act(() => ref.current!.select({ kind: "layer", id: "coins-text" }));
        expect(screen.getByText("Original lettering from the image.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Text"), { target: { value: "99" } });
        expect(screen.getByText(/Not in the image: 9/)).toBeInTheDocument();
    });
});
