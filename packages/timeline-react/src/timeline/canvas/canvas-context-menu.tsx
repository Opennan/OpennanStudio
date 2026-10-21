// Context menu helpers and row primitives for the canvas timeline.
import type { CSSProperties, ReactNode } from "react";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { HitResult } from "@opennan/timeline-core/timeline/canvas/types";
import { isTextTimelineClip } from "@opennan/timeline-core/timeline/canvas/canvas-timeline-utils";

export const CTX_MENU_SHELL_CLASS =
  "fixed z-[100] min-w-[256px] rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#2B2B2D] py-1 text-[#EFEFF1] shadow-[0_18px_44px_rgba(0,0,0,0.45)] scrollbar-thin";
export const CTX_MENU_ITEM_CLASS =
  "group flex h-7 w-full items-center justify-between gap-3 px-3 text-left text-[12px] leading-none text-[#EFEFF1] transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:cursor-default disabled:text-[#77777D] disabled:hover:bg-transparent";
export const CTX_MENU_DESTRUCTIVE_ITEM_CLASS =
  "hover:bg-[rgba(255,255,255,0.08)]";
export const CTX_MENU_SHORTCUT_CLASS =
  "ml-4 flex shrink-0 items-center gap-1 text-[12px] leading-none text-[#F2F2F4] group-disabled:text-[#77777D]";
export const CTX_MENU_SUBMENU_CLASS =
  "ml-4 shrink-0 text-[16px] leading-none text-[#F2F2F4] group-disabled:text-[#77777D]";

export function getContextMenuStyle(
  x: number,
  y: number,
  width: number,
  maxHeight: number,
): CSSProperties {
  // overscrollBehavior contain: wheel at the menu's scroll edge must not
  // chain into the timeline scroller underneath.
  if (typeof window === "undefined") {
    return { left: x, top: y, width, maxHeight, overflowY: "auto", overscrollBehavior: "contain" };
  }

  const margin = 8;
  return {
    left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - maxHeight - margin)),
    width,
    maxHeight: Math.min(maxHeight, window.innerHeight - margin * 2),
    overflowY: "auto",
    overscrollBehavior: "contain",
  };
}

export function getEmptyTrackContextMenuHeight(
  trackType: string | null,
  addSceneSub: "root" | "video-url" | "image-url" | null,
): number {
  if (trackType === "video") {
    return addSceneSub === "root" ? 360 : 112;
  }

  return 136;
}

export function getContextMenuEstimatedHeight(
  hitType: HitResult["type"],
  trackType: string | null,
  addSceneSub: "root" | "video-url" | "image-url" | null,
  clip?: TimelineClip | null,
  canPaste = false,
): number {
  if (hitType === "track-empty") {
    return getEmptyTrackContextMenuHeight(trackType, addSceneSub);
  }

  // Scenes and media clips carry the AI group (phase 11): a label and up to ten rows.
  if (hitType === "scene") return 700;
  if (hitType === "voiceover" || hitType === "voiceover-lock") return 112;
  if (hitType === "transition") return 60;
  if (hitType === "marker") return 44;
  // Ruler menu is the single "Add marker here" row — the 720 fallback made
  // the position clamp fling the menu into the middle of the screen.
  if (hitType === "ruler") return 44;
  // Music menu is 4 fixed rows (~176px); the clipboard paste block adds a
  // separator + 3 rows, so reserve room for it or the menu renders cramped.
  if (hitType === "music") return canPaste ? 332 : 176;
  if (hitType === "clip" && isTextTimelineClip(clip)) return 460;
  // Video clips carry the full menu (clipboard + attributes + split + edit +
  // speed + audio + transform + delete) — underestimating clips the menu into an
  // internal scrollbar.
  if (hitType === "clip" && clip?.trackType === "video") return 1096;
  if (hitType === "clip" && clip?.trackType === "audio") return 700;
  if (hitType === "clip" && clip) return 456;

  return 720;
}

export function CtxItem({
  icon,
  label,
  onClick,
  destructive,
  disabled,
  shortcut,
  submenu,
  hint,
  reason,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
  submenu?: boolean;
  /** Muted text on the right (phase 11: an AI row's price, "≈ $0.05"). */
  hint?: string;
  /** Why the row is disabled: the tooltip and the accessible description. */
  reason?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={reason}
      aria-description={reason}
      data-testid={testId}
      className={`${CTX_MENU_ITEM_CLASS} ${destructive ? CTX_MENU_DESTRUCTIVE_ITEM_CLASS : ""}`}
      onClick={onClick}
    >
      <span aria-hidden="true" className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5 text-[#CFCFD3] group-disabled:text-[#77777D]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && !shortcut && (
        <span className="ml-4 shrink-0 truncate text-[11px] leading-none text-[var(--on-muted-foreground)]">{hint}</span>
      )}
      {shortcut && (
        <span className={CTX_MENU_SHORTCUT_CLASS}>{shortcut}</span>
      )}
      {submenu && !shortcut && (
        <span className={CTX_MENU_SUBMENU_CLASS}>›</span>
      )}
    </button>
  );
}

/** A small heading over a group of rows (phase 11: "AI"). */
export function CtxGroupLabel({ label }: { label: string }) {
  return (
    <div role="presentation" className="px-3 pb-1 pt-1.5 text-[11px] font-medium leading-none text-[var(--on-muted-foreground)]">{label}</div>
  );
}

// Compact monochrome menu row. `iconTint` is accepted for older callers but
// intentionally ignored so every row uses the same neutral foreground.
export function RichCtxItem({
  title,
  icon,
  onClick,
  shortcut,
  disabled,
}: {
  title: string;
  icon: ReactNode;
  iconTint?: string;
  onClick: () => void;
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`${CTX_MENU_ITEM_CLASS} h-8 px-3 disabled:opacity-100`}
      onClick={onClick}
    >
      <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5 text-[#CFCFD3] group-disabled:text-[#77777D]">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{title}</span>
      {shortcut && (
        <span className={CTX_MENU_SHORTCUT_CLASS}>{shortcut}</span>
      )}
    </button>
  );
}

export function CtxSeparator() {
  return <div className="my-1 border-t border-[rgba(255,255,255,0.08)]" />;
}
