// Shared types and pure helpers for the nonlinear timeline component.
import type { CSSProperties } from "react";

export type { SceneData } from "@opennan/timeline-core";
export { getSceneDuration, getSceneStart, parseSceneCardConfig } from "@opennan/timeline-core";
export {
  getSceneTimelineTrimStart, getSceneAudioUrl, buildSceneTimelineTrimCardConfig, isContentBackedScene, getSceneContentDuration,
  stripVoiceoverLayersFromCardConfig, defaultTracks, getEditableSceneTransitionTarget, withRequiredBaseTimelineTracks, withSceneVideoTracks,
} from "@opennan/timeline-core/timeline/scene-helpers";

export interface EffectDropPreviewLabel {
  trackIndex: number;
  height: number;
}

export interface NleTimelineProps {
  /** Window keyboard shortcuts for this instance (default true). */
  shortcutsEnabled?: boolean;
}

export interface TimelineConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  intent: "warning" | "danger";
}

export function getTimelineContextMenuStyle(x: number, y: number, width: number, height: number): CSSProperties {
  if (typeof window === "undefined") return { top: y, left: x };
  const margin = 8;
  return {
    top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
  };
}
