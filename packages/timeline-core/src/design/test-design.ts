// packages/timeline-core/src/design/test-design.ts
// A tiny design for tests: a locked background, a coin pill with its number (one group), a loose label.
import { IDENTITY_TRANSFORM, LAYER_DESIGN_VERSION, type LayerDesign } from "./model";

export function testDesign(): LayerDesign {
    const t = () => ({ ...IDENTITY_TRANSFORM });
    return {
        version: LAYER_DESIGN_VERSION,
        width: 400,
        height: 300,
        source: "source.png",
        layers: [
            { id: "bg", kind: "image", src: "bg.png", role: "background", box: { x: 0, y: 0, w: 400, h: 300 }, transform: t(), opacity: 1, visible: true, locked: true },
            { id: "pill", kind: "image", src: "pill.png", role: "element", group: "coins", box: { x: 50, y: 10, w: 200, h: 60 }, transform: t(), opacity: 1, visible: true },
            {
                id: "coins-text", kind: "text", group: "coins", text: "12,450", lettering: "auto", styleGroup: "numbers",
                box: { x: 100, y: 25, w: 100, h: 30 }, transform: t(), opacity: 1, visible: true,
                original: {
                    text: "12,450",
                    word: { src: "w0.png", dx: -4, dy: -4, w: 108, h: 38 },
                    glyphs: ["1", "2", ",", "4", "5", "0"].map((ch, i) => ({ ch, src: `g0_${i}.png`, dx: i * 17, dy: -4, w: 17, h: 38 })),
                },
                style: { fill: "#ffffff", stroke: "#333333", strokeWidth: 2, shadow: true, font: "Roboto", weight: 700, track: 0 },
            },
            {
                id: "level", kind: "text", text: "385", lettering: "auto", styleGroup: "numbers",
                box: { x: 300, y: 25, w: 60, h: 30 }, transform: t(), opacity: 1, visible: true,
                original: {
                    text: "385",
                    word: { src: "w1.png", dx: -4, dy: -4, w: 68, h: 38 },
                    glyphs: ["3", "8", "5"].map((ch, i) => ({ ch, src: `g1_${i}.png`, dx: i * 20, dy: -4, w: 20, h: 38 })),
                },
                style: { fill: "#fafafa", strokeWidth: 0, shadow: false, font: "Roboto", weight: 700, track: 0 },
            },
        ],
    };
}
