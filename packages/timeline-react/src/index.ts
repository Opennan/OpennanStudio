// Public API of @opennan/timeline-react.
export const TIMELINE_REACT_VERSION = "0.13.0";

export { TimelineProvider, type TimelineProviderProps } from "./provider/timeline-provider";
export { createLocalStorageMarkerStorage, type TimelineMarkerStorage } from "./provider/marker-storage";
export type { TimelineContextValue, TimelineHostCallbacks } from "./provider/context";
export type { TimelineAiHost, AiToolView, AiPriceView, AiJobView, AiJobStatus, GenerateKind } from "./ai/ai-host";
export { AiActionButton, type AiActionButtonProps } from "./ai/ai-action-button";
export { AiJobTray, type AiJobTrayProps } from "./ai/ai-job-tray";
export { useAiHost, useAiTool, useAiJobs, formatUsd } from "./ai/use-ai";
export { createBrowserAnalyzer, type BrowserAnalyzerOptions } from "./analysis/browser-analyzer";
export type { TimelineToastApi, TimelineToastOptions } from "./provider/toast";
export { useEditorStore, useEditorStoreApi, useShallow } from "./hooks/use-editor-store";
export { useTimelineController } from "./hooks/use-timeline-controller";
export { useTimelineBackend } from "./hooks/use-timeline-backend";
export { useTimelineMedia, useTimelineConfig, usePortalContainer } from "./hooks/use-timeline-media";
export { useTimelineMessages, useTimelineTranslate } from "./hooks/use-timeline-messages";
export { useTimelineToast } from "./hooks/use-timeline-toast";
export { useTimelineCallbacks } from "./hooks/use-timeline-callbacks";
export { useDocumentVisible } from "./hooks/use-document-visible";
export { en, TIMELINE_NAMESPACES, type TimelineMessages, type TimelineNamespace } from "./i18n/en";
export { createTranslator, mergeMessages, type TimelineTranslate, type TimelineMessagesOverrides, type MessageValues } from "./i18n/format";
export { getRemotionLayerStyle, getRemotionLayerTransform, remotionLayerPlacement, type RemotionLayerPlacement } from "./remotion/remotion-transform";
export { registerRemotionAddon, type RemotionAddon, type TemplateDef, type TemplateParam, type RemotionOverlayProps } from "./remotion/registry";
export type * from "./types/host-requests";
export { Timeline, type TimelineProps } from "./timeline/timeline";
export { createTimelineCommandAdapters, useTimelineCommandAdapters, type TimelineCommandAdapters } from "./timeline/adapters";
export type { TimelineHandle } from "./timeline/timeline-handle";
export { ClipProperties, type ClipPropertiesPanelProps } from "./clip-properties";
export { TrackLabel } from "./parts/track-label";
export { TrackVolumeControl } from "./parts/track-volume-control";
export { AddTrackButton } from "./parts/add-track-button";
export { StickerPicker } from "./parts/sticker-picker";
export { TimelineErrorBoundary } from "./parts/timeline-error-boundary";
export { useTimelineShortcuts, type TimelineShortcut } from "./hooks/use-timeline-shortcuts";
export { useTimelineUpload } from "./hooks/use-timeline-upload";
export { Preview, type PreviewProps } from "./preview";
export { useVideoCache } from "./hooks/use-video-cache";
export { useEffectCatalog } from "./hooks/use-effect-catalog";
// ── phase 10a: CapCut-style editing chrome ──
export { EditorLibrary, LIBRARY_TABS, type EditorLibraryProps, type LibraryTab } from "./editing/library/editor-library";
export { Inspector } from "./editing/inspector/inspector";
export { hasReadOnlyShots } from "./editing/read-only-shots";
export { storyboardOf, storyboardImages, type ShownSheet } from "./editing/storyboard";
export { useSelectionTarget, lookTargetOf, type SelectionTarget, type LookTarget } from "./editing/selection";
export { applyTransition, applyFilter, addEffect, addEffectLayer } from "./editing/actions";
// ── phase 10c: multi-item selection ──
export {
    selectionItemIds, isMixedSelection, itemsPasteTime, copySelectedItems, clipboardHasScenes, deleteSelectedItems, duplicateSelectedItems,
    pasteItems, allEditableItems, groupSelectionOf, useGroupSelection, type GroupSelection,
} from "./editing/multi-selection";
// ── phase 10c: copy / paste attributes ──
export { AttributePastePicker } from "./editing/attributes/attribute-paste-picker";
export {
    useAttributeActions, createAttributeActions, selectionAttributeItem, selectionAttributeTargets, attributeShortcutLabel, PASTE_ATTRIBUTES_STORAGE_KEY,
    type AttributeActions, type AttributeActionDeps,
} from "./editing/attributes/use-attribute-actions";
// ── layered designs (image → editable layers) ──
export { LayerEditor, type LayerEditorProps, type LayerEditorHandle } from "./layer-editor/layer-editor";
export { drawDesign } from "./layer-editor/draw-design";
export type { Selection as LayerSelection } from "./layer-editor/selection";
