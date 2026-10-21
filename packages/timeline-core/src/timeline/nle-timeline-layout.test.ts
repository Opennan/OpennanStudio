// Unit coverage for the compact, CapCut-style timeline toolbar contracts.
import { describe, expect, it } from "vitest";
import {
  getTimelineTrackHeight,
  getTimelineTrackSortWeight,
  TIMELINE_TRACK_HEIGHT_COMPACT,
  TIMELINE_TRACK_HEIGHT_VIDEO,
  TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS,
  TIMELINE_TOOLBAR_ADD_BUTTON_CLASS,
  TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS,
  TIMELINE_TOOLBAR_BUTTON_CLASS,
  TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS,
  TIMELINE_CONTEXT_MENU_CLASS,
  TIMELINE_CONTEXT_MENU_DANGER_ITEM_CLASS,
  TIMELINE_CONTEXT_MENU_ITEM_CLASS,
  TIMELINE_CONTEXT_MENU_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS,
  TIMELINE_TOOLBAR_ICON_CLASS,
  TIMELINE_TOOLBAR_LEFT_RAIL_CLASS,
  TIMELINE_TOOLBAR_MENU_LABEL_CLASS,
  TIMELINE_TOOLBAR_MENU_ITEM_CLASS,
  TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_RIGHT_RAIL_CLASS,
  TIMELINE_TOOLBAR_ROW_CLASS,
  TIMELINE_TOOLBAR_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS,
} from "./nle-timeline-layout";

describe("timeline toolbar layout", () => {
  it("keeps the toolbar scroll behavior stable", () => {
    expect(TIMELINE_TOOLBAR_ROW_CLASS).toContain("min-w-0");
    expect(TIMELINE_TOOLBAR_LEFT_RAIL_CLASS).toContain("min-w-0");
    expect(TIMELINE_TOOLBAR_LEFT_RAIL_CLASS).toContain("overflow-x-auto");
    expect(TIMELINE_TOOLBAR_LEFT_RAIL_CLASS).toContain("flex-nowrap");
    expect(TIMELINE_TOOLBAR_RIGHT_RAIL_CLASS).toContain("shrink-0");
  });

  it("keeps dense edit commands in a compact advanced menu", () => {
    expect(TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS).toContain("w-[340px]");
    expect(TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS).toContain("max-h-[min(72vh,720px)]");
    expect(TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS).toContain("bg-[#2B2B2D]");
    expect(TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS).toContain("rounded-lg");
    expect(TIMELINE_TOOLBAR_MENU_ITEM_CLASS).toContain("justify-between");
    expect(TIMELINE_TOOLBAR_MENU_ITEM_CLASS).toContain("h-7");
    expect(TIMELINE_TOOLBAR_MENU_ITEM_CLASS).toContain("text-[12px]");
    expect(TIMELINE_TOOLBAR_MENU_ITEM_CLASS).toContain("data-disabled:text-[#77777D]");
    expect(TIMELINE_TOOLBAR_MENU_LABEL_CLASS).toContain("text-[#A8A8AD]");
    expect(TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS).toContain("bg-[rgba(255,255,255,0.08)]");
    expect(TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS).not.toContain("shadow-");
    expect(TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS).not.toContain("sticky");
    expect(TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS).not.toContain("shadow-");
    expect(TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS).not.toContain("sticky");
    expect(TIMELINE_TOOLBAR_SEPARATOR_CLASS).toContain("w-px");
  });

});
