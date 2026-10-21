import { animatedPlacement, rotatedSide, sceneFit, staticPlacement } from "./placement";

const frame = { width: 1920, height: 1080 };

describe("staticPlacement", () => {
    it("anchors across the remaining space", () => {
        const box = { width: 400, height: 100 };
        expect(staticPlacement(frame, box, box, 0, 0, 0)).toEqual({ x: 0, y: 0, rotatedSide: null });
        expect(staticPlacement(frame, box, box, 1, 1, 0)).toEqual({ x: 1520, y: 980, rotatedSide: null });
        expect(staticPlacement(frame, box, box, 0.5, 0.5, 0)).toEqual({ x: 760, y: 490, rotatedSide: null });
    });

    it("centers padded bitmaps and rotated squares on the box center", () => {
        const box = { width: 400, height: 100 };
        const outer = { width: 420, height: 120 };
        expect(staticPlacement(frame, box, outer, 0, 0, 0)).toEqual({ x: -10, y: -10, rotatedSide: null });
        const side = rotatedSide(420, 120);
        expect(side).toBe(438);
        expect(staticPlacement(frame, box, outer, 0, 0, 30)).toEqual({ x: 200 - 219, y: 50 - 219, rotatedSide: 438 });
    });
});

describe("animatedPlacement", () => {
    it("centres the transformed bitmap on the anchored box centre, rounded to an even pixel", () => {
        const placement = animatedPlacement({
            frame: { width: 1920, height: 1080 }, outer: { width: 400, height: 100 }, box: { width: 400, height: 100 },
            margin: 2, scale: "S", posX: "PX", posY: "PY", rotated: true,
        });
        expect(placement.pad).toEqual({ width: 404, height: 104 });
        expect(placement.side).toBe(418); // even ceil(hypot(404, 104))
        expect(placement.x).toBe("2*floor((((PX)*max(0,1920-(400*(S)))+(400*(S))/2)-209)/2+0.5)");
        expect(placement.y).toBe("2*floor((((PY)*max(0,1080-(100*(S)))+(100*(S))/2)-209)/2+0.5)");
    });

    it("skips the rotation square when nothing rotates", () => {
        const placement = animatedPlacement({
            frame: { width: 1280, height: 720 }, outer: { width: 200, height: 50 }, box: { width: 200, height: 50 },
            margin: 2, scale: "S", posX: "0.5", posY: "0.5", rotated: false,
        });
        expect(placement.side).toBeNull();
        expect(placement.x).toBe("2*floor((((0.5)*max(0,1280-(200*(S)))+(200*(S))/2)-102)/2+0.5)");
    });

    it("adds the animation's centre offsets (frame fractions) and widens the pad for |scaleX| peaks", () => {
        const placement = animatedPlacement({
            frame: { width: 1280, height: 720 }, outer: { width: 200, height: 50 }, box: { width: 200, height: 50 },
            margin: 2, scale: "S", posX: "0.5", posY: "0.5", dx: "DX", dy: "0", scaleXPeak: 1.08, rotated: false,
        });
        expect(placement.pad).toEqual({ width: 220, height: 54 });
        expect(placement.x).toBe("2*floor((((0.5)*max(0,1280-(200*(S)))+(200*(S))/2+(DX)*1280)-110)/2+0.5)");
        expect(placement.y).toBe("2*floor((((0.5)*max(0,720-(50*(S)))+(50*(S))/2)-27)/2+0.5)");
    });
});

describe("sceneFit", () => {
    const source = { width: 640, height: 480 };
    it("contain letterboxes, cover crops, fill stretches", () => {
        expect(sceneFit("contain", source, frame, 1, 0, 0)).toEqual({ width: 1440, height: 1080, x: 240, y: 0 });
        expect(sceneFit("cover", source, frame, 1, 0, 0)).toEqual({ width: 1920, height: 1440, x: 0, y: -180 });
        expect(sceneFit("fill", source, frame, 1, 0, 0)).toEqual({ width: 1920, height: 1080, x: 0, y: 0 });
    });
    it("applies scale about the center and percent offsets", () => {
        expect(sceneFit(null, source, frame, 0.5, 10, -10)).toEqual({ width: 720, height: 540, x: 600 + 192, y: 270 - 108 });
    });
});
