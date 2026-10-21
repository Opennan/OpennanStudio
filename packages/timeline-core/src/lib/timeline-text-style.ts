// Shared parsing and presets for timeline text, caption, and subtitle clips.
export type TimelineTextClipKind = "text" | "caption" | "subtitle";
export type TimelineCaptionPosition = "top" | "center" | "bottom";

export function normalizeTimelineTextClipKind(value: unknown): TimelineTextClipKind {
  if (value === "caption" || value === "subtitle") return value;
  return "text";
}

export function normalizeTimelineCaptionPosition(value: unknown): TimelineCaptionPosition {
  if (value === "top" || value === "center" || value === "bottom") return value;
  return "bottom";
}

export function parseTimelineTextStyle(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getTimelineTextClipKind(rawStyle: string | null | undefined, label?: string | null): TimelineTextClipKind {
  const style = parseTimelineTextStyle(rawStyle);
  const explicitKind = normalizeTimelineTextClipKind(style.captionKind ?? style.textClipKind ?? style.role);
  if (explicitKind !== "text") return explicitKind;

  const metadata = `${rawStyle ?? ""} ${label ?? ""}`.toLowerCase();
  if (metadata.includes("\"captionkind\":\"subtitle\"") || metadata.includes("\"role\":\"subtitle\"")) return "subtitle";
  if (metadata.includes("\"captionkind\":\"caption\"") || metadata.includes("\"role\":\"caption\"")) return "caption";
  return "text";
}

export function getTimelineCaptionPosition(rawStyle: string | null | undefined): TimelineCaptionPosition {
  return normalizeTimelineCaptionPosition(parseTimelineTextStyle(rawStyle).captionPosition);
}

export function getTimelineCaptionMaxWidthRatio(rawStyle: string | null | undefined): number | null {
  const kind = getTimelineTextClipKind(rawStyle);
  if (kind === "text") return null;
  const value = Number(parseTimelineTextStyle(rawStyle).maxWidthRatio);
  if (Number.isFinite(value) && value > 0 && value <= 1) return value;
  return kind === "caption" ? 0.78 : 0.86;
}

export function getTimelineTextStylePreset(textStylePreset: string): string {
  const value = textStylePreset.trim().toLowerCase();
  const presets: Record<string, Record<string, string | number>> = {
    title: {
      textClipKind: "text",
      fontSize: 48,
      fontWeight: "bold",
      fontFamily: "Inter, sans-serif",
      color: "#ffffff",
      textAlign: "center",
      strokeWidth: 2,
      strokeColor: "#000000",
      bgColor: "transparent",
      letterSpacing: 0,
    },
    caption: {
      textClipKind: "caption",
      captionKind: "caption",
      captionPosition: "bottom",
      wordsPerLine: "multiple",
      maxWidthRatio: 0.78,
      // Font sizes are authored at EXPORT resolution (1080p-class frames, up
      // to 1920px tall for 9:16) — sized ~3-4% of frame height to be readable.
      fontSize: 56,
      fontWeight: "700",
      fontFamily: "Inter, sans-serif",
      color: "#ffffff",
      textAlign: "center",
      strokeWidth: 0,
      strokeColor: "#000000",
      bgColor: "rgba(0,0,0,0.62)",
      letterSpacing: 0,
      shadowColor: "rgba(0,0,0,0.7)",
      shadowBlur: 4,
      shadowOffsetY: 2,
    },
    subtitle: {
      textClipKind: "subtitle",
      captionKind: "subtitle",
      captionPosition: "bottom",
      wordsPerLine: "multiple",
      maxWidthRatio: 0.86,
      fontSize: 48,
      fontWeight: "600",
      fontFamily: "Inter, sans-serif",
      color: "#ffffff",
      textAlign: "center",
      strokeWidth: 1.5,
      strokeColor: "#000000",
      bgColor: "rgba(0,0,0,0.48)",
      letterSpacing: 0,
      shadowColor: "rgba(0,0,0,0.7)",
      shadowBlur: 2,
      shadowOffsetY: 1,
    },
  };

  return JSON.stringify(presets[value] ?? presets.title);
}
