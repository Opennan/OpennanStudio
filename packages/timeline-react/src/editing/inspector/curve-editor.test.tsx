import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { CURVE_H, CURVE_W, CurveEditor, VIEW_PAD } from "./curve-editor";
import type { CurvePoints } from "./speed-math";

// jsdom has no layout: the svg reports a 0 × 0 rect, so client pixels map 1:1 onto the viewBox.
const at = (x: number, speedNorm: number) => ({ clientX: x * CURVE_W + VIEW_PAD, clientY: (1 - speedNorm) * CURVE_H + VIEW_PAD, pointerId: 1 });
const flat: CurvePoints = [[0, 1], [0.5, 1], [1, 1]];

function setup(points: CurvePoints = flat) {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(<CurveEditor points={points} onCommit={onCommit} onPreview={onPreview} />);
    return { onCommit, onPreview };
}

describe("CurveEditor", () => {
    it("drags a point with a live preview and commits once on release", () => {
        const { onCommit, onPreview } = setup();
        const point = screen.getByTestId("curve-point-1");
        fireEvent.pointerDown(point, at(0.5, 0.5));
        fireEvent.pointerMove(point, at(0.4, 0.75));
        fireEvent.pointerMove(point, at(0.3, 1));
        expect(onPreview).toHaveBeenLastCalledWith([[0, 1], [0.3, 10], [1, 1]]);
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.pointerUp(point, at(0.3, 1));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith([[0, 1], [0.3, 10], [1, 1]]);
        expect(onPreview).toHaveBeenLastCalledWith(null);
    });

    it("keeps the end points at the start and end", () => {
        const { onCommit } = setup();
        const end = screen.getByTestId("curve-point-2");
        fireEvent.pointerDown(end, at(1, 0.5));
        fireEvent.pointerMove(end, at(0.6, 0));
        fireEvent.pointerUp(end, at(0.6, 0));
        expect(onCommit).toHaveBeenCalledWith([[0, 1], [0.5, 1], [1, 0.1]]);
    });

    it("removes an inner point dragged off the graph", () => {
        const { onCommit } = setup();
        const point = screen.getByTestId("curve-point-1");
        fireEvent.pointerDown(point, at(0.5, 0.5));
        fireEvent.pointerMove(point, { clientX: 140, clientY: -60, pointerId: 1 });
        expect(point.getAttribute("data-removing")).toBe("true");
        fireEvent.pointerUp(point, { clientX: 140, clientY: -60, pointerId: 1 });
        expect(onCommit).toHaveBeenCalledWith([[0, 1], [1, 1]]);
    });

    it("adds a point on double-click, up to ten", () => {
        const { onCommit } = setup();
        fireEvent.doubleClick(screen.getByRole("group"), at(0.25, 0.75));
        expect(onCommit).toHaveBeenCalledWith([[0, 1], [0.25, Number((10 ** 0.5).toFixed(3))], [0.5, 1], [1, 1]]);
        const full = Array.from({ length: 10 }, (_, i) => [i / 9, 1] as [number, number]);
        const second = setup(full);
        fireEvent.doubleClick(screen.getAllByRole("group")[1], at(0.3, 0.5));
        expect(second.onCommit).not.toHaveBeenCalled();
    });

    it("moves the focused point with arrows and deletes it with Delete (ends stay)", () => {
        const { onCommit } = setup();
        fireEvent.keyDown(screen.getByTestId("curve-point-1"), { key: "ArrowRight" });
        expect(onCommit).toHaveBeenLastCalledWith([[0, 1], [0.51, 1], [1, 1]], true);
        fireEvent.keyDown(screen.getByTestId("curve-point-0"), { key: "Delete" });
        expect(onCommit).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(screen.getByTestId("curve-point-1"), { key: "Delete" });
        expect(onCommit).toHaveBeenLastCalledWith([[0, 1], [1, 1]]);
    });

    it("adds a point from the keyboard: Enter or + adds one midway after the focused point and focuses it", () => {
        const rising: CurvePoints = [[0, 1], [1, 10]];
        const { onCommit } = setup(rising);
        fireEvent.keyDown(screen.getByTestId("curve-point-0"), { key: "Enter" });
        // Midway in time and on the log speed axis (1x and 10x meet at √10x).
        expect(onCommit).toHaveBeenLastCalledWith([[0, 1], [0.5, Number((10 ** 0.5).toFixed(3))], [1, 10]]);
        expect(document.activeElement).toBe(screen.getByTestId("curve-point-1"));
        // On the last point the new one goes before it.
        fireEvent.keyDown(screen.getByTestId("curve-point-2"), { key: "+" });
        expect(onCommit).toHaveBeenCalledTimes(2);
        const [, , added] = onCommit.mock.calls[1][0] as CurvePoints;
        expect(added[0]).toBe(0.75);
        expect(document.activeElement).toBe(screen.getByTestId("curve-point-2"));
    });

    it("does not add past ten points, and tells keyboard users how to add and remove", () => {
        const full = Array.from({ length: 10 }, (_, i) => [i / 9, 1] as [number, number]);
        const { onCommit } = setup(full);
        fireEvent.keyDown(screen.getByTestId("curve-point-3"), { key: "Enter" });
        expect(onCommit).not.toHaveBeenCalled();
        const point = screen.getByTestId("curve-point-3");
        const hint = document.getElementById(point.getAttribute("aria-describedby") ?? "");
        expect(hint?.textContent).toMatch(/Enter/);
        expect(hint?.textContent).toMatch(/Delete/);
    });
});
