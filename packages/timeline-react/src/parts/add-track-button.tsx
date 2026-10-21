"use client";
// Timeline add-track menu, including the project-level background music entry.

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { usePortalContainer } from "../hooks/use-timeline-media";
import { Plus, Film, Music, Type, Image as ImageIcon, Wand2, Sparkles, Disc3 } from "lucide-react";

type TimelineAddTrackType = "video" | "audio" | "text" | "sticker" | "effect" | "remotion";

interface AddTrackButtonProps {
  onAddTrack: (type: TimelineAddTrackType) => void;
  /** Open the project's Background Music layer (with AI generate). Separate from
   *  the per-clip "audio" track; music is a single project-level bed. */
  onSelectMusic?: () => void;
}

const TRACK_OPTIONS = [
  { type: "video" as const, labelKey: "videoTrack" as const, icon: Film, color: "text-blue-400" },
  { type: "audio" as const, labelKey: "audioTrack" as const, icon: Music, color: "text-emerald-400" },
  { type: "text" as const, labelKey: "textTrack" as const, icon: Type, color: "text-amber-400" },
  { type: "sticker" as const, labelKey: "stickerTrack" as const, icon: ImageIcon, color: "text-pink-400" },
  { type: "effect" as const, labelKey: "effectTrack" as const, icon: Wand2, color: "text-purple-400" },
  { type: "remotion" as const, labelKey: "graphicsTrack" as const, icon: Sparkles, color: "text-cyan-400" },
];

export function AddTrackButton({ onAddTrack, onSelectMusic }: AddTrackButtonProps) {
  const t = useTimelineMessages("addTrack");
  const portalContainer = usePortalContainer();
  const [open, setOpen] = useState(false);
  // Menu coordinates in viewport space. The button lives inside the timeline's
  // overflow-clipped scroll container, so an absolutely-positioned menu gets
  // cut off — render it in a body portal at fixed coordinates instead.
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 168)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("title")}
        className="h-8 w-full flex items-center justify-center gap-1 text-[9px] text-[#6B6B73] hover:text-[#A0A0A8] hover:bg-[rgba(255,255,255,0.04)] transition-colors"
        title={t("title")}
      >
        <Plus className="h-3 w-3" />
      </button>

      {/* Body portal: the timeline scroll container clips absolutely-positioned
          descendants, so the menu must escape it entirely. Anchored above the
          button (it sits at the bottom of the timeline). */}
      {open && menuPos && portalContainer && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", left: menuPos.left, bottom: menuPos.bottom }}
          className="w-40 bg-[#1A1A1D] border border-[rgba(255,255,255,0.08)] rounded-md shadow-lg z-[200] py-1"
        >
          {TRACK_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              role="menuitem"
              onClick={() => {
                onAddTrack(opt.type);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-[#A0A0A8] hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
            >
              <opt.icon className={`h-3.5 w-3.5 ${opt.color}`} />
              {t(opt.labelKey)}
            </button>
          ))}
          {/* Background music is a single project-level layer (not a stackable
              track), so it gets its own entry that opens Music Properties. */}
          {onSelectMusic && (
            <>
              <div className="my-1 h-px bg-[rgba(255,255,255,0.06)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelectMusic();
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-[#A0A0A8] hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
              >
                <Disc3 className="h-3.5 w-3.5 text-sky-400" />
                {t("musicTrack")}
              </button>
            </>
          )}
        </div>,
        portalContainer,
      )}
    </div>
  );
}
