// OpenNan's own sticker set: 36 flat vector stickers authored for this project (project licence, see the
// package LICENSE). Each is a standalone SVG string with a viewBox and no external references, scripts,
// styles, text, or images: lettering on badges is drawn as stroked paths, so every host (browser preview,
// Node rasterizer) draws the same pixels without fonts.
//
// Look: a "die-cut" sticker. Every base part is drawn three times: a white halo, a dark ink outline, then
// its colour, so a sticker reads on bright and dark video alike. The SVG strings are assembled once at
// module load from the small helpers below (the output is plain SVG markup).

export type OwnStickerCategory = "arrows" | "shapes" | "callouts" | "badges" | "sparkles" | "marks";

export interface OwnSticker {
    /** Catalog id without the "opennan:" prefix. */
    slug: string;
    category: OwnStickerCategory;
    name: string;
    keywords: readonly string[];
    svg: string;
}

const INK = "#1B1B2F";
const WHITE = "#FFFFFF";
const RED = "#FF4D6D";
const ORANGE = "#FF9F1C";
const YELLOW = "#FFD23F";
const GREEN = "#06D6A0";
const TEAL = "#2EC4B6";
const BLUE = "#3A86FF";
const PURPLE = "#8338EC";
const PINK = "#FF5DA2";

/** Ink outline width outside a part's edge, and the white halo beyond it (viewBox units). */
const INK_W = 4;
const HALO_W = 8;
const ROUND = 'stroke-linejoin="round" stroke-linecap="round"';

/** A filled region, or a stroked line of width `w`. */
type Part = { d: string; fill: string } | { d: string; line: string; w: number };

/** A number with at most `digits` decimals, as SVG text. */
const n = (value: number, digits = 1): string => String(Math.round(value * 10 ** digits) / 10 ** digits);

