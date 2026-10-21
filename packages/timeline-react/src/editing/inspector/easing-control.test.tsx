import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { EasingControl } from "./easing-control";

describe("EasingControl bezier handles (a11y)", () => {
    it("are sliders with a value, range, and readable value text, moved by arrow keys", () => {
        const onChange = vi.fn();
        render(<EasingControl easing="bezier" bezier={[0.25, 0.1, 0.25, 1]} onChange={onChange} />);
        const first = screen.getByTestId("bezier-handle-1");
        expect(first.getAttribute("role")).toBe("slider");
        expect(first.getAttribute("aria-valuenow")).toBe("0.1");
        expect(first.getAttribute("aria-valuemin")).toBe("-0.5");
        expect(first.getAttribute("aria-valuemax")).toBe("1.5");
        expect(first.getAttribute("aria-valuetext")).toBe("0.25, 0.10");
        const second = screen.getByTestId("bezier-handle-2");
        expect(second.getAttribute("aria-valuenow")).toBe("1");
        fireEvent.keyDown(first, { key: "ArrowUp" });
        expect(onChange).toHaveBeenLastCalledWith("bezier", [0.25, 0.15, 0.25, 1], true);
        expect(first.getAttribute("aria-valuenow")).toBe("0.15");
        fireEvent.keyDown(first, { key: "ArrowRight" });
        expect(onChange).toHaveBeenLastCalledWith("bezier", [0.3, 0.15, 0.25, 1], true);
    });
});
