// Confetti burst: `count` (1–200) pieces fly out from the centre, or up from the bottom / down from the top edge,
// with gravity and spin, fading out over the last half second, as the CSS original: positions in % of the frame
// (left/top of each piece), speeds 18–60 %/s, gravity 52 (26 from the top) %/s², spin ±360°/s, 10–26 px pieces
// cycling squares (radius 2), strips (45 % tall), and dots through the palette. The original's sine hash is
// replaced by a seeded integer PRNG (mulberry32) keyed by template and particle index, so every renderer draws
// identical pixels and adding particles keeps the existing ones where they were.
import { clampedInterpolate } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { clipBounds, hashString, jsonParam, numberOr, roundedRectPath, seededRandom, str, unionBounds } from "./helpers";

const FALLBACK_COLORS = ["#7c3aed", "#06b6d4", "#f59e0b", "#ef4444", "#22c55e"];
const SEED = hashString("confetti-burst");

const rand = (n: number) => seededRandom((SEED + n) | 0);

export const drawConfettiBurst: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, fps, props }) => {
    const parsed = jsonParam<unknown>(props.colors, []);
    const palette = Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
    if (palette.length === 0) palette.push(...FALLBACK_COLORS);
    const n = Math.max(1, Math.min(200, Math.round(numberOr(props.count, 80))));
    const origin = str(props.origin, "center");
    const originY = origin === "bottom" ? 105 : origin === "top" ? -5 : 50;
    const fade = clampedInterpolate(frame, [durationInFrames - fps * 0.5, durationInFrames], [1, 0]);
    if (!(fade > 0)) return null;
    const t = frame / fps;
    const gravity = origin === "top" ? 26 : 52;
    const spreadX = origin === "center" ? 1 : 1.4;
    const spreadY = origin === "center" ? 1 : -1.2;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    ctx.globalAlpha = base * fade;
    for (let i = 0; i < n; i += 1) {
        const angle = rand(i) * Math.PI * 2;
        const speed = 18 + rand(i + 1000) * 42;
        const left = ((50 + Math.cos(angle) * speed * t * spreadX) / 100) * width;
        const top = ((originY + Math.sin(angle) * speed * t * spreadY + gravity * t * t) / 100) * height;
        const spin = (rand(i + 2000) * 720 - 360) * t;
        const size = 10 + rand(i + 3000) * 16;
        const shape = i % 3;
        const w = size;
        const h = shape === 1 ? size * 0.45 : size;
        const cx = left + w / 2;
        const cy = top + h / 2;
        const reach = Math.hypot(w, h) / 2;
        const box = { x: cx - reach, y: cy - reach, width: 2 * reach, height: 2 * reach };
        if (!clipBounds(box, width, height)) continue;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((spin * Math.PI) / 180);
        ctx.fillStyle = palette[i % palette.length];
        if (shape === 2) {
            ctx.beginPath();
            ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        } else {
            roundedRectPath(ctx, -w / 2, -h / 2, w, h, 2);
        }
        ctx.fill();
        ctx.restore();
        boxes.push(box);
    }
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
