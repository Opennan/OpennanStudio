// Color palette matching existing Tailwind classes in the DOM timeline

export const COLORS = {
  // Track type clip fills (semi-transparent)
  video: {
    fill: "rgba(59, 130, 246, 0.12)",       // blue-500/12
    border: "rgba(59, 130, 246, 0.25)",      // blue-500/25
    text: "rgba(96, 165, 250, 0.7)",         // blue-400/70
    label: "rgba(96, 165, 250, 0.8)",
  },
  // Clip blocks carry a soft tint of the SAME accent as the track-rail icon
  // (blue video / emerald audio / amber text / pink sticker / purple effect /
  // cyan remotion) so lane color and icon color read as one system.
  text: {
    fill: "rgba(251, 191, 36, 0.10)",        // amber-400 — matches rail icon
    border: "rgba(251, 191, 36, 0.32)",
    text: "rgba(255, 255, 255, 0.92)",
    label: "rgba(255, 255, 255, 0.95)",
  },
  sticker: {
    fill: "rgba(244, 114, 182, 0.10)",       // pink-400 — matches rail icon
    border: "rgba(244, 114, 182, 0.32)",
    text: "rgba(255, 255, 255, 0.88)",
    label: "rgba(255, 255, 255, 0.92)",
  },
  audio: {
    fill: "rgba(52, 211, 153, 0.09)",        // emerald-400 — matches rail icon
    border: "rgba(52, 211, 153, 0.30)",
    text: "rgba(255, 255, 255, 0.7)",        // white waveform peaks stay readable
    label: "rgba(255, 255, 255, 0.92)",
  },
  effect: {
    fill: "rgba(192, 132, 252, 0.10)",       // purple-400 — matches rail icon
    border: "rgba(192, 132, 252, 0.30)",
    text: "rgba(255, 255, 255, 0.75)",
    label: "rgba(255, 255, 255, 0.85)",
  },
  remotion: {
    fill: "rgba(34, 211, 238, 0.10)",        // cyan-400 — matches rail icon
    border: "rgba(34, 211, 238, 0.30)",
    text: "rgba(255, 255, 255, 0.75)",
    label: "rgba(255, 255, 255, 0.85)",
  },
  voiceover: {
    fill: "rgba(255, 255, 255, 0.08)",
    border: "rgba(255, 255, 255, 0.2)",
    text: "rgba(255, 255, 255, 0.55)",
    label: "rgba(255, 255, 255, 0.75)",
  },

  // UI elements
  background: "#0A0A0B",
  trackBgEven: "rgba(255, 255, 255, 0.015)",
  trackBgOdd: "rgba(255, 255, 255, 0.025)",
  trackBorder: "rgba(255, 255, 255, 0.04)",
  rulerBg: "rgba(255, 255, 255, 0.01)",
  rulerTick: "rgba(255, 255, 255, 0.15)",
  rulerTickMinor: "rgba(255, 255, 255, 0.08)",
  rulerText: "rgba(255, 255, 255, 0.33)",   // #555
  sceneBoundary: "rgba(255, 255, 255, 0.06)",
  marker: "rgba(250, 204, 21, 0.95)",
  markerLine: "rgba(250, 204, 21, 0.32)",
  markerText: "rgba(254, 240, 138, 0.95)",

  // Playhead — thin white line like the reference editor.
  playhead: "rgba(255, 255, 255, 0.95)",
  playheadAlpha: "rgba(255, 255, 255, 0.8)",

  // Selection — white reads "active" against neutral blocks and footage (monochrome theme).
  selectionRing: "rgba(255, 255, 255, 0.9)",
  selectionRingOffset: "#0A0A0B",
  /** Keyboard focus (the --on-ring token): the focused keyframe diamond's outer ring (phase 10d). */
  focusRing: "rgba(125, 211, 252, 0.4)",

  // Snap guide
  snapLine: "rgba(255, 255, 255, 0.75)",
  snapLineShadow: "rgba(255, 255, 255, 0.18)",
  alignmentGuide: "rgba(255, 255, 255, 0.5)",
  alignmentGuideShadow: "rgba(255, 255, 255, 0.12)",
  continuityGuide: "rgba(34, 197, 94, 0.95)",
  continuityGuideFill: "rgba(34, 197, 94, 0.18)",
  overlapGuide: "rgba(248, 113, 113, 0.95)",
  overlapGuideFill: "rgba(248, 113, 113, 0.22)",

  // Resize handle hover zone
  resizeHandle: "rgba(255, 255, 255, 0.1)",

  // Drag ghost
  dragGhost: 0.5,                            // opacity multiplier

  // Status dots
  statusReady: "#34D399",                    // emerald-400
  statusImages: "#60A5FA",                   // blue-400
  statusGenerating: "#FBBF24",               // amber-400
  statusFaceSwap: "#A78BFA",                 // violet-400
  statusPlanned: "#6B6B73",
  statusDefault: "#3A3A3F",

  // Scene clip special
  continueEdge: "rgba(255, 255, 255, 0.45)",
  warningBadge: "#FBBF24",                   // amber-400

  // Music track — neutral block + white waveform, white border when selected.
  musicFill: "rgba(255, 255, 255, 0.06)",
  musicBorder: "rgba(255, 255, 255, 0.18)",
  musicBorderSelected: "rgba(255, 255, 255, 0.85)",
  musicWaveform: "rgba(255, 255, 255, 0.45)",
  musicVolumeLine: "rgba(255, 255, 255, 0.7)",
  musicVolumeFill: "rgba(255, 255, 255, 0.08)",

  // Transition marker (glass tile on the cut).
  transitionBg: "rgba(8,10,14,0.62)",
  transitionBgSelected: "rgba(8,10,14,0.82)",
  transitionBorder: "rgba(255,255,255,0.35)",
  transitionBorderSelected: "rgba(255,255,255,0.85)",

  // AI in the editor (phase 11): beat dots on audio clips, AI job progress lines, cut preview ghosts.
  beatDot: "rgba(255, 255, 255, 0.7)",
  aiProgress: "rgba(167, 139, 250, 0.95)",
  aiProgressTrack: "rgba(167, 139, 250, 0.25)",
  cutPreviewFill: "rgba(248, 113, 113, 0.18)",
  cutPreviewBorder: "rgba(248, 113, 113, 0.6)",
  // AI director (phase 9b): items a turn or task just changed (monochrome: a dashed white outline and an "AI" tag).
  aiChanged: "rgba(255, 255, 255, 0.9)",
  aiChangedTag: "rgba(10, 10, 11, 0.88)",
  aiChangedText: "rgba(255, 255, 255, 0.95)",
};

