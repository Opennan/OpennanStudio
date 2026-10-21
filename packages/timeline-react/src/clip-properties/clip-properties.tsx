"use client";
// Clip inspector for the selected timeline item. Organised as a flat, collapsible
// property inspector (header + per-type sections) rather than a stack of nested
// cards. Every control here maps to a TimelineClip field that is honoured by the
// preview renderer and/or the ffmpeg export pipeline. Adjustments that only land
// in the final render carry an "on export" tag so the missing live feedback reads
// as intentional, not broken.

import { useState, useEffect, useRef } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import type { MessageKey } from "../i18n/format";
import type { ChangeEvent, CSSProperties, ImgHTMLAttributes, ReactNode, VideoHTMLAttributes } from "react";
import {
  Film, Music, Type, Image as ImageIcon, Trash2, Upload, Link, Smile,
  Clock3, Move, Volume2, Palette, Wand2, Loader2,
  ChevronDown, ChevronUp, Plus, RotateCcw, Gauge, SlidersHorizontal, Sparkles, FlipHorizontal2,
  FlipVertical2, AlignLeft, AlignCenter, AlignRight, AudioLines, FastForward,
  Mic2, SplitSquareHorizontal, UserRound, ScanSearch, RefreshCw, Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { useTimelineUpload } from "../hooks/use-timeline-upload";
import { useEffectCatalog } from "../hooks/use-effect-catalog";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { EffectParamPanel, parseParams, type ParamValue } from "./effect-param-panel";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { toColorInputValue } from "@opennan/timeline-core/lib/color-input";
import { speedRampRequest } from "@opennan/timeline-core/lib/timeline-editing-navigation";
import { parseSpeedCurve } from "@opennan/timeline-core/motion/speed";
import { mergeAiReferenceUrls } from "@opennan/timeline-core/lib/ai-reference-urls";
import { StickerPicker } from "../parts/sticker-picker";
import { templateById } from "../remotion/templates";
import { buildRemotionParamControls } from "./clip-properties-remotion";
import type { ObjectArrayColumn, RemotionParamControl } from "./clip-properties-remotion";
import type { AudioAiResult, TimelineClip } from "@opennan/timeline-core/model/timeline";
import { getTimelineAnimationKeyframes, TIMELINE_ANIMATION_PRESETS } from "@opennan/timeline-core/lib/timeline-animation-presets";
import type { TimelineAnimationEdge, TimelineAnimationPreset } from "@opennan/timeline-core/lib/timeline-animation-presets";
import { useTimelineToast } from "../hooks/use-timeline-toast";
import { TextStylePanel } from "../editing/inspector/text-style-panel";

interface ClipPropertiesProps {
  clip: TimelineClip;
  // Returns a Promise from use-timeline.ts so callers can await persistence
  // before chaining a paid action that reads the same row server-side.
  onUpdateClip: (clipId: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
  onDeleteClip: (clipId: string) => void;
  /** Run AI media generation for an AI video/image clip. */
  onGenerateAiClip?: (clipId: string) => Promise<TimelineClip | null>; // i18n-ignore
  /** Run AI audio processing for a selected audio/video clip. */
  onProcessAudioClip?: (
    clipId: string,
    operation: string,
    options?: { voiceId?: string | null; characterId?: string | null },
  ) => Promise<AudioAiResult | null>; // i18n-ignore
  /** Ask the AI to regenerate a custom graphics clip from a change request. */
  onEditRemotionClip?: (clipId: string, changeRequest: string) => Promise<TimelineClip | null>; // i18n-ignore
  /** Number of total selected clips (for multi-select summary) */
  selectedCount?: number;
  /** Delete all selected clips */
  onDeleteSelected?: () => void;
  /** Model ids for the AI output-mode switch; supplied by the host or provider. */
  aiModels?: { video: string; image: string };
}

/* ---------------------------------------------------------------------------
   Shared tokens. Greys are lifted from the old #6B/#55 ramp so labels and
   readouts clear ~4.5:1 against the #0a0c0f panel base.
--------------------------------------------------------------------------- */
const C = {
  title: "text-[#ECECEE]",
  body: "text-[#C8C8CE]",
  label: "text-[#9A9AA3]",
  faint: "text-[#7E7E87]",
  divider: "border-[rgba(255,255,255,0.07)]",
};
const inputClass =
  "w-full px-2.5 py-1.5 text-[11px] bg-black/25 border border-[rgba(255,255,255,0.1)] rounded-md text-[#E8E8EA] placeholder-[#6E6E77] focus:outline-none focus:border-white/50 focus:ring-1 focus:ring-[var(--on-ring)] transition-colors";
const selectClass =
  "w-full px-2 py-1.5 text-[11px] bg-black/25 border border-[rgba(255,255,255,0.1)] rounded-md text-[#E8E8EA] focus:outline-none focus:border-white/50 transition-colors";
const textPanelShell = "rounded-md border border-[rgba(255,255,255,0.08)] bg-[#101012]";

const fmtNum = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};

/* ---------------------------------------------------------------------------
   Primitives
--------------------------------------------------------------------------- */

function CollapsibleSection({
  icon: Icon,
  title,
  defaultOpen = false,
  exportOnly = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  defaultOpen?: boolean;
  exportOnly?: boolean;
  children: ReactNode;
}) {
  const t = useTimelineMessages("clipProperties");
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`${textPanelShell} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex h-9 w-full items-center gap-2 border-b border-[rgba(255,255,255,0.06)] px-3 text-left"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#8C8C96] group-hover:text-[#C8C8CE] transition-colors" />
        <span className={`flex-1 truncate text-[11px] font-medium ${C.title}`}>{title}</span>
        {exportOnly && (
          <span
            title={t("exportOnlyHint")}
            className="rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wide text-[#8C8C96]"
          >
            {t("onExport")}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#6B6B73] transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {/* grid-rows 0fr→1fr gives a height transition without measuring the DOM */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        } motion-reduce:transition-none`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 p-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

// Inline "on export" badge for individual controls that have no live preview
// feedback (the section header badge is for whole sections that are export-only).
function ExportOnlyTag() {
  const t = useTimelineMessages("clipProperties");
  return (
    <span
      title={t("exportOnlyHint")}
      className="rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wide text-[#8C8C96]"
    >
      {t("onExport")}
    </span>
  );
}

function FieldLabel({ children, value, onReset }: { children: ReactNode; value?: ReactNode; onReset?: () => void }) {
  const t = useTimelineMessages("clipProperties");
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <label className={`text-[10px] font-medium uppercase tracking-wider ${C.label}`}>{children}</label>
      <div className="flex items-center gap-1.5">
        {value != null && <span className={`text-[10px] tabular-nums ${C.body}`}>{value}</span>}
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            title={t("reset")}
            aria-label={t("reset")}
            className="text-[#6B6B73] hover:text-[#C8C8CE] transition-colors"
          >
            <RotateCcw className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  formatDisplay,
  defaultValue,
  onChange,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  formatDisplay?: (v: number) => string;
  defaultValue?: number;
  onChange: (value: number) => void;
}) {
  // Local drag state keeps the thumb responsive without firing onChange (a
  // store/server mutation) on every tick. Commit on release.
  const [drag, setDrag] = useState<number | null>(null);
  const live = drag ?? value;
  const liveDisplay = drag != null && formatDisplay ? formatDisplay(drag) : display;
  const showReset = defaultValue != null && Math.abs(value - defaultValue) > 1e-6;
  return (
    <div>
      <FieldLabel value={liveDisplay} onReset={showReset ? () => onChange(defaultValue!) : undefined}>
        {label}
      </FieldLabel>
      <Slider
        value={[live]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => setDrag(v)}
        onValueCommit={([v]) => {
          setDrag(null);
          if (v !== value) onChange(v);
        }}
      />
    </div>
  );
}

function TextInspectorSection({
  title,
  checked,
  onCheckedChange,
  onReset,
  children,
  defaultOpen = true,
}: {
  title: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onReset: () => void;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const t = useTimelineMessages("clipProperties");
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`${textPanelShell} overflow-hidden`}>
      <div className="flex items-center gap-2 border-b border-[rgba(255,255,255,0.06)] px-3 py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheckedChange(event.target.checked)}
          aria-label={title}
          className="h-3 w-3 shrink-0 accent-white"
        />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <span className={`truncate text-[11px] font-medium ${C.title}`}>{title}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 text-[#7E7E87] transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
        </button>
        <button
          type="button"
          onClick={onReset}
          title={t("reset")}
          aria-label={t("reset")}
          className="rounded p-1 text-[#8C8C96] transition-colors hover:bg-white/[0.06] hover:text-[#E8E8EA]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        } motion-reduce:transition-none`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 p-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function TextCardSection({
  icon: Icon,
  title,
  children,
  defaultOpen = true,
  exportOnly = false,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  exportOnly?: boolean;
}) {
  const t = useTimelineMessages("clipProperties");
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`${textPanelShell} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 border-b border-[rgba(255,255,255,0.06)] px-3 py-2 text-left"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#8F8F99] group-hover:text-[#C8C8CE]" />
        <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${C.title}`}>{title}</span>
        {exportOnly && (
          <span
            title={t("exportOnlyHint")}
            className="rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wide text-[#8C8C96]"
          >
            {t("onExport")}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#6B6B73] transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        } motion-reduce:transition-none`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 p-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function SliderNumberRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const live = drag ?? value;
  const commit = (rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const clamped = Math.max(min, Math.min(max, rawValue));
    onChange(Math.round(clamped / step) * step);
  };
  return (
    <div className={disabled ? "opacity-45" : undefined}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className={`text-[10px] font-medium ${C.body}`}>{label}</label>
        <div className="relative">
          <input
            type="number"
            value={Math.round(live)}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(event) => commit(Number(event.target.value))}
            className={`h-6 w-[70px] rounded-md border border-transparent bg-[#141416] px-2 text-right text-[11px] tabular-nums text-[#F1F1F3] outline-none transition-colors focus:border-white/50 ${suffix ? "pr-5" : ""}`}
          />
          {suffix && (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#A0A0A8]">
              {suffix}
            </span>
          )}
        </div>
      </div>
      <Slider
        value={[live]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([nextValue]) => setDrag(nextValue)}
        onValueCommit={([nextValue]) => {
          setDrag(null);
          if (nextValue !== value) onChange(nextValue);
        }}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(fmtNum(value));
  useEffect(() => {
    const frame = requestAnimationFrame(() => setText(fmtNum(value)));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  const commit = () => {
    let n = parseFloat(text);
    if (Number.isNaN(n)) n = value;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    n = Math.round(n * 1000) / 1000;
    setText(fmtNum(n));
    if (n !== value) onCommit(n);
  };
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={`${inputClass} ${suffix ? "pr-7" : ""} tabular-nums`}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[#6E6E77]">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label?: string; icon?: LucideIcon; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-[rgba(255,255,255,0.07)] bg-black/25 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        const OptIcon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            title={o.title || o.label}
            aria-label={o.title || o.label || o.value}
            aria-pressed={active}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1.5 text-[10px] font-medium transition-colors ${
              active ? "bg-white/10 text-[#F1F1F3]" : "text-[#8C8C96] hover:bg-white/[0.04] hover:text-[#C8C8CE]"
            }`}
          >
            {OptIcon && <OptIcon className="h-3 w-3" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  icon: Icon,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className="flex w-full items-center justify-between rounded-md px-0.5 py-1 text-left"
    >
      <span className={`flex items-center gap-2 text-[11px] ${C.body}`}>
        {Icon && <Icon className="h-3.5 w-3.5 text-[#8C8C96]" />}
        {label}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? "bg-white/80" : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function ColorField({
  label,
  value,
  fallback = "#000000",
  disabled = false,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  fallback?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onClear?: () => void;
}) {
  const t = useTimelineMessages("clipProperties");
  return (
    <div className={disabled ? "opacity-45" : undefined}>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={toColorInputValue(value, fallback)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-[rgba(255,255,255,0.12)] bg-transparent"
        />
        {value ? (
          <>
            <span className="font-mono text-[10px] text-[#A0A0A8]">{value}</span>
            {onClear && (
              <button
                type="button"
                disabled={disabled}
                onClick={onClear}
                className="ml-auto text-[9px] text-red-400/70 hover:text-red-400"
              >
                {t("clear")}
              </button>
            )}
          </>
        ) : (
          <span className="text-[10px] text-[#6E6E77]">{t("none")}</span>
        )}
      </div>
    </div>
  );
}

function cropPercent(value: number): number {
  const percent = Number.isFinite(value) ? value * 100 : 0;
  return Math.max(0, Math.min(95, percent));
}

function VisibilityGuardedVideo({
  src,
  ...props
}: {
  src: string;
} & Omit<VideoHTMLAttributes<HTMLVideoElement>, "src">) {
  const media = useTimelineMedia();
  const docVisible = useDocumentVisible();
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewSrc = docVisible ? media.resolveMediaUrl(src) : undefined;

  useEffect(() => {
    if (docVisible) return;
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }, [docVisible, src]);

  return <video ref={videoRef} src={previewSrc} {...props} />;
}

function VisibilityGuardedImage({
  src,
  ...props
}: {
  src: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const media = useTimelineMedia();
  const docVisible = useDocumentVisible();
  const previewSrc = docVisible ? media.resolveMediaUrl(src) : undefined;

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={previewSrc} {...props} />;
}

function CropPreview({ clip }: { clip: TimelineClip }) {
  const t = useTimelineMessages("clipProperties");
  const left = cropPercent(clip.cropLeft);
  const right = cropPercent(clip.cropRight);
  const top = cropPercent(clip.cropTop);
  const bottom = cropPercent(clip.cropBottom);
  const visibleWidth = Math.max(0, 100 - left - right);
  const visibleHeight = Math.max(0, 100 - top - bottom);
  const hasCrop = left + right + top + bottom > 0.5;
  const display = `${Math.round(visibleWidth)} x ${Math.round(visibleHeight)}%`;

  return (
    <div aria-label={t("cropPreviewLabel")} className="rounded-md border border-white/[0.06] bg-black/25 p-2">
      <div className="relative aspect-video overflow-hidden rounded-[3px] border border-[rgba(255,255,255,0.09)] bg-[#07080B]">
        {clip.mediaUrl ? (
          <VisibilityGuardedVideo
            src={clip.mediaUrl}
            className="absolute inset-0 h-full w-full object-cover opacity-90"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(56,189,248,0.16),rgba(244,114,182,0.08)_45%,rgba(16,185,129,0.12))]" />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:33.333%_33.333%]" />
        <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: `${left}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/65" style={{ width: `${right}%` }} />
        <div className="absolute inset-x-0 top-0 bg-black/65" style={{ height: `${top}%` }} />
        <div className="absolute inset-x-0 bottom-0 bg-black/65" style={{ height: `${bottom}%` }} />
        <div
          className={`absolute overflow-hidden rounded-[2px] border shadow-[0_0_0_1px_rgba(0,0,0,0.7)] ${
            hasCrop ? "border-white/60 bg-white/10" : "border-white/65 bg-white/[0.03]"
          }`}
          style={{ left: `${left}%`, top: `${top}%`, width: `${visibleWidth}%`, height: `${visibleHeight}%` }}
        >
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
        <span className={C.label}>{t("cropVisibleArea")}</span>
        <span className={`shrink-0 tabular-nums ${hasCrop ? "text-white" : "text-[#8C8C96]"}`}>
          {display}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Sticker source field (image / emoji / url)
--------------------------------------------------------------------------- */

function StickerImageField({ clip, onUpdateClip }: { clip: TimelineClip; onUpdateClip: (id: string, updates: Record<string, any>) => void }) {
  const t = useTimelineMessages("clipProperties");
  const { upload, uploading, reset } = useTimelineUpload();
  const docVisible = useDocumentVisible();
  const docVisibleRef = useRef(docVisible);
  const fileRef = useRef<HTMLInputElement>(null);
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState(clip.mediaUrl || "");
  const [showPicker, setShowPicker] = useState(false);

  const isEmojiSticker = !clip.mediaUrl && !!clip.textContent;

  useEffect(() => {
    docVisibleRef.current = docVisible;
    if (!docVisible) reset();
    return () => reset();
  }, [docVisible, reset]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setUrlInput(clip.mediaUrl || "");
      setShowPicker(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [clip.id, clip.mediaUrl]);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !docVisibleRef.current) return;
    e.target.value = "";
    try {
      const url = await upload(file);
      if (!docVisibleRef.current) return;
      onUpdateClip(clip.id, { mediaUrl: url, textContent: null });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if ((err as { message?: string })?.message === "Upload aborted") return;
    }
  };

  return (
    <div className="space-y-2">
      {/* Current preview */}
      {isEmojiSticker && (
        <div className="flex items-center gap-2 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] p-2">
          <span className="text-4xl leading-none">{clip.textContent}</span>
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className="ml-auto flex items-center gap-1 text-[10px] text-[#A0A0A8] hover:text-pink-400"
          >
            <Smile className="h-3 w-3" />
            {t("change")}
          </button>
        </div>
      )}
      {clip.mediaUrl && (
        <div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)]">
          <VisibilityGuardedImage src={clip.mediaUrl} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}

      {showPicker && (
        <div className="h-56 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#141416]">
          <StickerPicker onSelect={(url, emoji) => {
            onUpdateClip(clip.id, { mediaUrl: url || null, textContent: url ? null : emoji });
            setShowPicker(false);
          }} />
        </div>
      )}

      <div className="flex gap-1.5">
        {!isEmojiSticker && (
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className={`flex flex-1 items-center justify-center gap-1 rounded border py-1.5 text-[10px] transition-colors ${showPicker ? "border-pink-500/40 bg-pink-500/20 text-pink-400" : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[#A0A0A8] hover:bg-[rgba(255,255,255,0.08)]"}`}
          >
            <Smile className="h-2.5 w-2.5" />
            {t("emoji")}
          </button>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] py-1.5 text-[10px] text-[#A0A0A8] transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:opacity-50"
        >
          <Upload className="h-2.5 w-2.5" />
          {uploading ? t("uploading") : t("uploadImage")}
        </button>
        <button
          type="button"
          onClick={() => { setUrlMode((v) => !v); setShowPicker(false); }}
          className={`flex flex-1 items-center justify-center gap-1 rounded border py-1.5 text-[10px] transition-colors ${urlMode ? "border-white/40 bg-white/20 text-white" : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[#A0A0A8] hover:bg-[rgba(255,255,255,0.08)]"}`}
        >
          <Link className="h-2.5 w-2.5" />
          {t("urlTab")}
        </button>
      </div>

      {urlMode && (
        <div className="flex gap-1">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlInput.trim()) { onUpdateClip(clip.id, { mediaUrl: urlInput.trim(), textContent: null }); setUrlMode(false); }
              if (e.key === "Escape") setUrlMode(false);
            }}
            placeholder="https://..."
            autoFocus
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => { if (urlInput.trim()) { onUpdateClip(clip.id, { mediaUrl: urlInput.trim(), textContent: null }); setUrlMode(false); } }}
            className="rounded bg-white/20 px-2 py-1 text-[10px] text-white transition-colors hover:bg-white/30"
          >{t("set")}</button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   AI generation field (prompt + references + generate)
--------------------------------------------------------------------------- */

function AiGenerateField({
  clip,
  onUpdateClip,
  onGenerate,
  models,
}: {
  clip: TimelineClip;
  onUpdateClip: (id: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
  onGenerate?: (clipId: string) => Promise<TimelineClip | null>; // i18n-ignore
  models?: { video: string; image: string };
}) {
  const t = useTimelineMessages("clipProperties");
  const { upload, uploading, reset } = useTimelineUpload();
  const docVisible = useDocumentVisible();
  const docVisibleRef = useRef(docVisible);
  const fileRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState(clip.aiPrompt || "");
  // Synchronous re-entry guard so a fast double-click can't fire two paid
  // generations before clip.aiGenerationStatus flips to "generating".
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const refUrls: string[] = (() => {
    if (!clip.aiReferenceUrls) return [];
    try {
      const parsed = JSON.parse(clip.aiReferenceUrls);
      return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string" && u) : [];
    } catch {
      return [];
    }
  })();

  useEffect(() => {
    docVisibleRef.current = docVisible;
    if (!docVisible) reset();
    return () => reset();
  }, [docVisible, reset]);

  useEffect(() => { setPrompt(clip.aiPrompt || ""); }, [clip.id, clip.aiPrompt]);

  const status = clip.aiGenerationStatus || "idle";
  const generating = status === "generating";
  const errored = status === "error";

  const currentModel = clip.aiModelId || models?.video || "";
  const isVideoModel = currentModel.includes("seedance") || currentModel.includes("kling") || currentModel.includes("wan");

  const updateRefs = (next: string[]) => {
    onUpdateClip(clip.id, { aiReferenceUrls: JSON.stringify(next) });
  };
  const handleAddFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0 || !docVisibleRef.current) return;
    // Upload all selected files, then write the merged list ONCE. Writing inside
    // the loop off the render-scoped `refUrls` snapshot loses every file but the
    // last (the debounced updateClip coalesces the overwrites).
    const uploaded: string[] = [];
    for (const file of files) {
      try {
        const url = await upload(file);
        if (!docVisibleRef.current) break;
        uploaded.push(url);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if ((err as { message?: string })?.message === "Upload aborted") return;
        /* useUpload toasts on its own */
      }
    }
    if (uploaded.length > 0 && docVisibleRef.current) updateRefs(mergeAiReferenceUrls(refUrls, uploaded));
  };

  const isVideoOutput = !!clip.mediaUrl && /\.(mp4|mov|webm|m4v)([?#]|$)/.test(clip.mediaUrl.toLowerCase());
  const canGenerate = !!onGenerate && !generating && !!prompt.trim();

  return (
    <div className="space-y-3.5">
      {/* Output mode */}
      {models && (
      <div>
        <FieldLabel>{t("output")}</FieldLabel>
        <Segmented
          value={isVideoModel ? "video" : "image"}
          onChange={(v) => onUpdateClip(clip.id, { aiModelId: v === "video" ? models.video : models.image })}
          options={[
            { value: "video", label: t("video"), icon: Film },
            { value: "image", label: t("image"), icon: ImageIcon },
          ]}
        />
        <p className="mt-1 text-[10px] text-[#7E7E87]">
          {isVideoModel ? t("videoModelHint") : t("imageModelHint")}
        </p>
      </div>
      )}

      {/* Prompt */}
      <div>
        <FieldLabel value={t("charCount", { count: prompt.length })}>{t("prompt")}</FieldLabel>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => { if (prompt !== (clip.aiPrompt || "")) onUpdateClip(clip.id, { aiPrompt: prompt }); }}
          rows={4}
          placeholder={isVideoModel ? t("videoPromptPlaceholder") : t("imagePromptPlaceholder")}
          className={`${inputClass} resize-none`}
        />
      </div>

      {/* References */}
      <div>
        <FieldLabel value={refUrls.length > 0 ? t("attachedCount", { count: refUrls.length }) : undefined}>
          {t("referenceImages")}
        </FieldLabel>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.04)] py-2 text-[11px] text-[#A0A0A8] transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:opacity-50"
        >
          {uploading ? (
            <><Loader2 className="h-3 w-3 animate-spin" /> {t("uploading")}</>
          ) : (
            <><Upload className="h-3 w-3" /> {t("addReferenceMedia")}</>
          )}
        </button>
        {isVideoModel && (
          <p className="mt-1 text-[10px] text-[#7E7E87]">
            {t("videoReferenceHint")}
          </p>
        )}
        {refUrls.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {refUrls.map((url, i) => {
              const lower = url.toLowerCase();
              const isVideoRef = /\.(mp4|mov|webm|m4v)([?#]|$)/.test(lower);
              const isAudioRef = /\.(mp3|wav|m4a|ogg|aac)([?#]|$)/.test(lower);
              return (
                <div key={url + i} className="group relative aspect-square overflow-hidden rounded-md border border-[rgba(255,255,255,0.08)] bg-[#101012]">
                  {isVideoRef ? (
                    <VisibilityGuardedVideo src={url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                  ) : isAudioRef ? (
                    <div className="flex h-full w-full items-center justify-center text-[9px] uppercase tracking-wider text-[#A0A0A8]">
                      {t("audioRef")}
                    </div>
                  ) : (
                    <VisibilityGuardedImage src={url} alt={t("referenceAlt", { n: i + 1 })} className="h-full w-full object-cover" loading="lazy" decoding="async" />
                  )}
                  <button
                    type="button"
                    onClick={() => updateRefs(refUrls.filter((_, j) => j !== i))}
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white opacity-0 transition-opacity hover:bg-red-500/80 group-hover:opacity-100"
                    title={t("removeReference")}
                    aria-label={t("removeReference")}
                  >×</button>
                </div>
              );
            })}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" multiple className="hidden" onChange={handleAddFile} />
      </div>

      {/* Result */}
      {clip.mediaUrl && (
        <div>
          <FieldLabel>{t("generated")}</FieldLabel>
          {isVideoOutput ? (
            <VisibilityGuardedVideo src={clip.mediaUrl} controls preload="metadata" className="w-full rounded-md border border-[rgba(255,255,255,0.08)] bg-black" />
          ) : (
            <VisibilityGuardedImage src={clip.mediaUrl} alt={t("generatedAlt")} className="w-full rounded-md border border-[rgba(255,255,255,0.08)]" loading="lazy" decoding="async" />
          )}
        </div>
      )}

      {errored && clip.aiGenerationError && (
        <p className="text-[11px] leading-relaxed text-red-400">{clip.aiGenerationError}</p>
      )}

      <Button
        size="sm"
        onClick={async () => {
          if (!canGenerate || submittingRef.current) return;
          submittingRef.current = true;
          setSubmitting(true);
          try {
            // Await the persisted prompt before the paid action so the server reads
            // the latest value. updateClip is debounced; a null resolve means the
            // write was superseded or rejected, so bail rather than bill stale state.
            if (prompt !== (clip.aiPrompt || "")) {
              const persisted = await onUpdateClip(clip.id, { aiPrompt: prompt });
              if (persisted === null) return;
            }
            await onGenerate?.(clip.id);
          } catch { /* error stamped on clip */ } finally {
            submittingRef.current = false;
            setSubmitting(false);
          }
        }}
        disabled={!canGenerate || submitting}
        className="w-full border border-white/30 bg-white/15 text-white hover:border-white/60 hover:bg-white/25 disabled:border-[rgba(255,255,255,0.08)] disabled:bg-[rgba(255,255,255,0.04)] disabled:text-[#666670]"
      >
        {generating || submitting ? (
          <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {t("generating")}</>
        ) : (
          <><Wand2 className="mr-1.5 h-3.5 w-3.5" /> {clip.mediaUrl ? t("regenerate") : t("generate")}</>
        )}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Text styling sub-panel (its own component so the local style draft state
   doesn't bloat the main inspector).
--------------------------------------------------------------------------- */

function TextStyleSections({
  clip,
  onUpdateClip,
}: {
  clip: TimelineClip;
  onUpdateClip: (id: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
}) {
  const t = useTimelineMessages("clipProperties");
  const [textContent, setTextContent] = useState(clip.textContent || "");
  // Re-sync the draft when another clip is selected or the text changes elsewhere (undo, agents).
  useEffect(() => {
    setTextContent(clip.textContent || "");
  }, [clip.id, clip.textContent]);
  const revealTextIfHidden = () => clip.opacity <= 0 ? { opacity: 1 } : {};

  return (
    <div className="space-y-2">
      <TextCardSection icon={Type} title={t("content")} defaultOpen>
        <textarea
          value={textContent}
          onChange={(e) => setTextContent(e.target.value)}
          onBlur={() => { if (textContent !== (clip.textContent || "")) onUpdateClip(clip.id, { textContent, ...revealTextIfHidden() }); }}
          rows={3}
          className={`${inputClass} resize-none`}
          placeholder={t("enterText")}
        />
      </TextCardSection>

      {/* Phase 10b text inspector: templates, bundled fonts, spacing, stroke, shadow, glow, box, gradient
          (each control one text.style.set). */}
      <TextStylePanel clip={clip} />

      <TextInspectorSection
        title={t("blend")}
        checked={clip.opacity > 0}
        onCheckedChange={(checked) => onUpdateClip(clip.id, { opacity: checked ? 1 : 0 })}
        onReset={() => onUpdateClip(clip.id, { opacity: 1 })}
      >
        <SliderNumberRow
          label={t("opacity")}
          value={Math.round(clip.opacity * 100)}
          min={0}
          max={100}
          suffix="%"
          disabled={clip.opacity <= 0}
          onChange={(value) => onUpdateClip(clip.id, { opacity: value / 100 })}
        />
      </TextInspectorSection>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Graphics (Remotion) clip section. Template clips expose their manifest
   params as typed controls; custom AI-coded clips expose status plus a
   natural-language "describe a change" regeneration flow.
--------------------------------------------------------------------------- */

function RemotionTextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setText(value));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== value) onCommit(text); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={inputClass}
      />
    </div>
  );
}

function RemotionJsonField({
  label,
  value,
  invalidJson,
  onCommit,
}: {
  label: string;
  value: unknown;
  invalidJson?: boolean;
  onCommit: (v: string) => void;
}) {
  const t = useTimelineMessages("clipProperties");
  const initialText = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [text, setText] = useState(initialText);
  const [parseFailed, setParseFailed] = useState(!!invalidJson);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      setParseFailed(!!invalidJson);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, invalidJson]);
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          // Never persist an unparseable blob; flag it inline instead.
          try {
            JSON.parse(text);
          } catch {
            setParseFailed(true);
            return;
          }
          setParseFailed(false);
          const currentSerialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          if (text !== currentSerialized) onCommit(text);
        }}
        rows={4}
        spellCheck={false}
        className={`${inputClass} resize-none font-mono ${parseFailed ? "border-red-400/60 focus:border-red-400/60 focus:ring-red-400/20" : ""}`}
      />
      {parseFailed && (
        <p className="mt-1 text-[10px] text-red-400">{t("graphicsInvalidJson")}</p>
      )}
    </div>
  );
}

// Palette editor for a json param that holds a list of colours (confetti
// particles, chart series, ...). Order is meaningful — templates cycle through
// the list — so entries can be moved as well as edited.
function ColorArrayField({
  label,
  colors,
  asString,
  onCommit,
}: {
  label: string;
  colors: string[];
  asString: boolean;
  onCommit: (value: string | string[]) => void;
}) {
  const t = useTimelineMessages("clipProperties");
  const [draft, setDraft] = useState<string[]>(colors);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDraft(colors));
    return () => cancelAnimationFrame(frame);
  }, [colors]);

  const commit = (next: string[]) => {
    setDraft(next);
    onCommit(asString ? JSON.stringify(next) : next);
  };
  // Dragging the native colour picker fires onChange per pixel; keep those in
  // local state and persist once on blur.
  const setLocal = (index: number, value: string) =>
    setDraft((prev) => prev.map((c, i) => (i === index ? value : c)));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="space-y-1.5">
        {draft.map((color, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              type="color"
              value={toColorInputValue(color, "#ffffff")}
              onChange={(e) => setLocal(index, e.target.value)}
              onBlur={() => {
                if (draft[index] !== colors[index]) commit(draft);
              }}
              title={t("graphicsColorSwatch", { index: index + 1 })}
              className="h-7 w-7 shrink-0 cursor-pointer rounded border border-[rgba(255,255,255,0.12)] bg-transparent"
            />
            <input
              type="text"
              value={color}
              spellCheck={false}
              onChange={(e) => setLocal(index, e.target.value)}
              onBlur={() => {
                if (draft[index] !== colors[index]) commit(draft);
              }}
              className={`${inputClass} h-7 flex-1 py-0 font-mono text-[10px]`}
            />
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title={t("graphicsColorMoveUp")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-[#A0A0A8] hover:text-white disabled:opacity-35"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === draft.length - 1}
              title={t("graphicsColorMoveDown")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-[#A0A0A8] hover:text-white disabled:opacity-35"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => commit(draft.filter((_, i) => i !== index))}
              disabled={draft.length <= 1}
              title={t("graphicsColorRemove")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-red-400/70 hover:text-red-400 disabled:opacity-35"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => commit([...draft, draft[draft.length - 1] || "#ffffff"])}
        title={t("graphicsColorAdd")}
        className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded border border-dashed border-[rgba(255,255,255,0.18)] text-[10px] text-[#A0A0A8] hover:border-[rgba(255,255,255,0.35)] hover:text-white"
      >
        <Plus className="h-3 w-3" />
        {t("graphicsColorAdd")}
      </button>
    </div>
  );
}

// Row editor for a json param holding a list of flat objects (chart data:
// [{label, value}, ...]). Columns come from the stored rows, so the same field
// serves any template that stores tabular data.
function ObjectArrayField({
  label,
  rows,
  columns,
  asString,
  onCommit,
}: {
  label: string;
  rows: Record<string, unknown>[];
  columns: ObjectArrayColumn[];
  asString: boolean;
  onCommit: (value: string | Record<string, unknown>[]) => void;
}) {
  const t = useTimelineMessages("clipProperties");
  const [draft, setDraft] = useState<Record<string, unknown>[]>(rows);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDraft(rows));
    return () => cancelAnimationFrame(frame);
  }, [rows]);

  const commit = (next: Record<string, unknown>[]) => {
    setDraft(next);
    onCommit(asString ? JSON.stringify(next) : next);
  };
  const commitDraft = () => {
    if (JSON.stringify(draft) !== JSON.stringify(rows)) commit(draft);
  };
  const setCell = (index: number, key: string, value: unknown) =>
    setDraft((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };
  const blankRow = (): Record<string, unknown> =>
    Object.fromEntries(columns.map((c) => [c.key, c.type === "number" ? 0 : c.type === "boolean" ? false : c.type === "color" ? "#ffffff" : ""]));

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 pr-[72px]">
          {columns.map((column) => (
            <span key={column.key} className="flex-1 truncate text-[9px] uppercase tracking-wide text-[#6E6E77]">
              {column.key}
            </span>
          ))}
        </div>
        {draft.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            {columns.map((column) => {
              const cell = row[column.key];
              if (column.type === "boolean") {
                return (
                  <label key={column.key} className="flex h-7 flex-1 items-center gap-1.5 text-[10px] text-[#A0A0A8]">
                    <input
                      type="checkbox"
                      checked={!!cell}
                      onChange={(e) => {
                        const next = draft.map((r, i) => (i === index ? { ...r, [column.key]: e.target.checked } : r));
                        commit(next);
                      }}
                      className="h-3.5 w-3.5 cursor-pointer accent-white"
                    />
                    {column.key}
                  </label>
                );
              }
              if (column.type === "color") {
                return (
                  <div key={column.key} className="flex h-7 flex-1 items-center gap-1.5">
                    <input
                      type="color"
                      value={toColorInputValue(typeof cell === "string" ? cell : "", "#ffffff")}
                      onChange={(e) => setCell(index, column.key, e.target.value)}
                      onBlur={commitDraft}
                      title={column.key}
                      className="h-7 w-7 shrink-0 cursor-pointer rounded border border-[rgba(255,255,255,0.12)] bg-transparent"
                    />
                    <span className="truncate font-mono text-[10px] text-[#A0A0A8]">{String(cell ?? "")}</span>
                  </div>
                );
              }
              return (
                <input
                  key={column.key}
                  type={column.type === "number" ? "number" : "text"}
                  value={cell === undefined || cell === null ? "" : String(cell)}
                  spellCheck={false}
                  onChange={(e) =>
                    setCell(
                      index,
                      column.key,
                      // Keep the raw string while typing "-" or "1."; a NaN parse
                      // would wipe the cell mid-edit.
                      column.type === "number"
                        ? (e.target.value === "" ? "" : Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : cell)
                        : e.target.value,
                    )
                  }
                  onBlur={() => {
                    if (column.type === "number" && draft[index]?.[column.key] === "") {
                      setDraft((prev) => prev.map((r, i) => (i === index ? { ...r, [column.key]: 0 } : r)));
                      commit(draft.map((r, i) => (i === index ? { ...r, [column.key]: 0 } : r)));
                      return;
                    }
                    commitDraft();
                  }}
                  className={`${inputClass} h-7 min-w-0 flex-1 py-0 text-[10px]`}
                />
              );
            })}
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title={t("graphicsRowMoveUp")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-[#A0A0A8] hover:text-white disabled:opacity-35"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === draft.length - 1}
              title={t("graphicsRowMoveDown")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-[#A0A0A8] hover:text-white disabled:opacity-35"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => commit(draft.filter((_, i) => i !== index))}
              disabled={draft.length <= 1}
              title={t("graphicsRowRemove")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded border border-[rgba(255,255,255,0.12)] text-red-400/70 hover:text-red-400 disabled:opacity-35"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => commit([...draft, blankRow()])}
        title={t("graphicsRowAdd")}
        className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded border border-dashed border-[rgba(255,255,255,0.18)] text-[10px] text-[#A0A0A8] hover:border-[rgba(255,255,255,0.35)] hover:text-white"
      >
        <Plus className="h-3 w-3" />
        {t("graphicsRowAdd")}
      </button>
    </div>
  );
}

function RemotionParamField({
  control,
  onCommit,
}: {
  control: RemotionParamControl;
  onCommit: (key: string, value: unknown) => void;
}) {
  if (control.type === "color") {
    return (
      <ColorField
        label={control.label}
        value={typeof control.value === "string" ? control.value : ""}
        onChange={(v) => onCommit(control.key, v)}
      />
    );
  }
  if (control.type === "number") {
    const numeric = typeof control.value === "number" && Number.isFinite(control.value) ? control.value : 0;
    return (
      <SliderRow
        label={control.label}
        value={numeric}
        min={control.min ?? 0}
        max={control.max ?? 100}
        step={control.step ?? 1}
        display={fmtNum(numeric)}
        formatDisplay={(v) => fmtNum(v)}
        onChange={(v) => onCommit(control.key, v)}
      />
    );
  }
  if (control.type === "select") {
    return (
      <div>
        <FieldLabel>{control.label}</FieldLabel>
        <select
          value={String(control.value ?? "")}
          onChange={(e) => onCommit(control.key, e.target.value)}
          className={selectClass}
        >
          {(control.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>
    );
  }
  if (control.type === "colorArray") {
    return (
      <ColorArrayField
        label={control.label}
        colors={Array.isArray(control.value) ? (control.value as string[]) : []}
        asString={!!control.arrayAsString}
        onCommit={(v) => onCommit(control.key, v)}
      />
    );
  }
  if (control.type === "objectArray") {
    return (
      <ObjectArrayField
        label={control.label}
        rows={Array.isArray(control.value) ? (control.value as Record<string, unknown>[]) : []}
        columns={control.columns ?? []}
        asString={!!control.arrayAsString}
        onCommit={(v) => onCommit(control.key, v)}
      />
    );
  }
  if (control.type === "json") {
    return (
      <RemotionJsonField
        label={control.label}
        value={control.value}
        invalidJson={control.invalidJson}
        onCommit={(v) => onCommit(control.key, v)}
      />
    );
  }
  return (
    <RemotionTextField
      label={control.label}
      value={typeof control.value === "string" ? control.value : String(control.value ?? "")}
      onCommit={(v) => onCommit(control.key, v)}
    />
  );
}

function RemotionGraphicSection({
  clip,
  onUpdateClip,
  onEditRemotionClip,
}: {
  clip: TimelineClip;
  onUpdateClip: (id: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
  onEditRemotionClip?: ClipPropertiesProps["onEditRemotionClip"];
}) {
  const t = useTimelineMessages("clipProperties");
  const isCustom = !!clip.remotionCode;
  const status = clip.remotionStatus || "idle";
  const generating = status === "generating";
  const [changeText, setChangeText] = useState("");
  // Synchronous re-entry guard so a fast double-click can't fire two paid
  // regenerations before clip.remotionStatus flips to "generating".
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setChangeText(""));
    return () => cancelAnimationFrame(frame);
  }, [clip.id]);

  const fireEdit = async (request: string): Promise<boolean> => {
    if (!onEditRemotionClip || generating || submittingRef.current || !request.trim()) return false;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onEditRemotionClip(clip.id, request);
      return true;
    } catch {
      // Error already stamped on the clip by the hook; caller may restore UI state.
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const commitParam = (key: string, value: unknown) => {
    let current: Record<string, unknown> = {};
    try {
      const parsed = clip.remotionPropsJson ? JSON.parse(clip.remotionPropsJson) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* unparseable stored props fall back to {} */ }
    onUpdateClip(clip.id, { remotionPropsJson: JSON.stringify({ ...current, [key]: value }) });
  };

  if (!isCustom) {
    const controls = buildRemotionParamControls(clip.remotionTemplateId, clip.remotionPropsJson);
    return (
      <div className="space-y-3.5">
        {controls.map((control) => (
          <RemotionParamField key={control.key} control={control} onCommit={commitParam} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <p className={`text-[10px] ${C.faint}`}>{t("graphicsCustomLabel")}</p>

      {generating && (
        <div className="flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-2.5 py-2 text-[11px] text-white/85">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          {t("graphicsGenerating")}
        </div>
      )}

      {status === "error" && clip.remotionError && (
        <div className="space-y-2 break-words rounded-md border border-red-400/15 bg-red-400/5 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-red-400">{clip.remotionError}</p>
          <Button
            size="sm"
            onClick={() => fireEdit(`Fix this error: ${clip.remotionError}`)}
            disabled={!onEditRemotionClip || generating || submitting}
            className="h-7 border border-red-400/25 bg-red-400/10 px-2.5 text-[11px] text-red-200 hover:border-red-400/50 hover:bg-red-400/20 disabled:border-[rgba(255,255,255,0.08)] disabled:bg-[rgba(255,255,255,0.04)] disabled:text-[#666670]"
          >
            <Wand2 className="mr-1.5 h-3 w-3" />
            {t("graphicsAskAiFix")}
          </Button>
        </div>
      )}

      <div>
        <FieldLabel>{t("graphicsDescribeChange")}</FieldLabel>
        <textarea
          value={changeText}
          onChange={(e) => setChangeText(e.target.value)}
          rows={3}
          placeholder={t("graphicsDescribeChange")}
          className={`${inputClass} resize-none`}
        />
      </div>
      <Button
        size="sm"
        onClick={() => {
          const request = changeText.trim();
          if (!request) return;
          setChangeText("");
          void fireEdit(request).then((ok) => {
            if (!ok) setChangeText(request);
          });
        }}
        disabled={!changeText.trim() || generating || submitting || !onEditRemotionClip}
        className="w-full border border-white/30 bg-white/15 text-white hover:border-white/60 hover:bg-white/25 disabled:border-[rgba(255,255,255,0.08)] disabled:bg-[rgba(255,255,255,0.04)] disabled:text-[#666670]"
      >
        {generating || submitting ? (
          <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> {t("graphicsGenerating")}</>
        ) : (
          <><Wand2 className="mr-1.5 h-3.5 w-3.5" /> {t("graphicsApplyChange")}</>
        )}
      </Button>
    </div>
  );
}

type AudioAiTarget = {
  id: string;
  name: string;
  type: "voice" | "character";
};

type AudioAiCapabilities = {
  enhanceSpeech: boolean;
  changeVoice: boolean;
  detectSpeakers: boolean;
  separateMusicSpeech: boolean;
  splitBySpeaker: boolean;
  elevenlabsConfigured: boolean;
  replicateConfigured: boolean;
};

type AudioAiOperation = "enhance_speech" | "separate_music_speech" | "change_voice" | "detect_speakers" | "split_by_speaker";

// Module scope so React keeps the button DOM mounted across AudioAiSection
// renders (an inline component type remounts on every render, dropping focus).
function AudioAiOperationButton({
  operation,
  icon: Icon,
  label,
  processing,
  disabled,
  onRun,
  className,
}: {
  operation: AudioAiOperation;
  icon: LucideIcon;
  label: string;
  processing: string | null;
  disabled: boolean;
  onRun: (operation: AudioAiOperation) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onRun(operation)}
      disabled={disabled}
      className={`flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-[rgba(255,255,255,0.09)] bg-[rgba(255,255,255,0.04)] px-2 text-[10px] font-medium text-[#D8D8DE] transition-colors hover:border-white/30 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45${className ? ` ${className}` : ""}`}
    >
      {processing === operation ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function AudioAiSection({
  clip,
  onProcessAudioClip,
}: {
  clip: TimelineClip;
  onProcessAudioClip?: ClipPropertiesProps["onProcessAudioClip"];
}) {
  const t = useTimelineMessages("clipProperties");
  const toast = useTimelineToast();
  const [processing, setProcessing] = useState<string | null>(null);
  const [voiceTargets, setVoiceTargets] = useState<AudioAiTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [result, setResult] = useState<AudioAiResult | null>(null);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [targetsLoadFailed, setTargetsLoadFailed] = useState(false);
  const [targetsReloadSeq, setTargetsReloadSeq] = useState(0);
  const [capabilities, setCapabilities] = useState<AudioAiCapabilities | null>(null);
  const audioAiRequestSeqRef = useRef(0);

  useEffect(() => {
    audioAiRequestSeqRef.current += 1;
    setProcessing(null);
    setResult(null);
  }, [clip.id]);

  useEffect(() => {
    // Capabilities and voice targets come from a provider (spec §5.4, phase 8).
    // Without one every operation reports unavailable instead of failing.
    setTargetsLoadFailed(false);
    setVoiceTargets([]);
    setSelectedTarget("");
    setCapabilities(null);
    setTargetsLoaded(true);
  }, [clip.projectId, targetsReloadSeq]);

  const operationAvailable = (operation: AudioAiOperation) => {
    if (!capabilities) return false;
    if (operation === "enhance_speech") return capabilities.enhanceSpeech;
    if (operation === "change_voice") return capabilities.changeVoice;
    if (operation === "detect_speakers") return capabilities.detectSpeakers;
    if (operation === "split_by_speaker") return capabilities.splitBySpeaker;
    return capabilities.separateMusicSpeech;
  };

  const run = async (operation: AudioAiOperation) => {
    if (!onProcessAudioClip) {
      toast.error(t("audioAiUnavailable"));
      return;
    }
    if (!clip.mediaUrl) {
      toast.error(t("audioAiNoMedia"));
      return;
    }
    if (clip.aiGenerationStatus === "generating") {
      toast.error(t("audioAiAlreadyProcessing"));
      return;
    }
    if (!operationAvailable(operation)) {
      toast.error(t("audioAiProviderUnavailable"));
      return;
    }
    let voiceId: string | null = null;
    let characterId: string | null = null;
    if (operation === "change_voice") {
      const target = voiceTargets.find((item) => `${item.type}:${item.id}` === selectedTarget);
      if (!target) {
        toast.error(t("audioAiSelectVoice"));
        return;
      }
      if (target.type === "voice") voiceId = target.id;
      if (target.type === "character") characterId = target.id;
    }
    const requestSeq = audioAiRequestSeqRef.current + 1;
    audioAiRequestSeqRef.current = requestSeq;
    setProcessing(operation);
    try {
      const next = await onProcessAudioClip(clip.id, operation, { voiceId, characterId });
      if (audioAiRequestSeqRef.current !== requestSeq) return;
      if (!next) throw new Error(t("audioAiFailed"));
      setResult(next);
      if (next?.message) toast.success(next.message);
    } catch (err) {
      if (audioAiRequestSeqRef.current !== requestSeq) return;
      toast.error((err as Error)?.message || t("audioAiFailed"));
    } finally {
      if (audioAiRequestSeqRef.current === requestSeq) setProcessing(null);
    }
  };

  const operationDisabled = (operation: AudioAiOperation) =>
    !!processing || clip.aiGenerationStatus === "generating" || !onProcessAudioClip || !clip.mediaUrl || !operationAvailable(operation);

  const speakerSegments = result?.speakerSegments || [];

  return (
    <CollapsibleSection icon={AudioLines} title={t("audioAi")} defaultOpen={false}>
      <div className="break-words rounded-md border border-white/15 bg-white/5 px-2.5 py-2 text-[10px] leading-4 text-white/85">
        {t("audioAiProcessingNote")}
      </div>

      {!clip.mediaUrl && (
        <div className="break-words rounded-md border border-amber-400/15 bg-amber-400/5 px-2.5 py-2 text-[10px] leading-4 text-amber-100/85">
          {t("audioAiNoMediaInline")}
        </div>
      )}

      {targetsLoaded && targetsLoadFailed && (
        <div className="space-y-1.5 break-words rounded-md border border-amber-400/15 bg-amber-400/5 px-2.5 py-2 text-[10px] leading-4 text-amber-100/85">
          <p>{t("audioAiLoadFailedInline")}</p>
          <button
            type="button"
            onClick={() => setTargetsReloadSeq((seq) => seq + 1)}
            className="flex h-6 items-center gap-1 rounded border border-amber-400/25 bg-amber-400/10 px-2 text-[10px] font-medium text-amber-100 transition-colors hover:bg-amber-400/20"
          >
            <RefreshCw className="h-3 w-3" />
            {t("audioAiRetryLoad")}
          </button>
        </div>
      )}

      {targetsLoaded && !targetsLoadFailed && !capabilities && (
        <div className="break-words rounded-md border border-red-400/15 bg-red-400/5 px-2.5 py-2 text-[10px] leading-4 text-red-100/85">
          {t("audioAiProviderUnavailableInline")}
        </div>
      )}

      {clip.aiGenerationStatus === "error" && clip.aiGenerationError && (
        <div className="break-words rounded-md border border-red-400/15 bg-red-400/5 px-2.5 py-2 text-[10px] leading-4 text-red-100/85">
          {clip.aiGenerationError}
        </div>
      )}

      <div>
        <FieldLabel>{t("audioAiTools")}</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <AudioAiOperationButton operation="enhance_speech" icon={Mic2} label={t("enhanceSpeech")} processing={processing} disabled={operationDisabled("enhance_speech")} onRun={run} />
          <AudioAiOperationButton operation="separate_music_speech" icon={SplitSquareHorizontal} label={t("separateSpeechMusic")} processing={processing} disabled={operationDisabled("separate_music_speech")} onRun={run} />
          <AudioAiOperationButton operation="change_voice" icon={UserRound} label={t("changeVoice")} processing={processing} disabled={operationDisabled("change_voice")} onRun={run} />
          <AudioAiOperationButton operation="detect_speakers" icon={ScanSearch} label={t("detectSpeakers")} processing={processing} disabled={operationDisabled("detect_speakers")} onRun={run} />
          <AudioAiOperationButton operation="split_by_speaker" icon={Users} label={t("splitByCharacter")} processing={processing} disabled={operationDisabled("split_by_speaker")} onRun={run} className="col-span-2" />
        </div>
      </div>

      <div>
        <FieldLabel>{t("targetVoice")}</FieldLabel>
        <select
          className={selectClass}
          value={selectedTarget}
          onChange={(event) => setSelectedTarget(event.target.value)}
          disabled={!targetsLoaded || !capabilities?.changeVoice || voiceTargets.length === 0}
        >
          <option value="">{targetsLoaded ? t("selectVoice") : t("loading")}</option>
          {voiceTargets.map((target) => (
            <option key={`${target.type}:${target.id}`} value={`${target.type}:${target.id}`}>
              {target.type === "voice" ? t("voiceTarget", { name: target.name }) : t("characterTarget", { name: target.name })}
            </option>
          ))}
        </select>
        {targetsLoaded && capabilities?.changeVoice && voiceTargets.length === 0 && (
          <p className="mt-1.5 break-words text-[10px] leading-4 text-[#8C8C96]">{t("audioAiNoVoiceTargets")}</p>
        )}
      </div>

      {result?.createdClips?.length ? (
        <div className="break-words rounded-md border border-emerald-400/15 bg-emerald-400/5 px-2.5 py-2 text-[10px] text-emerald-200">
          {t("audioAiResultClips", { count: result.createdClips.length })}
        </div>
      ) : null}

      {speakerSegments.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>{t("audioAiSpeakers")}</FieldLabel>
          <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-[rgba(255,255,255,0.08)] bg-[#0f0f12] p-2">
            {speakerSegments.map((segment, index) => (
              <div key={`${segment.speakerId}-${segment.start}-${index}`} className="min-w-0 text-[10px] leading-4 text-[#C8C8CE]">
                <span className="break-words font-medium text-white">{segment.speakerId}</span>
                <span className="ml-1 text-[#7E7E87]">{segment.start.toFixed(1)}s-{segment.end.toFixed(1)}s</span>
                <p className="mt-0.5 break-words text-[#D8D8DE]">{segment.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

/* ---------------------------------------------------------------------------
   Header (type, editable name, timing summary, delete)
--------------------------------------------------------------------------- */

const TYPE_ICONS: Record<string, LucideIcon> = { video: Film, audio: Music, text: Type, sticker: ImageIcon, effect: Wand2, remotion: Sparkles };
const TYPE_LABEL_KEYS: Record<string, string> = {
  video: "typeVideo",
  audio: "typeAudio",
  text: "typeText",
  sticker: "typeSticker",
  effect: "typeEffect",
  remotion: "graphicsSectionTitle",
};
// Per-type accent for the header icon chip, matching the colored-icon header
// the Music (emerald) and Voiceover (violet) panels use.
const TYPE_ACCENT: Record<string, { bg: string; fg: string }> = {
  video: { bg: "bg-sky-500/15", fg: "text-sky-300" },
  audio: { bg: "bg-emerald-500/15", fg: "text-emerald-300" },
  text: { bg: "bg-amber-500/15", fg: "text-amber-300" },
  sticker: { bg: "bg-pink-500/15", fg: "text-pink-300" },
  // effect = purple, remotion = cyan — matching the timeline canvas palette.
  effect: { bg: "bg-purple-500/15", fg: "text-purple-300" },
  remotion: { bg: "bg-cyan-500/15", fg: "text-cyan-300" },
};

function ClipHeader({
  clip,
  onUpdateClip,
  onDeleteClip,
  typeOverride,
}: {
  clip: TimelineClip;
  onUpdateClip: (id: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
  onDeleteClip: (id: string) => void;
  // Replaces the generic type label in the subtitle (e.g. an effect's registry
  // name) so a single header can carry type-specific context.
  typeOverride?: string;
}) {
  const t = useTimelineMessages("clipProperties");
  const Icon = TYPE_ICONS[clip.trackType] || Film;
  const typeLabel = typeOverride || t((TYPE_LABEL_KEYS[clip.trackType] || "typeClip") as MessageKey<"clipProperties">);
  const accent = TYPE_ACCENT[clip.trackType] || TYPE_ACCENT.video;
  const [label, setLabel] = useState(clip.label || "");
  useEffect(() => {
    const frame = requestAnimationFrame(() => setLabel(clip.label || ""));
    return () => cancelAnimationFrame(frame);
  }, [clip.id, clip.label]);
  const duration = clip.endTime - clip.startTime;
  const isTextClip = clip.trackType === "text";

  return (
    <div>
      <div className={`${textPanelShell} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-[rgba(255,255,255,0.06)] px-3 py-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
            <Icon className={`h-3.5 w-3.5 ${isTextClip ? "text-[#E8E8EA]" : accent.fg}`} />
          </div>
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => { if (label !== (clip.label || "")) onUpdateClip(clip.id, { label }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder={typeLabel}
              aria-label={t("label")}
              className={`-ml-1 w-full truncate rounded border border-transparent bg-transparent px-1 font-medium text-[#E5E7EB] placeholder-[#7E7E87] transition-colors hover:border-[rgba(255,255,255,0.1)] focus:border-white/50 focus:bg-[#0f0f12] focus:outline-none ${isTextClip ? "py-0" : "py-0.5"} text-[11px]`}
            />
            <p className={`${isTextClip ? "mt-0 px-1 text-[9px] leading-3" : "mt-0.5 px-1 text-[10px]"} ${C.faint}`}>
              {t("rangeSummary", {
                type: typeLabel,
                start: clip.startTime.toFixed(1),
                end: (clip.startTime + duration).toFixed(1),
              })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDeleteClip(clip.id)}
            className={`${isTextClip ? "h-6 w-6" : "h-7 w-7"} shrink-0 p-0 text-red-400/60 hover:bg-red-500/10 hover:text-red-300`}
            aria-label={t("deleteClip")}
          >
            <Trash2 className={isTextClip ? "h-3 w-3" : "h-3.5 w-3.5"} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function EffectFadePreview({
  fadeIn,
  fadeOut,
  duration,
}: {
  fadeIn: number;
  fadeOut: number;
  duration: number;
}) {
  const safeDuration = Math.max(0.1, duration);
  const fadeInWidth = Math.min(48, Math.max(0, (fadeIn / safeDuration) * 100));
  const fadeOutWidth = Math.min(48, Math.max(0, (fadeOut / safeDuration) * 100));

  return (
    <div className="rounded-md border border-white/[0.06] bg-black/25 p-2.5">
      <div className="relative h-8 overflow-hidden rounded bg-[rgba(255,255,255,0.04)]">
        <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${fadeInWidth}%` }} />
        <div className="absolute inset-y-0 right-0 bg-fuchsia-400/20" style={{ width: `${fadeOutWidth}%` }} />
        <div className="absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-white/20" />
        <div className="absolute left-2 top-1/2 h-2 w-px -translate-y-1/2 bg-white/80" />
        <div className="absolute right-2 top-1/2 h-2 w-px -translate-y-1/2 bg-fuchsia-200/80" />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] tabular-nums text-[#74747D]">
        <span>{fmtNum(fadeIn)}s</span>
        <span>{fmtNum(duration)}s</span>
        <span>{fmtNum(fadeOut)}s</span>
      </div>
    </div>
  );
}

function EffectClipProperties({
  clip,
  onUpdateClip,
  onDeleteClip,
}: {
  clip: TimelineClip;
  onUpdateClip: (id: string, updates: Record<string, any>) => Promise<unknown> | void; // i18n-ignore
  onDeleteClip: (id: string) => void;
}) {
  const t = useTimelineMessages("clipProperties");
  const effectRows = [...(clip.effects ?? [])].sort((a, b) => a.order - b.order);
  const primaryEffect = effectRows[0];
  const { items: effectDefs } = useEffectCatalog("effect", { enabled: !!primaryEffect });
  const timelineController = useTimelineController();
  const effectDef = primaryEffect ? effectDefs.find((item) => item.id === primaryEffect.effectId) : undefined;
  // Param edits hit the effect row directly; the timeline poll only catches up a
  // beat later, so committed values are held locally to keep sliders steady.
  const [paramEdits, setParamEdits] = useState<Record<string, Record<string, ParamValue>>>({});
  useEffect(() => {
    const frame = requestAnimationFrame(() => setParamEdits({}));
    return () => cancelAnimationFrame(frame);
  }, [clip.id]);
  const effectTypeName = effectDef?.name ?? primaryEffect?.effectId ?? t("effectTypeMissing");
  const duration = Math.max(0, clip.endTime - clip.startTime);
  const displayDuration = Math.max(0.1, duration);

  // Mirrors the text-clip inspector: one shared card header (its subtitle carries
  // the effect type), then flat collapsible Timing + Fade sections instead of
  // nested EffectPanel cards.
  return (
    <div className="space-y-2 p-3 pb-4">
      <ClipHeader clip={clip} onUpdateClip={onUpdateClip} onDeleteClip={onDeleteClip} typeOverride={effectTypeName} />

      {effectRows.map((row) => {
        const def = effectDefs.find((item) => item.id === row.effectId);
        const values = { ...parseParams(row.paramsJson), ...(paramEdits[row.id] ?? {}) };
        return (
          <CollapsibleSection
            key={row.id}
            icon={SlidersHorizontal}
            title={def?.name ?? row.effectId}
            defaultOpen
          >
            <EffectParamPanel
              params={def?.params ?? []}
              values={values}
              emptyLabel={t("effectNoParameters")}
              onCommit={(key, value) => {
                const next = { ...values, [key]: value };
                setParamEdits((prev) => ({ ...prev, [row.id]: next }));
                void timelineController.execute({ type: "clip.effect.update", effectRowId: row.id, patch: { paramsJson: JSON.stringify(next) } });
              }}
            />
          </CollapsibleSection>
        );
      })}

      <CollapsibleSection icon={Clock3} title={t("timing")} defaultOpen>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("start")}
            value={clip.startTime}
            min={0}
            step={0.1}
            suffix="s"
            onCommit={(v) => onUpdateClip(clip.id, { startTime: v, endTime: v + duration })}
          />
          <NumberField
            label={t("duration")}
            value={displayDuration}
            min={0.1}
            step={0.1}
            suffix="s"
            onCommit={(v) => onUpdateClip(clip.id, { endTime: clip.startTime + v })}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Sparkles} title={t("effectFade")} defaultOpen>
        <EffectFadePreview
          fadeIn={clip.fadeInDuration}
          fadeOut={clip.fadeOutDuration}
          duration={displayDuration}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("fadeIn")}
            value={clip.fadeInDuration}
            min={0}
            max={displayDuration}
            step={0.1}
            suffix="s"
            onCommit={(v) => onUpdateClip(clip.id, { fadeInDuration: v })}
          />
          <NumberField
            label={t("fadeOut")}
            value={clip.fadeOutDuration}
            min={0}
            max={displayDuration}
            step={0.1}
            suffix="s"
            onCommit={(v) => onUpdateClip(clip.id, { fadeOutDuration: v })}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Main inspector
--------------------------------------------------------------------------- */

/** Which ramp button a clip's speed selects: its montage / hero / bullet curve or legacy ramp; "custom" for other curves. */
function speedRampCard(clip: Pick<TimelineClip, "speedCurveJson" | "speedRamp">): string {
  const curve = parseSpeedCurve(clip.speedCurveJson);
  if (curve) {
    const base = curve.id.replace(/^legacy_/, "");
    return ["montage", "hero", "bullet"].includes(base) ? base : "custom";
  }
  return clip.speedRamp || "none";
}

export function ClipProperties({ clip, onUpdateClip, onDeleteClip, onGenerateAiClip, onProcessAudioClip, onEditRemotionClip, selectedCount, onDeleteSelected, aiModels }: ClipPropertiesProps) {
  const t = useTimelineMessages("clipProperties");
  const timelineController = useTimelineController();

  // Multi-select summary
  if (selectedCount && selectedCount > 1) {
    return (
      <div className="p-3">
        <div className="rounded-md border border-[rgba(255,255,255,0.08)] bg-[#101012] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[#E8E8EA]">{t("selectedCount", { count: selectedCount })}</p>
              <p className={`mt-1 text-[10px] ${C.label}`}>{t("useShortcuts")}</p>
            </div>
            {onDeleteSelected && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDeleteSelected}
                className="h-7 shrink-0 px-2 text-xs text-red-400/70 hover:bg-red-500/10 hover:text-red-300"
                aria-label={t("deleteSelected")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const type = clip.trackType;
  const isText = type === "text";
  const isSticker = type === "sticker";
  const isVideo = type === "video";
  const isAudio = type === "audio";
  const isRemotion = type === "remotion";
  if (clip.trackType === "effect") {
    return (
      <EffectClipProperties
        clip={clip}
        onUpdateClip={onUpdateClip}
        onDeleteClip={onDeleteClip}
      />
    );
  }
  const isAi = clip.mediaType === "ai_generate";
  const aiPlaceholder = isAi && !clip.mediaUrl;

  const duration = clip.endTime - clip.startTime;
  // Common helpers --------------------------------------------------------
  const set = (k: string, v: any) => onUpdateClip(clip.id, { [k]: v });

  // Speed edits are speed.set (phase 10b): the length follows the speed with the source span kept, keyframes
  // follow their source moments, a normal speed clears any curve, and later clips on the track are pushed —
  // the same rule as the Speed tab, the context menu, the shortcuts, and agents.
  const setPlaybackSpeed = (speed: number) => {
    void timelineController.execute({ type: "speed.set", clipId: clip.id, speed: Number(speed) || 1, curve: null });
  };
  const setSpeedRamp = (ramp: string) => {
    void timelineController.execute({ type: "speed.set", clipId: clip.id, ...speedRampRequest(ramp) });
  };
  const TextSharedSection = isText ? TextCardSection : CollapsibleSection;

  const transformSection = (
    <TextSharedSection icon={Move} title={t("transform")} defaultOpen={isVideo || isSticker}>
      {!isText && (
        <SliderRow
          label={t("opacity")} value={clip.opacity * 100} min={0} max={100} defaultValue={100}
          display={`${Math.round(clip.opacity * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
          onChange={(v) => set("opacity", v / 100)}
        />
      )}
      <SliderRow
        label={t("scale")} value={clip.scale * 100} min={10} max={isText ? 500 : 200} defaultValue={100}
        display={`${Math.round(clip.scale * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
        onChange={(v) => set("scale", v / 100)}
      />
      <div className="grid grid-cols-2 gap-3">
        <SliderRow label="X" value={clip.positionX * 100} min={0} max={100} defaultValue={50}
          display={`${Math.round(clip.positionX * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
          onChange={(v) => set("positionX", v / 100)} />
        <SliderRow label="Y" value={clip.positionY * 100} min={0} max={100} defaultValue={50}
          display={`${Math.round(clip.positionY * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
          onChange={(v) => set("positionY", v / 100)} />
      </div>
      <SliderRow
        label={<>{t("rotation")} {!isText && <ExportOnlyTag />}</>} value={clip.rotationDegrees} min={-180} max={180} defaultValue={0}
        display={`${Math.round(clip.rotationDegrees)}°`} formatDisplay={(v) => `${Math.round(v)}°`}
        onChange={(v) => set("rotationDegrees", v)}
      />
      {(isVideo || isSticker) && (
        <div>
          <FieldLabel>{t("flip")} <ExportOnlyTag /></FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => set("horizontalFlip", !clip.horizontalFlip)}
              aria-pressed={clip.horizontalFlip}
              className={`flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-[10px] transition-colors ${clip.horizontalFlip ? "border-white/40 bg-white/15 text-white" : "border-[rgba(255,255,255,0.08)] bg-white/[0.03] text-[#9A9AA3] hover:bg-white/[0.07]"}`}
            >
              <FlipHorizontal2 className="h-3 w-3" /> {t("flipH")}
            </button>
            <button
              type="button"
              onClick={() => set("verticalFlip", !clip.verticalFlip)}
              aria-pressed={clip.verticalFlip}
              className={`flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-[10px] transition-colors ${clip.verticalFlip ? "border-white/40 bg-white/15 text-white" : "border-[rgba(255,255,255,0.08)] bg-white/[0.03] text-[#9A9AA3] hover:bg-white/[0.07]"}`}
            >
              <FlipVertical2 className="h-3 w-3" /> {t("flipV")}
            </button>
          </div>
        </div>
      )}
      {isVideo && (
        <div>
          <FieldLabel>{t("crop")} <ExportOnlyTag /></FieldLabel>
          <CropPreview clip={clip} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <SliderRow label={t("cropLeft")} value={clip.cropLeft * 100} min={0} max={45} defaultValue={0}
              display={`${Math.round(clip.cropLeft * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
              onChange={(v) => set("cropLeft", v / 100)} />
            <SliderRow label={t("cropRight")} value={clip.cropRight * 100} min={0} max={45} defaultValue={0}
              display={`${Math.round(clip.cropRight * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
              onChange={(v) => set("cropRight", v / 100)} />
            <SliderRow label={t("cropTop")} value={clip.cropTop * 100} min={0} max={45} defaultValue={0}
              display={`${Math.round(clip.cropTop * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
              onChange={(v) => set("cropTop", v / 100)} />
            <SliderRow label={t("cropBottom")} value={clip.cropBottom * 100} min={0} max={45} defaultValue={0}
              display={`${Math.round(clip.cropBottom * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
              onChange={(v) => set("cropBottom", v / 100)} />
          </div>
        </div>
      )}
    </TextSharedSection>
  );

  const speedSection = (
    <CollapsibleSection icon={Gauge} title={t("speed")} exportOnly>
      <div>
        <SliderRow
          label={t("playbackSpeed")} value={clip.playbackSpeed} min={0.25} max={4} step={0.05} defaultValue={1}
          display={`${fmtNum(clip.playbackSpeed)}×`} formatDisplay={(v) => `${fmtNum(v)}×`}
          onChange={(v) => setPlaybackSpeed(v)}
        />
        <div className="mt-2">
          <Segmented
            value={(["0.5", "1", "2"].includes(fmtNum(clip.playbackSpeed)) ? fmtNum(clip.playbackSpeed) : "custom") as string}
            onChange={(v) => { if (v !== "custom") setPlaybackSpeed(parseFloat(v)); }}
            options={[
              { value: "0.5", label: "0.5×" },
              { value: "1", label: "1×" },
              { value: "2", label: "2×" },
            ]}
          />
        </div>
      </div>
      <ToggleRow label={t("reverse")} checked={clip.reversePlayback} onChange={(v) => set("reversePlayback", v)} icon={FastForward} />
      <div>
        <FieldLabel>{t("speedRamp")}</FieldLabel>
        <Segmented
          value={speedRampCard(clip)}
          onChange={(v) => setSpeedRamp(v)}
          options={[
            { value: "none", label: t("rampNone") },
            { value: "montage", label: t("rampMontage") },
            { value: "hero", label: t("rampHero") },
            { value: "bullet", label: t("rampBullet") },
          ]}
        />
      </div>
    </CollapsibleSection>
  );

  const FILTERS = [
    { value: "none", key: "filterNone" },
    { value: "warm", key: "filterWarm" },
    { value: "cool", key: "filterCool" },
    { value: "cinematic", key: "filterCinematic" },
  ] as const;

  const adjustSection = (
    <CollapsibleSection icon={SlidersHorizontal} title={t("adjust")} exportOnly>
      <SliderRow
        label={t("brightness")} value={clip.brightness} min={-1} max={1} step={0.02} defaultValue={0}
        display={fmtNum(clip.brightness)} formatDisplay={(v) => fmtNum(v)}
        onChange={(v) => set("brightness", v)}
      />
      <SliderRow
        label={t("contrast")} value={clip.contrast} min={0} max={3} step={0.02} defaultValue={1}
        display={fmtNum(clip.contrast)} formatDisplay={(v) => fmtNum(v)}
        onChange={(v) => set("contrast", v)}
      />
      <SliderRow
        label={t("saturation")} value={clip.saturation} min={0} max={3} step={0.02} defaultValue={1}
        display={fmtNum(clip.saturation)} formatDisplay={(v) => fmtNum(v)}
        onChange={(v) => set("saturation", v)}
      />
      <SliderRow
        label={t("blur")} value={clip.blurStrength} min={0} max={20} step={0.5} defaultValue={0}
        display={fmtNum(clip.blurStrength)} formatDisplay={(v) => fmtNum(v)}
        onChange={(v) => set("blurStrength", v)}
      />
      <div>
        <FieldLabel>{t("filter")}</FieldLabel>
        <Segmented
          value={(clip.visualFilter || "none") as string}
          onChange={(v) => set("visualFilter", v)}
          options={FILTERS.map((f) => ({ value: f.value, label: t(f.key) }))}
        />
      </div>
      <div>
        <FieldLabel>{t("blendMode")}</FieldLabel>
        <Segmented
          value={(clip.blendMode || "normal") as string}
          onChange={(v) => set("blendMode", v)}
          options={[
            { value: "normal", label: t("blendNormal") },
            { value: "multiply", label: t("blendMultiply") },
            { value: "screen", label: t("blendScreen") },
            { value: "overlay", label: t("blendOverlay") },
          ]}
        />
      </div>
      <SliderRow
        label={t("mosaic")} value={clip.mosaicStrength} min={0} max={64} step={1} defaultValue={0}
        display={clip.mosaicStrength > 0 ? `${Math.round(clip.mosaicStrength)}` : t("rampNone")}
        formatDisplay={(v) => (v > 0 ? `${Math.round(v)}` : t("rampNone"))}
        onChange={(v) => set("mosaicStrength", v)}
      />
    </CollapsibleSection>
  );

  const EQS = [
    { value: "none", key: "eqNone" },
    { value: "bass", key: "eqBass" },
    { value: "vocal", key: "eqVocal" },
    { value: "treble", key: "eqTreble" },
  ] as const;

  const audioSection = (
    <CollapsibleSection icon={isAudio ? Volume2 : AudioLines} title={t("audio")} defaultOpen={isAudio} exportOnly>
      <SliderRow
        label={t("volume")} value={clip.volume * 100} min={0} max={200} step={1} defaultValue={100}
        display={`${Math.round(clip.volume * 100)}%`} formatDisplay={(v) => `${Math.round(v)}%`}
        onChange={(v) => set("volume", v / 100)}
      />
      <SliderRow
        label={t("pan")} value={clip.audioPan} min={-1} max={1} step={0.05} defaultValue={0}
        display={clip.audioPan === 0 ? t("panCenter") : `${clip.audioPan < 0 ? "L" : "R"} ${Math.round(Math.abs(clip.audioPan) * 100)}`}
        formatDisplay={(v) => (v === 0 ? t("panCenter") : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`)}
        onChange={(v) => set("audioPan", v)}
      />
      <SliderRow
        label={t("pitch")} value={clip.audioPitch} min={-12} max={12} step={1} defaultValue={0}
        display={`${clip.audioPitch > 0 ? "+" : ""}${clip.audioPitch} st`}
        formatDisplay={(v) => `${v > 0 ? "+" : ""}${Math.round(v)} st`}
        onChange={(v) => set("audioPitch", v)}
      />
      <div>
        <FieldLabel>{t("equalizer")}</FieldLabel>
        <Segmented
          value={(clip.audioEq || "none") as string}
          onChange={(v) => set("audioEq", v)}
          options={EQS.map((e) => ({ value: e.value, label: t(e.key) }))}
        />
      </div>
      <div className="space-y-1 pt-1">
        <ToggleRow label={t("denoise")} checked={clip.audioDenoise} onChange={(v) => set("audioDenoise", v)} />
        <ToggleRow label={t("normalize")} checked={clip.audioNormalize} onChange={(v) => set("audioNormalize", v)} />
      </div>
    </CollapsibleSection>
  );

  const audioAiSection = (
    <AudioAiSection clip={clip} onProcessAudioClip={onProcessAudioClip} />
  );

  // Motion presets compile to clip keyframes: live in the preview and
  // interpolated server-side at export.
  const applyAnimationPreset = (preset: TimelineAnimationPreset, edge: TimelineAnimationEdge) => {
    set("keyframesJson", JSON.stringify({
      keyframes: getTimelineAnimationKeyframes(clip, preset, edge, 0.6),
    }));
  };
  const animPresetButtonClass = "rounded border border-[rgba(255,255,255,0.08)] bg-white/[0.04] px-1.5 py-1 text-[10px] text-[#C8C8CE] transition-colors hover:border-[rgba(255,255,255,0.18)] hover:bg-white/[0.09] hover:text-white";
  const animationSection = (
    <TextSharedSection icon={Sparkles} title={t("animation")} exportOnly>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t("fadeIn")} value={clip.fadeInDuration} min={0} max={Math.max(0.1, duration)} step={0.1} suffix="s" onCommit={(v) => set("fadeInDuration", v)} />
        <NumberField label={t("fadeOut")} value={clip.fadeOutDuration} min={0} max={Math.max(0.1, duration)} step={0.1} suffix="s" onCommit={(v) => set("fadeOutDuration", v)} />
      </div>
      {!isAudio && (
        <>
          {(["in", "out"] as const).map((edge) => (
            <div key={edge} className="mt-2">
              <FieldLabel>{edge === "in" ? t("animateIn") : t("animateOut")}</FieldLabel>
              <div className="grid grid-cols-5 gap-1">
                {TIMELINE_ANIMATION_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    data-testid={`animation-preset-${edge}-${preset}`}
                    className={animPresetButtonClass}
                    onClick={() => applyAnimationPreset(preset, edge)}
                  >
                    {t(`animPreset_${preset}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {Boolean(clip.keyframesJson) && (
            <button
              type="button"
              data-testid="animation-preset-clear"
              className={`mt-2 w-full ${animPresetButtonClass}`}
              onClick={() => set("keyframesJson", null)}
            >
              {t("animClearKeyframes")}
            </button>
          )}
        </>
      )}
    </TextSharedSection>
  );

  const timingSection = (
    <TextSharedSection icon={Clock3} title={t("timing")} defaultOpen>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={t("start")} value={clip.startTime} min={0} step={0.1} suffix="s"
          onCommit={(v) => onUpdateClip(clip.id, { startTime: v, endTime: v + duration })}
        />
        <NumberField
          label={t("duration")} value={duration} min={0.1} step={0.1} suffix="s"
          onCommit={(v) => onUpdateClip(clip.id, { endTime: clip.startTime + v })}
        />
      </div>
    </TextSharedSection>
  );

  // Header subtitle context for graphics clips: the template's registry name,
  // or the custom-AI label when the clip carries generated Remotion code.
  const remotionTypeName = isRemotion
    ? (clip.remotionCode
        ? t("graphicsCustomLabel")
        : (clip.remotionTemplateId ? templateById(clip.remotionTemplateId)?.name : undefined))
    : undefined;

  return (
    <div className="space-y-2 p-3 pb-4">
      <ClipHeader clip={clip} onUpdateClip={onUpdateClip} onDeleteClip={onDeleteClip} typeOverride={remotionTypeName} />

      {/* AI generation, the primary control for AI clips. */}
      {isAi && (
        <CollapsibleSection icon={Wand2} title={t("aiGeneration")} defaultOpen={aiPlaceholder}>
          <AiGenerateField clip={clip} onUpdateClip={onUpdateClip} onGenerate={onGenerateAiClip} models={aiModels} />
        </CollapsibleSection>
      )}

      {/* For an AI clip with no media yet, generation is the only relevant panel. */}
      {!aiPlaceholder && (
        <>
          {isText && <TextStyleSections clip={clip} onUpdateClip={onUpdateClip} />}
          {isSticker && (
            <CollapsibleSection icon={ImageIcon} title={t("source")} defaultOpen>
              <StickerImageField clip={clip} onUpdateClip={onUpdateClip} />
            </CollapsibleSection>
          )}
          {isRemotion && (
            <CollapsibleSection icon={Sparkles} title={t("graphicsSectionTitle")} defaultOpen>
              <RemotionGraphicSection clip={clip} onUpdateClip={onUpdateClip} onEditRemotionClip={onEditRemotionClip} />
            </CollapsibleSection>
          )}

          {isText ? (
            <div className="space-y-2">
              {timingSection}
              {transformSection}
              {animationSection}
            </div>
          ) : (
            <>
              {timingSection}
              {(isVideo || isSticker || isRemotion) && transformSection}
              {(isVideo || isAudio) && speedSection}
              {isVideo && adjustSection}
              {(isVideo || isAudio) && audioSection}
              {(isAudio || isVideo) && audioAiSection}
              {animationSection}
            </>
          )}
        </>
      )}
    </div>
  );
}
