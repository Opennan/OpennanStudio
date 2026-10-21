"use client";

// Track label rail controls for timeline visibility, mute, and lock state.
import type { ReactNode } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import {
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Film,
  Music,
  Type,
  Image as ImageIcon,
  Wand2,
  Sparkles,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getTimelineTrackHeight } from "@opennan/timeline-core/timeline/nle-timeline-layout";
import { TrackVolumeControl } from "./track-volume-control";

interface TrackLabelProps {
  track: TimelineTrack;
  onToggleMute: () => void;
  onToggleLock: () => void;
  onToggleVisible: () => void;
  onSetVolume: (volume: number) => void;
}

const TRACK_ICONS: Record<string, typeof Film> = {
  video: Film,
  audio: Music,
  text: Type,
  sticker: ImageIcon,
  effect: Wand2,
  remotion: Sparkles,
};

const TRACK_COLORS: Record<string, string> = {
  video: "text-blue-400/70",
  audio: "text-emerald-400/70",
  text: "text-amber-400/70",
  sticker: "text-pink-400/70",
  effect: "text-purple-400/70",
  remotion: "text-cyan-400/70",
};

const TRACK_CONTROL_BUTTON_CLASS =
  "h-5 w-5 flex items-center justify-center rounded-md border border-transparent text-[#6B6B73] transition-colors hover:border-[rgba(255,255,255,0.12)] hover:bg-[rgba(255,255,255,0.08)] hover:text-white disabled:pointer-events-none disabled:opacity-30";

const TRACK_CONTROL_BUTTON_ACTIVE_CLASS =
  "border-[rgba(255,255,255,0.16)] bg-[rgba(255,255,255,0.1)] text-white";

function TrackControlButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex">
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={`${TRACK_CONTROL_BUTTON_CLASS} ${active ? TRACK_CONTROL_BUTTON_ACTIVE_CLASS : ""}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function TrackLabel({ track, onToggleMute, onToggleLock, onToggleVisible, onSetVolume }: TrackLabelProps) {
  const t = useTimelineMessages("timeline");
  const Icon = TRACK_ICONS[track.type] || Film;
  const color = TRACK_COLORS[track.type] || "text-[#6B6B73]";
  const isAudio = track.type === "audio";
  const isAudioBearing = isAudio || track.type === "video";
  const trackHeight = getTimelineTrackHeight(track.type);
  const isHidden = track.visible === false;

  return (
    <div
      className={`flex items-center gap-1 border-b border-[rgba(255,255,255,0.04)] group/label px-1.5 ${isHidden ? "bg-[rgba(255,255,255,0.025)]" : ""}`}
      style={{ height: trackHeight }}
    >
      {/* Track name + icon — left-aligned so every row starts in the same column */}
      <div className={`flex min-w-0 flex-1 items-center gap-1 ${isHidden ? "opacity-55" : ""}`}>
        <Icon className={`h-3 w-3 shrink-0 ${color}`} />
        <span className="truncate text-[9px] text-[#6B6B73] font-semibold">{track.label}</span>
      </div>

      <TooltipProvider delay={300}>
        {/* Controls — fixed slots (eye / sound / lock) so the same control
            lands in the same column on every track type; missing controls
            keep an empty spacer instead of shifting siblings. */}
        {/* Always fully visible — a faded rail made toggled states (hidden /
            muted / locked) unreadable and clicks feel like they did nothing. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Every track type gets the eye — audio "hidden" excludes its
              clips from preview/export just like visual lanes. */}
          <TrackControlButton label={track.visible ? t("hideTrack") : t("showTrack")} onClick={onToggleVisible} active={isHidden}>
            {track.visible ? (
              <Eye className="h-3 w-3" />
            ) : (
              <EyeOff className="h-3 w-3" />
            )}
          </TrackControlButton>

          {isAudioBearing ? (
            <TrackVolumeControl
              muted={track.muted}
              volume={track.volume ?? 1}
              buttonClassName={TRACK_CONTROL_BUTTON_CLASS}
              activeButtonClassName={TRACK_CONTROL_BUTTON_ACTIVE_CLASS}
              onToggleMute={onToggleMute}
              onSetVolume={onSetVolume}
            />
          ) : (
            <span aria-hidden="true" className="h-5 w-5" />
          )}

          <TrackControlButton label={track.locked ? t("unlockTrack") : t("lockTrack")} onClick={onToggleLock} active={track.locked}>
            {track.locked ? (
              <Lock className="h-3 w-3" />
            ) : (
              <Unlock className="h-3 w-3" />
            )}
          </TrackControlButton>
        </div>
      </TooltipProvider>
    </div>
  );
}