// ── Theme injection (spec §5.1) ─────────────────────────────
// COLORS stays the palette the renderer reads. Hosts pass a TimelineTheme;
// renderTimeline applies it per frame (prepareRenderEnvironment), so several
// editors on one page each draw with their own theme.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] };

export type TimelineTheme = typeof COLORS;
export type TimelineThemeOverrides = DeepPartial<TimelineTheme>;

function cloneTheme<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (value && typeof value === "object" && current && typeof current === "object") {
      deepAssign(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/** Code defaults, captured before any theme is applied. */
export const DEFAULT_TIMELINE_THEME: TimelineTheme = cloneTheme(COLORS);

export function resolveTimelineTheme(overrides?: TimelineThemeOverrides): TimelineTheme {
  const theme = cloneTheme(DEFAULT_TIMELINE_THEME);
  if (overrides) deepAssign(theme as unknown as Record<string, unknown>, overrides as Record<string, unknown>);
  return theme;
}

export function applyTimelineTheme(theme: TimelineTheme): void {
  deepAssign(COLORS as unknown as Record<string, unknown>, theme as unknown as Record<string, unknown>);
}

// Same token list as the source (opennan frontend canvas/colors.ts:119-136).
const CSS_TOKENS: Array<[token: string, paths: string[][]]> = [
  ["--timeline-text-fill", [["text", "fill"]]],
  ["--timeline-text-border", [["text", "border"]]],
  ["--timeline-audio-fill", [["audio", "fill"]]],
  ["--timeline-audio-border", [["audio", "border"]]],
  ["--timeline-audio-wave", [["audio", "text"]]],
  ["--timeline-sticker-fill", [["sticker", "fill"]]],
  ["--timeline-effect-fill", [["effect", "fill"]]],
  ["--timeline-effect-border", [["effect", "border"]]],
  ["--timeline-music-fill", [["musicFill"]]],
  ["--timeline-music-wave", [["musicWaveform"]]],
  ["--timeline-playhead", [["playhead"], ["playheadAlpha"]]],
  ["--timeline-transition-bg", [["transitionBg"]]],
  ["--timeline-transition-bg-selected", [["transitionBgSelected"]]],
  ["--timeline-transition-border", [["transitionBorder"]]],
  ["--timeline-selection-ring", [["selectionRing"]]],
  ["--timeline-focus-ring", [["focusRing"]]],
  ["--timeline-snap-line", [["snapLine"]]],
  ["--timeline-beat-dot", [["beatDot"]]],
  ["--timeline-ai-progress", [["aiProgress"]]],
  ["--timeline-ai-progress-track", [["aiProgressTrack"]]],
  ["--timeline-cut-preview", [["cutPreviewFill"]]],
  ["--timeline-cut-preview-border", [["cutPreviewBorder"]]],
  ["--timeline-ai-changed", [["aiChanged"]]],
  ["--timeline-ai-changed-tag", [["aiChangedTag"]]],
];

type CssSource = Element | Pick<CSSStyleDeclaration, "getPropertyValue">;

/** Reads --timeline-* tokens. Pass the editor root (not document) to scope them. */
export function readThemeFromCss(source: CssSource): TimelineThemeOverrides {
  const styles = "getPropertyValue" in source ? source : getComputedStyle(source);
  const overrides: Record<string, unknown> = {};
  for (const [token, paths] of CSS_TOKENS) {
    const value = styles.getPropertyValue(token).trim();
    if (!value) continue;
    for (const path of paths) {
      let node = overrides;
      for (const key of path.slice(0, -1)) {
        node[key] = (node[key] as Record<string, unknown> | undefined) ?? {};
        node = node[key] as Record<string, unknown>;
      }
      node[path[path.length - 1]] = value;
    }
  }
  return overrides as TimelineThemeOverrides;
}

/** Source-compatible helper: defaults + tokens found on `element` (or <html>). */
export function applyTimelineThemeFromCSS(element?: HTMLElement): void {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return;
  applyTimelineTheme(resolveTimelineTheme(readThemeFromCss(element ?? document.documentElement)));
}

// Clip colors by track type
export function getClipColors(trackType: string) {
  switch (trackType) {
    case "video": return COLORS.video;
    case "text": return COLORS.text;
    case "sticker": return COLORS.sticker;
    case "audio": return COLORS.audio;
    case "effect": return COLORS.effect;
    case "remotion": return COLORS.remotion;
    default: return COLORS.video;
  }
}

// Ruler tick interval based on zoom level
export function getTickInterval(zoom: number): number {
  if (zoom >= 100) return 1;
  if (zoom >= 40) return 2;
  if (zoom >= 20) return 5;
  if (zoom >= 10) return 10;
  return 30;
}