function svg(width: number, height: number, body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/** Halo pass, ink pass, colour pass over all parts, so overlapping parts share one outline. */
function layered(parts: readonly Part[]): string {
    const pass = (extra: number, color: (part: Part) => string): string => parts.map((part) => {
        const width = ("w" in part ? part.w : 0) + extra;
        const fill = "fill" in part ? color(part) : "none";
        if (width === 0) return `<path d="${part.d}" fill="${fill}"/>`;
        return `<path d="${part.d}" fill="${fill}" stroke="${color(part)}" stroke-width="${n(width)}" ${ROUND}/>`;
    }).join("");
    return pass(2 * (INK_W + HALO_W), () => WHITE)
        + pass(2 * INK_W, () => INK)
        + pass(0, (part) => ("fill" in part ? part.fill : part.line));
}

function sticker(width: number, height: number, parts: readonly Part[], details = ""): string {
    return svg(width, height, layered(parts) + details);
}

/** A detail drawn on top of the base: optional ink outline, then colour. */
function detailLine(d: string, color: string, w: number, outline = 0): string {
    const ink = outline > 0 ? `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${n(w + 2 * outline)}" ${ROUND}/>` : "";
    return `${ink}<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(w)}" ${ROUND}/>`;
}

function detailFill(d: string, color: string, outline = 0): string {
    const stroke = outline > 0 ? ` stroke="${INK}" stroke-width="${n(outline)}" ${ROUND}` : "";
    return `<path d="${d}" fill="${color}"${stroke}/>`;
}

function circle(cx: number, cy: number, r: number): string {
    return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
    return `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}`
        + `A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}`
        + `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

/** A closed polygon through points at `radii[i % radii.length]` around (cx, cy), the first point straight up. */
function radial(cx: number, cy: number, count: number, radii: readonly number[], squash = 1, turn = 0): string {
    const points = Array.from({ length: count }, (_, i) => {
        const angle = -Math.PI / 2 + turn + (i * 2 * Math.PI) / count;
        const r = radii[i % radii.length];
        return `${n(cx + r * Math.cos(angle))} ${n(cy + r * squash * Math.sin(angle))}`;
    });
    return `M${points.join("L")}Z`;
}

const star = (cx: number, cy: number, outer: number, inner: number): string => radial(cx, cy, 10, [outer, inner]);

/** A four-point twinkle with curved sides. */
function twinkle(cx: number, cy: number, r: number): string {
    const a = r * 0.16;
    return `M${n(cx)} ${n(cy - r)}Q${n(cx + a)} ${n(cy - a)} ${n(cx + r)} ${n(cy)}Q${n(cx + a)} ${n(cy + a)} ${n(cx)} ${n(cy + r)}`
        + `Q${n(cx - a)} ${n(cy + a)} ${n(cx - r)} ${n(cy)}Q${n(cx - a)} ${n(cy - a)} ${n(cx)} ${n(cy - r)}Z`;
}

/** A circle of `count` outward bumps (a rosette badge edge). */
function scallop(cx: number, cy: number, r: number, count: number): string {
    const point = (i: number): [number, number] => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
        return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    };
    const bump = r * Math.sin(Math.PI / count) * 1.05;
    const [x0, y0] = point(0);
    let d = `M${n(x0)} ${n(y0)}`;
    for (let i = 1; i <= count; i += 1) {
        const [x, y] = point(i);
        d += `A${n(bump)} ${n(bump)} 0 0 1 ${n(x)} ${n(y)}`;
    }
    return `${d}Z`;
}

// Lettering: a rounded stroke alphabet on a 12-unit cap height (only the letters the badges use).
const GLYPHS: Record<string, { d: string; w: number }> = {
    A: { d: "M0 12L4 0L8 12M1.6 7.4H6.4", w: 8 },
    B: { d: "M0 6H4.5C8 6 8 12 4.5 12H0V0H4C7.2 0 7.2 6 4 6", w: 7.4 },
    C: { d: "M8 2.2C6.4 -0.6 0 -0.8 0 6C0 12.8 6.4 12.6 8 9.8", w: 8 },
    E: { d: "M7 0H0V12H7M0 6H5.6", w: 7 },
    I: { d: "M0 0V12", w: 0 },
    L: { d: "M0 0V12H7", w: 7 },
    N: { d: "M0 12V0L8 12V0", w: 8 },
    R: { d: "M0 12V0H4.4C8.4 0 8.4 6.4 4.4 6.4H0M4 6.4L8 12", w: 8 },
    S: { d: "M7.6 2C6.6 0 1.4 -0.2 0.8 2.8C0.2 5.6 7.8 5.4 7.6 8.8C7.4 12.2 1.4 12.4 0.2 10", w: 7.8 },
    U: { d: "M0 0V7.6C0 13.2 8 13.2 8 7.6V0", w: 8 },
    V: { d: "M0 0L4 12L8 0", w: 8 },
    W: { d: "M0 0L2.4 12L5 3.6L7.6 12L10 0", w: 10 },
};
const LETTER_GAP = 3.6;

/** Text centred on (cx, cy), `height` tall, stroke width `w`, with an ink outline of `outline`. */
function lettering(text: string, cx: number, cy: number, height: number, color: string, w: number, outline: number): string {
    const s = height / 12;
    const glyphs = [...text].map((char) => GLYPHS[char]);
    const total = glyphs.reduce((sum, glyph) => sum + glyph.w, 0) + LETTER_GAP * (glyphs.length - 1);
    let x = cx - (total * s) / 2;
    const placed: string[] = [];
    for (const glyph of glyphs) {
        placed.push(`<path transform="translate(${n(x)} ${n(cy - height / 2)}) scale(${n(s, 3)})" d="${glyph.d}" fill="none" stroke="COLOR" stroke-width="WIDTH" ${ROUND}/>`);
        x += (glyph.w + LETTER_GAP) * s;
    }
    const withPaint = (paint: string, width: number) => placed.map((p) => p.replace("COLOR", paint).replace("WIDTH", n(width / s, 2))).join("");
    return (outline > 0 ? withPaint(INK, w + 2 * outline) : "") + withPaint(color, w);
}

function bell(cx: number, top: number, size: number): string {
    const s = size / 44;
    const x = (value: number) => n(cx + value * s);
    const y = (value: number) => n(top + value * s);
    const body = `M${x(0)} ${y(4)}C${x(-12)} ${y(4)} ${x(-17)} ${y(13)} ${x(-17)} ${y(23)}V${y(31)}L${x(-22)} ${y(37)}H${x(22)}`
        + `L${x(17)} ${y(31)}V${y(23)}C${x(17)} ${y(13)} ${x(12)} ${y(4)} ${x(0)} ${y(4)}Z`;
    return detailFill(circle(cx, top + 40 * s, 5 * s), WHITE, 3) + detailFill(body, WHITE, 3) + detailFill(circle(cx, top + 3 * s, 3.5 * s), WHITE, 3);
}

const own = (slug: string, category: OwnStickerCategory, name: string, keywords: readonly string[], markup: string): OwnSticker => (
    { slug, category, name, keywords, svg: markup }
);

const ARROWS: OwnSticker[] = [
    own("arrow-right", "arrows", "Arrow", ["arrow", "right", "next", "point", "direction"],
        sticker(240, 140, [{ d: "M24 50H138V22L216 70L138 118V90H24Z", fill: RED }])),
    own("arrow-curved", "arrows", "Curved arrow", ["arrow", "curve", "bend", "turn", "up"],
        sticker(240, 200, [
            { d: "M36 168C40 100 90 60 168 60", line: YELLOW, w: 22 },
            { d: "M160 22L214 60L160 98Z", fill: YELLOW },
        ])),
    own("arrow-hand-drawn", "arrows", "Hand-drawn arrow", ["arrow", "hand drawn", "doodle", "sketch", "scribble", "loop"],
        sticker(240, 180, [
            { d: "M28 140C60 150 98 122 92 94C88 68 58 72 66 98C76 126 130 120 158 86C170 72 180 60 190 50", line: PINK, w: 12 },
            { d: "M158 44L193 47L189 82", line: PINK, w: 12 },
        ])),
    own("arrow-double", "arrows", "Double arrow", ["arrow", "double", "both ways", "left right", "swap"],
        sticker(240, 120, [{ d: "M20 60L70 18V42H170V18L220 60L170 102V78H70V102Z", fill: BLUE }])),
    own("arrow-circular", "arrows", "Circular arrow", ["arrow", "circle", "loop", "repeat", "refresh", "replay"],
        sticker(220, 220, [
            { d: "M62 68A64 64 0 1 0 158 68", line: GREEN, w: 22 },
            { d: "M136 42L184 56L142 92Z", fill: GREEN },
        ])),
    own("arrow-zigzag", "arrows", "Zigzag arrow", ["arrow", "zigzag", "growth", "up", "trend"],
        sticker(240, 160, [
            { d: "M24 136L84 64L128 112L180 52", line: ORANGE, w: 20 },
            { d: "M201 28L195 75L155 41Z", fill: ORANGE },
        ])),
    own("arrow-chevrons", "arrows", "Chevron arrows", ["arrow", "chevron", "forward", "fast", "next", "swipe"],
        sticker(240, 140, [18, 82, 146].map((x, i) => ({
            d: `M${x} 24L${x + 40} 70L${x} 116H${x + 28}L${x + 68} 70L${x + 28} 24Z`,
            fill: [YELLOW, ORANGE, RED][i],
        })))),
    own("arrow-pointer", "arrows", "Cursor arrow", ["arrow", "cursor", "pointer", "click", "mouse", "tutorial"],
        sticker(200, 240, [{ d: "M48 28V196L92 154L122 214L152 200L122 142L182 140Z", fill: WHITE }])),
];

const SHAPES: OwnSticker[] = [
    own("star", "shapes", "Star", ["star", "favorite", "shape", "rating"],
        sticker(240, 240, [{ d: star(120, 128, 104, 44), fill: YELLOW }],
            detailLine("M92 98L104 78", WHITE, 7))),
    own("heart", "shapes", "Heart", ["heart", "love", "like", "shape", "valentine"],
        sticker(240, 220, [{
            d: "M120 196C120 196 24 140 24 78C24 46 48 24 76 24C96 24 112 36 120 52C128 36 144 24 164 24C192 24 216 46 216 78C216 140 120 196 120 196Z",
            fill: RED,
        }], detailLine("M54 70C56 56 66 48 78 48", WHITE, 9))),
    own("burst", "shapes", "Burst", ["burst", "boom", "pop", "explosion", "circle burst", "shape"],
        sticker(240, 240, [{ d: radial(120, 120, 32, [104, 82]), fill: ORANGE }],
            detailFill(circle(120, 120, 56), YELLOW))),
    own("blob", "shapes", "Blob", ["blob", "organic", "shape", "background", "splash"],
        sticker(240, 220, [{ d: "M128 26C172 24 214 56 212 104C210 150 178 196 124 194C70 192 26 166 28 112C30 62 80 28 128 26Z", fill: TEAL }])),
    own("ring", "shapes", "Ring", ["ring", "circle", "highlight", "outline", "shape"],
        sticker(240, 240, [{ d: circle(120, 120, 82), line: PINK, w: 28 }])),
    own("triangle", "shapes", "Triangle", ["triangle", "shape", "play"],
        sticker(240, 220, [{ d: "M120 28L214 192H26Z", fill: GREEN }])),
    own("hexagon", "shapes", "Hexagon", ["hexagon", "shape", "honeycomb"],
        sticker(240, 240, [{ d: radial(120, 120, 6, [100]), fill: BLUE }])),
    own("sparkle-star", "shapes", "Twinkle star", ["star", "twinkle", "sparkle", "shine", "shape"],
        sticker(240, 240, [{ d: twinkle(120, 120, 98), fill: YELLOW }])),
];

const CALLOUTS: OwnSticker[] = [
    own("speech-bubble", "callouts", "Speech bubble", ["speech", "bubble", "talk", "say", "comment", "callout"],
        sticker(240, 200, [{ d: "M48 28H192C206 28 216 38 216 52V120C216 134 206 144 192 144H104L60 180L72 144H48C34 144 24 134 24 120V52C24 38 34 28 48 28Z", fill: WHITE }])),
    own("thought-bubble", "callouts", "Thought bubble", ["thought", "bubble", "think", "dream", "cloud", "callout"],
        sticker(240, 220, [
            { d: "M70 140C40 140 26 116 36 94C22 76 36 48 62 52C70 30 100 22 120 36C138 20 172 26 178 50C204 50 220 76 206 96C218 118 202 142 176 140C164 158 134 160 120 146C104 160 80 158 70 140Z", fill: WHITE },
            { d: circle(64, 172, 13), fill: WHITE },
            { d: circle(38, 198, 8), fill: WHITE },
        ])),
    own("shout-bubble", "callouts", "Shout bubble", ["shout", "bubble", "yell", "loud", "wow", "callout", "comic"],
        sticker(240, 224, [{
            d: "M120 22L138 52L170 30L172 62L210 58L192 88L222 106L190 120L206 152L170 148L162 182L136 160L112 188L98 156L60 206L72 148L34 150L50 120L18 104L50 88L32 58L70 62L72 30L102 52Z",
            fill: YELLOW,
        }])),
    own("label-rounded", "callouts", "Rounded label", ["label", "pill", "title", "caption", "lower third", "callout"],
        sticker(240, 120, [{ d: roundedRect(20, 24, 200, 72, 36), fill: PINK }])),
    own("tag", "callouts", "Tag", ["tag", "price", "label", "sale", "callout"],
        sticker(240, 140, [{ d: "M24 70L72 26H204C212 26 218 32 218 40V100C218 108 212 114 204 114H72Z", fill: ORANGE }],
            detailFill(circle(72, 70, 10), WHITE, 4))),
    own("pointer-box", "callouts", "Pointer box", ["box", "pointer", "callout", "note", "info", "tooltip"],
        sticker(240, 200, [{ d: "M40 24H200C210 24 216 30 216 40V120C216 130 210 136 200 136H140L120 172L100 136H40C30 136 24 130 24 120V40C24 30 30 24 40 24Z", fill: BLUE }])),
];

const BADGES: OwnSticker[] = [
    own("badge-new", "badges", "New badge", ["new", "badge", "fresh", "launch"],
        sticker(240, 240, [{ d: radial(120, 120, 40, [106, 92]), fill: RED }],
            lettering("NEW", 120, 120, 44, WHITE, 9, 4))),
    own("badge-sale", "badges", "Sale badge", ["sale", "badge", "discount", "deal", "offer", "shop"],
        sticker(240, 140, [{ d: roundedRect(20, 26, 200, 88, 22), fill: YELLOW }],
            lettering("SALE", 120, 70, 46, RED, 10, 4))),
    own("badge-live", "badges", "Live badge", ["live", "badge", "stream", "broadcast", "now", "on air"],
        sticker(240, 120, [{ d: roundedRect(18, 24, 204, 72, 36), fill: RED }],
            detailFill(circle(62, 60, 12), WHITE, 4) + lettering("LIVE", 142, 60, 36, WHITE, 8, 3))),
    own("badge-subscribe", "badges", "Subscribe button", ["subscribe", "follow", "button", "bell", "notification", "badge", "channel"],
        sticker(300, 100, [{ d: roundedRect(14, 18, 272, 64, 32), fill: RED }],
            bell(56, 28, 44) + lettering("SUBSCRIBE", 182, 50, 22, WHITE, 5, 2.5))),
    own("badge-check", "badges", "Check badge", ["check", "badge", "verified", "approved", "done", "quality"],
        sticker(240, 240, [{ d: scallop(120, 120, 88, 14), fill: GREEN }],
            detailLine("M78 122L106 150L162 92", WHITE, 18, 4))),
    own("badge-rating", "badges", "5-star rating", ["rating", "stars", "review", "five stars", "badge", "score"],
        sticker(300, 100, [40, 95, 150, 205, 260].map((cx) => ({ d: star(cx, 52, 28, 12), fill: YELLOW })))),
];

const SPARKLES: OwnSticker[] = [
    own("sparkles-trio", "sparkles", "Sparkles", ["sparkle", "sparkles", "shine", "magic", "twinkle", "new"],
        sticker(240, 240, [
            { d: twinkle(98, 132, 78), fill: YELLOW },
            { d: twinkle(184, 60, 36), fill: WHITE },
            { d: twinkle(186, 182, 26), fill: PINK },
        ])),
    own("sparkle-shine", "sparkles", "Shine lines", ["shine", "glow", "emphasis", "lines", "highlight", "wow"],
        sticker(240, 240, Array.from({ length: 8 }, (_, i) => {
            const angle = (i * Math.PI) / 4 - Math.PI / 2;
            const outer = i % 2 === 0 ? 98 : 84;
            const p = (r: number) => `${n(120 + r * Math.cos(angle))} ${n(120 + r * Math.sin(angle))}`;
            return { d: `M${p(56)}L${p(outer)}`, line: YELLOW, w: 14 };
        }))),
    own("glitter", "sparkles", "Glitter", ["glitter", "sparkle", "confetti", "shine", "party"],
        sticker(240, 240, [
            { d: twinkle(76, 82, 44), fill: YELLOW },
            { d: twinkle(170, 150, 50), fill: PINK },
            { d: twinkle(172, 56, 22), fill: TEAL },
            { d: twinkle(70, 182, 24), fill: PURPLE },
            { d: circle(126, 40, 9), fill: ORANGE },
            { d: circle(34, 130, 8), fill: TEAL },
            { d: circle(124, 206, 9), fill: YELLOW },
            { d: circle(214, 96, 7), fill: WHITE },
        ])),
    own("shooting-star", "sparkles", "Shooting star", ["shooting star", "star", "wish", "magic", "fast"],
        sticker(240, 200, [
            { d: "M38 128L118 92", line: ORANGE, w: 10 },
            { d: "M54 170L130 120", line: PINK, w: 10 },
            { d: "M96 184L140 138", line: PURPLE, w: 10 },
            { d: star(166, 74, 48, 21), fill: YELLOW },
        ])),
];

const MARKS: OwnSticker[] = [
    own("mark-check", "marks", "Check mark", ["check", "tick", "yes", "done", "correct", "mark"],
        sticker(240, 240, [{ d: "M46 126L96 176L196 68", line: GREEN, w: 34 }])),
    own("mark-cross", "marks", "Cross mark", ["cross", "x", "no", "wrong", "cancel", "mark"],
        sticker(240, 240, [{ d: "M62 62L178 178M178 62L62 178", line: RED, w: 34 }])),
    own("mark-question", "marks", "Question mark", ["question", "ask", "what", "faq", "help", "mark"],
        sticker(220, 240, [
            { d: "M64 86C64 52 88 34 112 34C140 34 160 52 160 78C160 104 132 112 118 126C110 134 108 144 108 156", line: PURPLE, w: 30 },
            { d: circle(108, 204, 18), fill: PURPLE },
        ])),
    own("mark-exclamation", "marks", "Exclamation mark", ["exclamation", "alert", "warning", "important", "attention", "mark"],
        sticker(160, 240, [
            { d: "M56 42C56 22 104 22 104 42L93 150C91 162 69 162 67 150Z", fill: YELLOW },
            { d: circle(80, 200, 20), fill: YELLOW },
        ])),
];

export const OWN_STICKERS: readonly OwnSticker[] = [...ARROWS, ...SHAPES, ...CALLOUTS, ...BADGES, ...SPARKLES, ...MARKS];
