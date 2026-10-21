import { COLORS, DEFAULT_TIMELINE_THEME, applyTimelineTheme, readThemeFromCss, resolveTimelineTheme } from "./colors";
import { getCurrentRenderDevicePixelRatio, prepareRenderEnvironment } from "./timeline-renderer";

afterEach(() => {
  applyTimelineTheme(DEFAULT_TIMELINE_THEME);
  prepareRenderEnvironment({ devicePixelRatio: 1 });
});

describe("timeline theme injection", () => {
  it("defaults equal the code palette", () => {
    expect(resolveTimelineTheme()).toEqual(DEFAULT_TIMELINE_THEME);
    expect(DEFAULT_TIMELINE_THEME.playhead).toBe("rgba(255, 255, 255, 0.95)");
  });

  it("deep-merges overrides without mutating the defaults", () => {
    const theme = resolveTimelineTheme({ text: { fill: "red" }, playhead: "blue" });
    expect(theme.text.fill).toBe("red");
    expect(theme.text.border).toBe(DEFAULT_TIMELINE_THEME.text.border);
    expect(DEFAULT_TIMELINE_THEME.text.fill).toBe("rgba(251, 191, 36, 0.10)");
  });

  it("reads --timeline-* tokens from a style source", () => {
    const el = document.createElement("div");
    el.style.setProperty("--timeline-playhead", "orange");
    el.style.setProperty("--timeline-text-fill", "pink");
    expect(readThemeFromCss(el.style)).toEqual({ playhead: "orange", playheadAlpha: "orange", text: { fill: "pink" } });
  });

  it("reads the keyboard focus ring token (phase 10d)", () => {
    const el = document.createElement("div");
    el.style.setProperty("--timeline-focus-ring", "rgba(1, 2, 3, 0.4)");
    expect(readThemeFromCss(el.style)).toEqual({ focusRing: "rgba(1, 2, 3, 0.4)" });
  });

  it("renderer environment applies the theme and the injected pixel ratio", () => {
    prepareRenderEnvironment({ theme: resolveTimelineTheme({ snapLine: "lime" }), devicePixelRatio: 3 });
    expect(COLORS.snapLine).toBe("lime");
    expect(getCurrentRenderDevicePixelRatio()).toBe(3);
    prepareRenderEnvironment({});
    expect(getCurrentRenderDevicePixelRatio()).toBe(1);
  });
});
