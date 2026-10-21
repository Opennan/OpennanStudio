// Text style templates (phase 10b): twenty CapCut-style looks for the Text tab and agents. Each is a
// `textStyle` object (lib/preview-text-draw.ts fields) using bundled fonts only (text/fonts.ts), a
// default text, and an optional default animation. Font sizes are reference px (1080p-class frames).
import type { AnimationSpec } from "../motion/types";
import { parseTimelineTextStyle } from "../lib/timeline-text-style";
import { fontStack } from "./fonts";

export type TextTemplateCategory = "basic" | "social" | "neon" | "outline" | "gradient" | "handwritten" | "display";

export interface TextTemplate {
    id: string;
    category: TextTemplateCategory;
    defaultText: string;
    style: Record<string, unknown>;
    animation?: AnimationSpec;
}

const fadeIn = (duration = 0.4): AnimationSpec["in"] => ({ id: "fade", duration });

export const TEXT_TEMPLATES: readonly TextTemplate[] = [
    // ── Basic ──
    {
        id: "plain", category: "basic", defaultText: "Add your text",
        style: { fontFamily: fontStack("Inter"), fontWeight: "700", fontSize: 64, color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.45)", shadowBlur: 6, shadowOffsetY: 2 },
        animation: { in: fadeIn() },
    },
    {
        id: "title_bold", category: "basic", defaultText: "Big title",
        style: {
            fontFamily: fontStack("Montserrat"), fontWeight: "900", fontSize: 96, color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 2,
            shadowColor: "rgba(0,0,0,0.5)", shadowBlur: 12, shadowOffsetY: 4,
        },
        animation: { in: { id: "pop", duration: 0.5 } },
    },
    {
        id: "subtitle_clean", category: "basic", defaultText: "A clean subtitle line",
        style: { fontFamily: fontStack("Poppins"), fontWeight: "600", fontSize: 52, color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.85)", shadowBlur: 8, shadowOffsetY: 2 },
        animation: { in: fadeIn(0.3), out: { id: "fade", duration: 0.3 } },
    },
    {
        id: "lower_third", category: "basic", defaultText: "Alex Morgan · Creator",
        style: {
            fontFamily: fontStack("Montserrat"), fontWeight: "700", fontSize: 44, color: "#FFFFFF", textAlign: "left",
            bgColor: "rgba(17,17,17,0.85)", bgPadding: 18, bgRadius: 6, letterSpacing: 0.5,
        },
        animation: { in: { id: "slide_right", duration: 0.5 }, out: { id: "fade", duration: 0.4 } },
    },
    // ── Social ──
    {
        id: "caption_pill", category: "social", defaultText: "Wait for it…",
        style: { fontFamily: fontStack("Poppins"), fontWeight: "800", fontSize: 56, color: "#111111", bgColor: "#FFFFFF", bgPadding: 18, bgRadius: 999 },
        animation: { in: { id: "pop", duration: 0.4 } },
    },
    {
        id: "tiktok_bold", category: "social", defaultText: "POV: you finally did it",
        style: { fontFamily: fontStack("Montserrat"), fontWeight: "900", fontSize: 72, color: "#FFFFFF", strokeWidth: 8, strokeColor: "#000000" },
        animation: { in: { id: "pop", duration: 0.35 } },
    },
    {
        id: "yellow_pop", category: "social", defaultText: "No way!",
        style: {
            fontFamily: fontStack("Montserrat"), fontWeight: "900", fontSize: 80, color: "#FFE14D", textTransform: "uppercase",
            strokeWidth: 6, strokeColor: "#111111", shadowColor: "rgba(0,0,0,0.6)", shadowBlur: 2, shadowOffsetX: 4, shadowOffsetY: 5,
        },
        animation: { in: { id: "bounce", duration: 0.6 } },
    },
    {
        id: "boxed_white", category: "social", defaultText: "Boxed caption",
        style: { fontFamily: fontStack("Inter"), fontWeight: "700", fontSize: 56, color: "#000000", bgColor: "#FFFFFF", bgPadding: 14, bgRadius: 4 },
        animation: { in: { id: "slide_up", duration: 0.4 } },
    },
    // ── Neon & glow ──
    {
        id: "neon_pink", category: "neon", defaultText: "Neon nights",
        style: { fontFamily: fontStack("Lobster"), fontWeight: "400", fontSize: 84, color: "#FFE6F7", glowColor: "#FF2BD6", glowSize: 18 },
        animation: { in: fadeIn(0.5), loop: { id: "glow", period: 1.6 } },
    },
    {
        id: "neon_cyan", category: "neon", defaultText: "Cyber city",
        style: {
            fontFamily: fontStack("Montserrat"), fontWeight: "700", fontSize: 68, color: "#E6FFFF", textTransform: "uppercase", letterSpacing: 4,
            glowColor: "#00E5FF", glowSize: 16,
        },
        animation: { in: fadeIn(0.5), loop: { id: "flicker", period: 2.4 } },
    },
    {
        id: "soft_glow", category: "neon", defaultText: "Dreamy glow",
        style: { fontFamily: fontStack("Poppins"), fontWeight: "600", fontSize: 64, color: "#FFFFFF", glowColor: "rgba(255,236,250,0.9)", glowSize: 12 },
        animation: { in: { id: "blur_in", duration: 0.6 } },
    },
    // ── Outline & shadow ──
    {
        id: "outline_thick", category: "outline", defaultText: "Outline",
        style: {
            fontFamily: fontStack("Anton"), fontWeight: "400", fontSize: 92, color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 2,
            strokeWidth: 10, strokeColor: "#7C3AED", shadowColor: "rgba(0,0,0,0.35)", shadowBlur: 8, shadowOffsetY: 4,
        },
        animation: { in: { id: "zoom", duration: 0.45 } },
    },
    {
        id: "drop_shadow", category: "outline", defaultText: "Drop shadow",
        style: { fontFamily: fontStack("Montserrat"), fontWeight: "900", fontSize: 80, color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.75)", shadowBlur: 14, shadowOffsetY: 8 },
        animation: { in: { id: "slide_up", duration: 0.5 } },
    },
    {
        id: "long_shadow", category: "outline", defaultText: "Long shadow",
        style: {
            fontFamily: fontStack("Bebas Neue"), fontWeight: "400", fontSize: 120, color: "#FFD60A", textTransform: "uppercase", letterSpacing: 3,
            shadowColor: "#1D3557", shadowBlur: 1, shadowOffsetX: 7, shadowOffsetY: 7,
        },
        animation: { in: { id: "slide_left", duration: 0.5 } },
    },
    // ── Gradient ──
    {
        id: "gradient_sunset", category: "gradient", defaultText: "Sunset",
        style: {
            fontFamily: fontStack("Montserrat"), fontWeight: "900", fontSize: 96, textTransform: "uppercase", color: "#FF8A3D",
            gradient: { from: "#FFD200", to: "#FF3D77", angle: 90 }, shadowColor: "rgba(0,0,0,0.35)", shadowBlur: 10, shadowOffsetY: 4,
        },
        animation: { in: { id: "wipe", duration: 0.6 } },
    },
    {
        id: "gradient_ocean", category: "gradient", defaultText: "Ocean vibes",
        style: {
            fontFamily: fontStack("Poppins"), fontWeight: "800", fontSize: 84, color: "#22C1EE",
            gradient: { from: "#00F5D4", to: "#3A86FF", angle: 0 }, shadowColor: "rgba(0,0,0,0.3)", shadowBlur: 8, shadowOffsetY: 3,
        },
        animation: { in: { id: "slide_up", duration: 0.5 }, loop: { id: "float", period: 2.5 } },
    },
    // ── Handwritten ──
    {
        id: "handwritten_caveat", category: "handwritten", defaultText: "Dear diary…",
        style: { fontFamily: fontStack("Caveat"), fontWeight: "700", fontSize: 88, color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.5)", shadowBlur: 6, shadowOffsetY: 2 },
        animation: { in: { id: "typewriter", duration: 1.2 } },
    },
    {
        id: "script_dancing", category: "handwritten", defaultText: "Happy birthday",
        style: { fontFamily: fontStack("Dancing Script"), fontWeight: "700", fontSize: 88, color: "#FFF4E0", shadowColor: "rgba(0,0,0,0.45)", shadowBlur: 8, shadowOffsetY: 3 },
        animation: { in: { id: "wipe", duration: 0.9 } },
    },
    // ── Display ──
    {
        id: "poster_bebas", category: "display", defaultText: "Grand opening",
        style: {
            fontFamily: fontStack("Bebas Neue"), fontWeight: "400", fontSize: 128, color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 6,
            shadowColor: "rgba(0,0,0,0.4)", shadowBlur: 10, shadowOffsetY: 4,
        },
        animation: { in: { id: "letter_rise", duration: 0.8 } },
    },
    {
        id: "comic_bangers", category: "display", defaultText: "Boom!",
        style: {
            fontFamily: fontStack("Bangers"), fontWeight: "400", fontSize: 104, color: "#FFE14D", textTransform: "uppercase", letterSpacing: 2,
            strokeWidth: 8, strokeColor: "#111111", shadowColor: "#E63946", shadowBlur: 1, shadowOffsetX: 6, shadowOffsetY: 6,
        },
        animation: { in: { id: "pop", duration: 0.4 }, loop: { id: "shake", period: 1.2 } },
    },
];

export function textTemplateById(id: string): TextTemplate | undefined {
    return TEXT_TEMPLATES.find((t) => t.id === id);
}

/** Keys of a prior style that a template keeps: what kind of text clip it is and where/how captions wrap. */
const KEPT_KEYS = ["captionKind", "textClipKind", "role", "captionPosition"] as const;
const KEPT_LAYOUT_KEYS = ["wordsPerLine", "maxWidthRatio"] as const;

/** Applies a template: its style, keeping the prior's caption-kind keys, position, and wrap layout. Null for unknown ids. */
export function templateStyleJson(id: string, prior?: string | null): string | null {
    const template = textTemplateById(id);
    if (!template) return null;
    const previous = parseTimelineTextStyle(prior);
    const next: Record<string, unknown> = { ...template.style };
    for (const key of [...KEPT_KEYS, ...KEPT_LAYOUT_KEYS]) {
        if (previous[key] !== undefined && previous[key] !== null) next[key] = previous[key];
    }
    return JSON.stringify(next);
}
