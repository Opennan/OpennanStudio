// Layout class contracts for the NLE timeline toolbar.
export const TIMELINE_TOOLBAR_ROW_CLASS =
  "flex min-w-0 items-center justify-between px-2 py-1 border-b border-[rgba(255,255,255,0.06)] shrink-0 gap-2";

export const TIMELINE_TOOLBAR_LEFT_RAIL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden flex-nowrap scrollbar-thin";

export const TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS =
  "inline-flex shrink-0 items-center gap-1";

export const TIMELINE_TOOLBAR_BUTTON_CLASS =
  "h-7 w-7 shrink-0 rounded-md border border-transparent p-0 text-[#A9A9B2] ring-1 ring-transparent transition-colors hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.08)] hover:text-white hover:ring-[rgba(255,255,255,0.08)] disabled:opacity-35";

export const TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS =
  "border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.12)] text-white ring-[rgba(255,255,255,0.12)]";

export const TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS =
  "hover:border-[rgba(255,115,115,0.28)] hover:bg-[rgba(255,90,90,0.1)] hover:text-red-200";

export const TIMELINE_TOOLBAR_ADD_BUTTON_CLASS =
  `${TIMELINE_TOOLBAR_BUTTON_CLASS} inline-flex w-auto items-center justify-center gap-1.5 whitespace-nowrap px-2 text-xs text-[#E8E8EA]`;

export const TIMELINE_TOOLBAR_ICON_CLASS =
  "h-4 w-4";

export const TIMELINE_TOOLBAR_SEPARATOR_CLASS =
  "mx-1 h-5 w-px shrink-0 bg-[rgba(255,255,255,0.09)]";

export const TIMELINE_TOOLBAR_RIGHT_RAIL_CLASS =
  "flex shrink-0 items-center gap-2";

export const TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS =
  "w-[340px] max-h-[min(72vh,720px)] overflow-y-auto rounded-lg border-[rgba(255,255,255,0.1)] bg-[#2B2B2D] p-1 text-[#EFEFF1] shadow-[0_18px_44px_rgba(0,0,0,0.45)]";

export const TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS =
  "inline-flex h-7 w-8 shrink-0 items-center justify-end";

export const TIMELINE_TOOLBAR_MENU_ITEM_CLASS =
  "h-7 justify-between gap-3 overflow-hidden whitespace-nowrap rounded-none px-3 py-0 text-[12px] leading-none text-[#EFEFF1] focus:bg-[rgba(255,255,255,0.08)] focus:text-white data-disabled:opacity-100 data-disabled:text-[#77777D] [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:overflow-hidden [&>span:first-child]:whitespace-nowrap [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-[#CFCFD3]";

export const TIMELINE_TOOLBAR_MENU_LABEL_CLASS =
  "px-3 py-1 text-[10px] uppercase tracking-wide text-[#A8A8AD]";

export const TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS =
  "mx-0 my-1 h-px bg-[rgba(255,255,255,0.08)]";

export const TIMELINE_CONTEXT_MENU_CLASS =
  "fixed z-[1000] w-56 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#2B2B2D] p-1 text-[#EFEFF1] shadow-[0_18px_44px_rgba(0,0,0,0.45)]";

export const TIMELINE_CONTEXT_MENU_ITEM_CLASS =
  "group flex h-7 w-full items-center justify-between gap-3 rounded-none px-3 text-left text-[12px] leading-none text-[#EFEFF1] transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:cursor-default disabled:text-[#77777D] disabled:hover:bg-transparent";

export const TIMELINE_CONTEXT_MENU_DANGER_ITEM_CLASS =
  "text-red-300 hover:text-red-200";

export const TIMELINE_CONTEXT_MENU_SEPARATOR_CLASS =
  "mx-0 my-1 h-px bg-[rgba(255,255,255,0.08)]";

export const TIMELINE_TRACK_HEIGHT_VIDEO = 64;
export const TIMELINE_TRACK_HEIGHT_COMPACT = 40;

const TIMELINE_TRACK_TYPE_ORDER: Record<string, number> = {
  text: 0,
  sticker: 1,
  remotion: 2,
  effect: 3,
  video: 4,
  audio: 5,
};

export function getTimelineTrackSortWeight(trackType: string): number {
  return TIMELINE_TRACK_TYPE_ORDER[trackType] ?? 99;
}

export function getTimelineTrackHeight(trackType: string): number {
  return trackType === "video" ? TIMELINE_TRACK_HEIGHT_VIDEO : TIMELINE_TRACK_HEIGHT_COMPACT;
}
