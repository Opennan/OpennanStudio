"use client";
// The timeline menu's AI group (phase 11) on clips and scenes: the tools that fit the item, each with the host's price on
// the right. Rows that need a choice ("Upscale…", "Translate captions…", "Remove silences…") select the item and open
// its inspector on the AI tab at that tool; the others run at once through the host. Disabled rows carry their reason
// (tooltip and accessible description). A multi-selection that holds the item adds Auto cut to beat.
import { AudioLines, AudioWaveform, Captions, Eraser, Languages, Maximize2, Music2, Scissors, Sparkles, Vibrate, Wand2 } from "lucide-react";
import { PAID_AI_TOOLS, planAiTool, type AiToolId, type AiToolParams } from "@opennan/timeline-core";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { CtxGroupLabel, CtxItem } from "../timeline/canvas/canvas-context-menu";
import type { AiPriceView, AiToolView } from "./ai-host";
import { AI_TOOLS_BY_KIND, type AiItemKind } from "./ai-tab";
import { useAutoCut } from "./auto-cut";
import { requestInspectorAiTab } from "./inspector-request";
import { useAiHost, useAiVersion } from "./use-ai";

export interface AiMenuRowsProps {
    target: { clipId: string; sceneId?: undefined } | { sceneId: string; clipId?: undefined };
    kind: AiItemKind;
    /** Closes the menu after a row runs. */
    onClose(): void;
}

const LOCAL: ReadonlySet<AiToolId> = new Set(["silences", "fillers", "beats"]);
/** Rows that open the inspector (a choice to make first). */
const OPENS_TAB: ReadonlySet<AiToolId> = new Set(["caption-translate", "video-upscale", "silences", "fillers", "beats"]);
/** Of those, the ones whose label ends in "…" (Detect beats starts at once). */
const ELLIPSIS: ReadonlySet<AiToolId> = new Set(["caption-translate", "video-upscale", "silences", "fillers"]);
const ICONS: Record<AiToolId, typeof Sparkles> = {
    captions: Captions, "caption-translate": Languages, "voice-isolation": AudioLines, stems: Music2, "remove-background": Eraser,
    "video-upscale": Maximize2, lipsync: Sparkles, stabilize: Vibrate, silences: AudioWaveform, fillers: Scissors, beats: Wand2,
};
const LABELS: Record<AiToolId, string> = {
    captions: "aiAutoCaptions", "caption-translate": "aiTranslateCaptions", "voice-isolation": "aiIsolateVoice", stems: "aiSplitVocals",
    "remove-background": "removeBackground", "video-upscale": "aiUpscale", lipsync: "aiLipSync", stabilize: "aiStabilize",
    silences: "aiRemoveSilences", fillers: "aiRemoveFillers", beats: "aiDetectBeats",
};

function priceHint(price: AiPriceView | undefined, free: string): string | undefined {
    if (!price) return undefined;
    if (price.kind === "estimate") return price.label;
    if (price.kind === "free") return free;
    if (price.kind === "billed-elsewhere") return price.by;
    return undefined;
}

export function AiMenuRows({ target, kind, onClose }: AiMenuRowsProps) {
    const t = useTimelineMessages("canvasTimeline");
    const host = useAiHost();
    useAiVersion(host);
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const itemId = (target.clipId ?? target.sceneId)!;
    // Auto cut to beat: the multi-selection that holds this item.
    const selection = useEditorStore((s) => {
        const clipIds = [...s.selectedClipIds];
        const sceneIds = [...s.selectedSceneIds];
        const holds = target.clipId ? s.selectedClipIds.has(target.clipId) : s.selectedSceneIds.has(target.sceneId!);
        return holds && clipIds.length + sceneIds.length >= 2 ? JSON.stringify({ clipIds, sceneIds }) : null;
    });
    const items = selection ? JSON.parse(selection) as { clipIds: string[]; sceneIds: string[] } : { clipIds: [], sceneIds: [] };
    const autoCut = useAutoCut(items);
    const snapshot = controller.snapshot();
    const tools = AI_TOOLS_BY_KIND[kind].filter((tool) => tool !== "lipsync");

    const openTab = (tool: AiToolId, autoStart?: boolean) => {
        requestInspectorAiTab(storeApi, { itemId, tool, ...(autoStart ? { autoStart } : {}) });
        const state = storeApi.getState();
        if (target.clipId) state.setSelectedClipIds(new Set([target.clipId]));
        else state.selectScene(target.sceneId!);
    };

    const row = (tool: AiToolId) => {
        const Icon = ICONS[tool];
        const label = ELLIPSIS.has(tool) ? t("aiWithChoice", { label: t(LABELS[tool] as never) }) : t(LABELS[tool] as never);
        const params: AiToolParams = tool === "remove-background" ? { ...target, background: "transparent" } : tool === "stems" ? { ...target, stems: "vocals" } : { ...target };
        let disabled = false;
        let reason: string | undefined;
        let hint: string | undefined;
        let action = () => openTab(tool, tool === "beats");
        if (LOCAL.has(tool)) {
            const plan = planAiTool(snapshot, tool, target);
            if (!plan.ok) {
                disabled = true;
                reason = plan.error;
            }
            hint = t("aiFree");
        } else if (kind === "image") {
            disabled = true;
            reason = t("aiVideoOnly");
        } else if (!host) {
            disabled = true;
            reason = t("aiNeedsApp");
        } else if (tool === "captions" && host.openAutoCaptions) {
            const plan = planAiTool(snapshot, tool, target);
            if (!plan.ok) {
                disabled = true;
                reason = plan.error;
            }
            action = () => host.openAutoCaptions!(target);
        } else {
            const view: AiToolView = host.tool(tool, params);
            hint = view.state === "unavailable" ? undefined : priceHint(view.price, t("aiFree"));
            if (OPENS_TAB.has(tool)) {
                // The choice comes first: the tab shows the final price and any reason.
            } else if (view.state === "unavailable") {
                disabled = true;
                reason = view.reason;
            } else if (view.state === "over-limit") {
                action = () => openTab(tool);
            } else if (PAID_AI_TOOLS.includes(tool) && view.state === "ready" && view.price.kind !== "estimate") {
                // A paid run starts only from a shown price: while it loads (or cannot be read) the row waits.
                disabled = true;
                reason = view.price.kind === "loading" ? t("aiPriceLoading") : t("aiPriceUnknown");
            } else {
                action = () => host.run(tool, params);
            }
        }
        return (
            <CtxItem
                key={tool} icon={<Icon className="h-3 w-3" />} label={label} hint={hint} disabled={disabled} reason={reason} testId={`ctx-ai-${tool}`}
                onClick={() => {
                    if (disabled) return;
                    action();
                    onClose();
                }}
            />
        );
    };

    return (
        <div role="group" aria-label={t("aiGroup")} data-testid="ctx-ai-group">
            <CtxGroupLabel label={t("aiGroup")} />
            {tools.map(row)}
            {selection && (
                <CtxItem
                    icon={<Scissors className="h-3 w-3" />} label={t("aiAutoCutToBeat")} hint={t("aiFree")} disabled={Boolean(autoCut.reason)} reason={autoCut.reason ?? undefined} testId="ctx-ai-auto-cut"
                    onClick={() => {
                        if (autoCut.reason) return;
                        void autoCut.run();
                        onClose();
                    }}
                />
            )}
        </div>
    );
}
