import { useRef, useState } from "react";
import { useEditorStore, useTimelineController } from "@opennan/timeline-react";
import { CanvasPresetPicker } from "../projects/canvas-preset-picker";
import { DEFAULT_CANVAS_RATIO } from "../projects/canvas-presets";
import { AccountChip } from "../account/account-chip";
import { AUTO_CAPTIONS } from "../ai/auto-captions-dialog";
import { GENERATE } from "../ai/generate-dialog";
import { useCapability } from "../ai/use-capability";
import { useStudioRuntime } from "../platform/runtime-context";
import { routeHref } from "../routing/routes";

export function EditorTopBar({ onExport, onAutoCaptions, onGenerate }: {
    onExport(): void;
    onAutoCaptions(): void;
    onGenerate(): void;
}) {
    const controller = useTimelineController();
    const captions = useCapability(useStudioRuntime().providers, "audio.transcribe", AUTO_CAPTIONS);
    const name = useEditorStore((s) => s.projectMeta?.name ?? "");
    const aspectRatio = useEditorStore((s) => s.projectMeta?.aspectRatio ?? DEFAULT_CANVAS_RATIO);
    const [draft, setDraft] = useState<string | null>(null);
    const skipCommit = useRef(false);

    const commitName = () => {
        const next = draft?.trim();
        setDraft(null);
        if (skipCommit.current) {
            skipCommit.current = false;
            return;
        }
        if (next && next !== name) void controller.execute({ type: "project.update", patch: { name: next } });
    };

    return (
        <header className="editor-topbar">
            <a className="button ghost small" href={routeHref({ name: "projects" })}>Projects</a>
            <input
                className="title-input"
                aria-label="Project name"
                value={draft ?? name}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                        skipCommit.current = true;
                        event.currentTarget.blur();
                    }
                }}
            />
            <CanvasPresetPicker
                compact
                value={aspectRatio}
                onChange={(ratio) => void controller.execute({ type: "project.update", patch: { aspectRatio: ratio } })}
            />
            <div className="topbar-spacer" />
            <button type="button" className="button ghost small" onClick={onGenerate}>{GENERATE}</button>
            {/* Always shown: without a provider it opens the guidance (capability-gated UI, spec §5.4). */}
            <button
                type="button"
                className="button ghost small topbar-gated"
                data-unavailable={captions.available ? undefined : "true"}
                title={captions.available ? `Transcribe the timeline audio (${captions.providerName})` : captions.message}
                onClick={onAutoCaptions}
            >
                {AUTO_CAPTIONS}
            </button>
            <button type="button" className="button primary small" onClick={onExport}>Export</button>
            <AccountChip />
        </header>
    );
}
