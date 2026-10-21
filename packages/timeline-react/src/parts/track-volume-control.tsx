"use client";

// Hover volume fader for a timeline track's sound icon. Hovering opens a
// portaled popover (the label rail sits in an overflow-auto scroller, so an
// absolutely-positioned panel would be clipped); clicking still toggles mute.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { usePortalContainer } from "../hooks/use-timeline-media";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { Slider } from "../ui/slider";

const CLOSE_DELAY_MS = 150;

interface TrackVolumeControlProps {
    muted: boolean;
    volume: number;
    buttonClassName: string;
    activeButtonClassName: string;
    onToggleMute: () => void;
    /** Commits the track fader (0–1). Called on slider release, not per tick. */
    onSetVolume: (volume: number) => void;
}

function volumeIcon(muted: boolean, volume: number) {
    if (muted || volume <= 0) return <VolumeX className="h-3 w-3" />;
    if (volume < 0.5) return <Volume1 className="h-3 w-3" />;
    return <Volume2 className="h-3 w-3" />;
}

export function TrackVolumeControl({
    muted,
    volume,
    buttonClassName,
    activeButtonClassName,
    onToggleMute,
    onSetVolume,
}: TrackVolumeControlProps) {
    const t = useTimelineMessages("timeline");
    const portalContainer = usePortalContainer();
    const buttonRef = useRef<HTMLButtonElement>(null);
    const closeTimerRef = useRef<number | null>(null);
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
    // Local value while dragging; null = follow the committed prop.
    const [dragVolume, setDragVolume] = useState<number | null>(null);

    const cancelClose = useCallback(() => {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);

    const openPopover = useCallback(() => {
        cancelClose();
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect) {
            // w-44 popover is centered on the icon — clamp so the rail's
            // left-edge icons don't push it off the viewport.
            const half = 88 + 8;
            const x = Math.min(Math.max(rect.left + rect.width / 2, half), window.innerWidth - half);
            setAnchor({ x, y: rect.top });
        }
        setOpen(true);
    }, [cancelClose]);

    const scheduleClose = useCallback(() => {
        cancelClose();
        closeTimerRef.current = window.setTimeout(() => {
            setOpen(false);
            setDragVolume(null);
        }, CLOSE_DELAY_MS);
    }, [cancelClose]);

    useEffect(() => cancelClose, [cancelClose]);

    const shownVolume = dragVolume ?? volume;
    const shownPct = Math.round(Math.max(0, Math.min(1, shownVolume)) * 100);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-label={muted ? t("unmute") : t("mute")}
                onClick={onToggleMute}
                onMouseEnter={openPopover}
                onMouseLeave={scheduleClose}
                onFocus={openPopover}
                onBlur={scheduleClose}
                className={`${buttonClassName} ${muted ? activeButtonClassName : ""}`}
            >
                {volumeIcon(muted, shownVolume)}
            </button>

            {open && anchor && portalContainer && createPortal(
                <div
                    className="fixed z-[80] -translate-x-1/2 -translate-y-full pt-0 pb-1.5"
                    style={{ left: anchor.x, top: anchor.y }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                >
                    <div className="w-44 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#141416] px-3 py-2 shadow-xl">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-semibold text-[#A0A0A8]">{t("trackVolume")}</span>
                            <span className="text-[10px] tabular-nums text-white">{`${shownPct}%`}</span>
                        </div>
                        <Slider
                            min={0}
                            max={100}
                            step={1}
                            value={[shownPct]}
                            onValueChange={(value) => setDragVolume(value[0] / 100)}
                            onValueCommit={(value) => {
                                setDragVolume(null);
                                onSetVolume(value[0] / 100);
                            }}
                        />
                        <div className="mt-1 text-[9px] text-[#6B6B73]">{t("trackVolumeHint")}</div>
                    </div>
                </div>,
                portalContainer,
            )}
        </>
    );
}
