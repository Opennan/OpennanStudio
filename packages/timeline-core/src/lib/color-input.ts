// Coerce an arbitrary CSS color string into a value that <input type="color">
// accepts. The native color input only understands a lowercase 7-char #rrggbb
// hex; anything else (named colors, "transparent", rgb()/rgba()) is silently
// coerced to #000000 by the browser and logs a React "invalid value" warning.
// Text-style presets store "transparent" / "rgba(0,0,0,0.6)", so normalize here.

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;

function channelToHex(n: number): string {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

export function toColorInputValue(
    value: string | null | undefined,
    fallback = "#000000",
): string {
    const v = (value ?? "").trim();

    if (HEX6.test(v)) return v.toLowerCase();

    const short = v.match(HEX3);
    if (short) {
        return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    }

    const rgb = v.match(RGB);
    if (rgb) {
        return `#${channelToHex(Number(rgb[1]))}${channelToHex(Number(rgb[2]))}${channelToHex(Number(rgb[3]))}`;
    }

    // "transparent", named colors, empty, or garbage: a color input cannot
    // represent these, so show the caller's fallback instead of a lying swatch.
    return fallback;
}
