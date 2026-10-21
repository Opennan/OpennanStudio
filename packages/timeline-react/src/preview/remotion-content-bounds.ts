// A Remotion graphics clip is a FULL-FRAME transparent composition, so its
// layer rect is always the whole preview screen — useless as a selection box.
// This walks the rendered DOM and unions the boxes of the elements that
// actually paint, so the editor can frame the visible graphic instead.

export type ContentRect = { x: number; y: number; w: number; h: number };

/** Elements this large are the composition's own full-bleed wrappers, not
 *  content. Ratio of the layer's own area. */
const WRAPPER_AREA_RATIO = 0.97;
const MIN_CONTENT_PX = 2;

function isPaintingElement(el: Element): boolean {
    // Built-in graphics draw on a canvas and mark what they paint with this box (graphics-overlay.tsx).
    if (el.hasAttribute("data-graphics-content")) return (el as HTMLElement).style.display !== "none";
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "SVG" || el.tagName === "CANVAS") return true;
    const bg = style.backgroundColor;
    const hasBg = !!bg && bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg);
    const border = style.borderStyle;
    const hasBorder = !!border && border !== "none" && Number.parseFloat(style.borderWidth || "0") > 0;
    const shadow = style.boxShadow;
    const hasShadow = !!shadow && shadow !== "none";
    if (hasBg || hasBorder || hasShadow) return true;
    // Text nodes paint through their nearest element ancestor.
    return Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim().length > 0,
    );
}

/** Union of every painting descendant's box, in the same coordinate space as
 *  `layer` (client coordinates). Returns null when nothing measurable paints —
 *  callers should fall back to the layer rect. */
export function measureRemotionContentRect(layer: HTMLElement): ContentRect | null {
    const layerRect = layer.getBoundingClientRect();
    const layerArea = layerRect.width * layerRect.height;
    if (layerArea <= 0) return null;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const el of Array.from(layer.querySelectorAll<HTMLElement>("*"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width < MIN_CONTENT_PX || rect.height < MIN_CONTENT_PX) continue;
        // Skip the composition's own full-bleed wrappers.
        if (rect.width * rect.height >= layerArea * WRAPPER_AREA_RATIO) continue;
        if (!isPaintingElement(el)) continue;
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
    }

    if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
    // Clamp to the layer — a composition may overflow its own frame, but the
    // export crops there, so the selectable box does too.
    const x = Math.max(left, layerRect.left);
    const y = Math.max(top, layerRect.top);
    const w = Math.min(right, layerRect.right) - x;
    const h = Math.min(bottom, layerRect.bottom) - y;
    if (w < MIN_CONTENT_PX || h < MIN_CONTENT_PX) return null;
    return { x, y, w, h };
}
