import { describe, it, expect } from "vitest";
import { zoomAt, zoomTo, contentWidthPx, clampScroll, edgeScrollVelocity, MAX_PX_PER_SECOND, resolveWheelZoomStep } from "./viewport";
import { getNextTimelineZoom } from "../../lib/timeline-editing-properties";

const vp = { pxPerSecond: 10, scrollX: 100, viewportWidthPx: 1000 };

describe("engine viewport", () => {
    it("zoomAt keeps the time under the cursor fixed", () => {
        const anchorPx = 300;                       // time under cursor = (100+300)/10 = 40s
        const z = zoomAt(vp, 2, anchorPx, 600);
        expect(z.pxPerSecond).toBe(20);
        expect((z.scrollX + anchorPx) / z.pxPerSecond).toBeCloseTo(40, 5);
    });

    it("zoomAt composes — applying it twice keeps working (regression: zoom worked once)", () => {
        let v = vp;
        v = zoomAt(v, 1.5, 500, 600);
        v = zoomAt(v, 1.5, 500, 600);
        expect(v.pxPerSecond).toBeCloseTo(22.5, 5);
        expect(Number.isFinite(v.scrollX)).toBe(true);
        expect(v.scrollX).toBeGreaterThanOrEqual(0);
    });

    it("zoomAt clamps between fit-content and MAX_PX_PER_SECOND", () => {
        expect(zoomAt(vp, 1000, 0, 600).pxPerSecond).toBe(MAX_PX_PER_SECOND);
        const out = zoomAt(vp, 0.0001, 0, 600);
        // fit: 1000px viewport / (600s * 1.25 padding) = 1.333… px/s minimum
        expect(out.pxPerSecond).toBeCloseTo(1000 / (600 * 1.25), 3);
    });

    it("contentWidthPx pads content by 25% with a 60s floor", () => {
        expect(contentWidthPx(100, 10)).toBe(100 * 1.25 * 10);
        expect(contentWidthPx(10, 10)).toBe(60 * 10);      // floor dominates short projects
    });

    it("clampScroll keeps the viewport inside the padded content", () => {
        const v = clampScroll({ pxPerSecond: 10, scrollX: 99999, viewportWidthPx: 1000 }, 100);
        expect(v.scrollX).toBe(100 * 1.25 * 10 - 1000);
        expect(clampScroll({ ...vp, scrollX: -5 }, 100).scrollX).toBe(0);
    });

    it("edgeScrollVelocity is negative near the left edge, positive near the right, 0 in the middle", () => {
        expect(edgeScrollVelocity(10, 1000)).toBeLessThan(0);
        expect(edgeScrollVelocity(990, 1000)).toBeGreaterThan(0);
        expect(edgeScrollVelocity(500, 1000)).toBe(0);
    });

    describe("zoomTo", () => {
        it(
            "lands exactly on the requested pxPerSecond, unlike zoomAt's factor round-trip " +
            "(regression: repeated table-level stepping through zoomAt drifted off-level and froze)",
            () => {
                // Reproduces the exact numbers observed live: fit-zoom starts the
                // timeline at pxPerSecond=18.725, stepping to the 25 table level
                // via zoomAt's `current * (target / current)` lands on
                // 24.999999999999996 instead of exactly 25.
                const start = { pxPerSecond: 18.725, scrollX: 0, viewportWidthPx: 1000 };
                const viaFactor = zoomAt(start, 25 / 18.725, 0, 15);
                expect(viaFactor.pxPerSecond).not.toBe(25);
                expect(viaFactor.pxPerSecond).toBeCloseTo(25, 10);

                // zoomTo takes the target directly, so it lands exactly on it —
                // no epsilon drift to poison the next level-table comparison.
                const viaTarget = zoomTo(start, 25, 0, 15);
                expect(viaTarget.pxPerSecond).toBe(25);
            }
        );

        it("still clamps to the fit-content minimum and MAX_PX_PER_SECOND", () => {
            const vpLocal = { pxPerSecond: 10, scrollX: 100, viewportWidthPx: 1000 };
            expect(zoomTo(vpLocal, 100000, 0, 600).pxPerSecond).toBe(MAX_PX_PER_SECOND);
            expect(zoomTo(vpLocal, 0.001, 0, 600).pxPerSecond).toBeCloseTo(1000 / (600 * 1.25), 3);
        });
    });

    describe("resolveWheelZoomStep", () => {
        it("resolves a single tick to its direction", () => {
            expect(resolveWheelZoomStep(-120)).toBe(1);  // negative deltaY = zoom in
            expect(resolveWheelZoomStep(120)).toBe(-1);  // positive deltaY = zoom out
        });

        it("net-cancels a burst of opposing ticks within one frame instead of stepping twice", () => {
            // e.g. Chromium's synthesized ctrl+wheel smooth-zoom, or a
            // double-dispatched wheel event, landing two ticks in one frame.
            expect(resolveWheelZoomStep(-120 + 120)).toBe(0);
        });

        it("collapses same-direction bursts to a single step instead of two", () => {
            expect(resolveWheelZoomStep(-120 + -60)).toBe(1);
            expect(resolveWheelZoomStep(120 + 60)).toBe(-1);
        });

        it(
            "regression: stepping once per wheel EVENT (not once per accumulated frame) " +
            "drifts to a fixed point that alternating in/out gestures can't escape",
            () => {
                // Reproduces the exact failure from the smoke suite: 10
                // alternating ctrl+wheel gestures starting at the default zoom,
                // where one of the "zoom out" gestures happens to deliver two
                // wheel events instead of one (a real, observed Chromium/CDP
                // behavior for ctrl+wheel). Stepping per-event lets that single
                // extra tick walk the zoom down to the table minimum, from
                // which a normal single-tick zoom-out gesture is a genuine
                // no-op forever after.
                let zoom = 50;
                const perEventStep = (deltaY: number) => {
                    const dir = deltaY < 0 ? 1 : -1;
                    const next = getNextTimelineZoom(zoom, dir);
                    zoom = next;
                    return next;
                };
                perEventStep(-120); // gesture 0 (in): 50 -> 100
                // gesture 1 (out) misbehaves and delivers two wheel events:
                perEventStep(120); // 100 -> 50
                perEventStep(120); // 50 -> 25 (bug: a second event for the same gesture)
                const stuck = perEventStep(120); // gesture 2 (out) again: already at MIN, no-op
                expect(stuck).toBe(25);
                expect(getNextTimelineZoom(stuck, -1)).toBe(25); // confirms the freeze

                // Now show the fix: accumulating deltaY across a frame and
                // resolving *net* direction once means the extra same-gesture
                // tick can never be double-applied, so the sequence can't drift.
                let fixedZoom = 50;
                const perFrameStep = (accumulatedDeltaY: number) => {
                    const dir = resolveWheelZoomStep(accumulatedDeltaY);
                    if (dir === 0) return fixedZoom;
                    fixedZoom = getNextTimelineZoom(fixedZoom, dir);
                    return fixedZoom;
                };
                perFrameStep(-120); // gesture 0 (in), one frame: 50 -> 100
                perFrameStep(120 + 120); // gesture 1 (out), both events land in one frame: 100 -> 50 (one step, not two)
                const recovered = perFrameStep(-120); // gesture 2 (in): 50 -> 100
                expect(recovered).toBe(100);
            }
        );
    });
});
