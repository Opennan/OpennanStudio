import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const made: FakeRenderer[] = [];
class FakeRenderer {
    lost = false;
    disposed = false;
    private listeners = new Set<() => void>();
    constructor() { made.push(this); }
    get isLost() { return this.lost; }
    onContextLost(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    lose() { this.lost = true; for (const fn of [...this.listeners]) fn(); }
    dispose() { this.disposed = true; }
}
vi.mock("@opennan/timeline-media/looks/look-renderer", () => ({ LookRenderer: FakeRenderer, isWebGl2Available: () => true }));

const { useLookRenderer } = await import("./use-look-renderer");

describe("useLookRenderer", () => {
    it("moves every user to a new renderer after a context loss and disposes it with its last user", async () => {
        const seen: Array<[string, unknown]> = [];
        function User({ name }: { name: string }) {
            const renderer = useLookRenderer(true);
            seen.push([name, renderer]);
            return null;
        }
        const view = render(<><User name="a" /><User name="b" /></>);
        expect(made).toHaveLength(1);
        await act(async () => made[0].lose());
        expect(made).toHaveLength(2);
        expect(made[0].disposed).toBe(true);
        expect(seen.slice(-2).map(([, r]) => r)).toEqual([made[1], made[1]]);
        view.unmount();
        expect(made[1].disposed).toBe(true);
    });
});
