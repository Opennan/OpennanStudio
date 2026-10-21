// Export dialog on @opennan/export: resolution, what the export leaves out, progress, cancel, and the
// download. Keeps phase 3's labels and layout (e2e/export.spec.ts). Render inside <TimelineProvider>.
import { useEffect, useRef, useState } from "react";
import {
    resolveGifFormat, resolveOutputFormat, staticExportWarnings, type ExportFormatKind, type ExportResolution, type ExportResult, type ExportWarning,
} from "@opennan/export";
import { useEditorStore, useTimelineBackend, useTimelineController } from "@opennan/timeline-react";
import type { ExportDelivery, ExportEnginePreview } from "../platform/export-platform";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import { GIF_FORMAT_LABEL, exportFormatLabel, exportInputFromSnapshot, loadEffectCatalog } from "./export-input";
import type { LocalExport } from "./use-local-export";
import "./export-dialog.css";

const PHASE_LABEL = { probe: "Reading media", raster: "Drawing text", encode: "Encoding", render: "Rendering", mux: "Adding audio", gif: "Making the GIF" } as const;
const FORMAT_LABEL: Record<ExportFormatKind, string> = { video: "MP4", gif: "GIF" };

/** "about 2 min left" / "12 s left" for an ETA in seconds. */
export function formatTimeLeft(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `about ${minutes} min left`;
}

const keepOpen = () => {};

export function ExportDialog({ onClose, local }: { onClose(): void; local: LocalExport }) {
    const platform = useStudioRuntime().exportPlatform;
    const controller = useTimelineController();
    const { backend } = useTimelineBackend();
    const meta = useEditorStore((s) => s.projectMeta);
    const timelineData = useEditorStore((s) => s.timelineData);
    const [quality, setQuality] = useState<ExportResolution>("720p");
    const formats = platform.formats ?? ["video"];
    const [kind, setKind] = useState<ExportFormatKind>("video");
    const gif = kind === "gif";
    const [warnings, setWarnings] = useState<ExportWarning[]>([]);
    const [engine, setEngine] = useState<ExportEnginePreview | null>(null);
    const [delivery, setDelivery] = useState<ExportDelivery | null>(null);
    const handled = useRef<ExportResult | null>(null);
    const mounted = useRef(false);
    const { state, exporter } = local;
    const size = gif ? resolveGifFormat(meta?.aspectRatio, quality) : resolveOutputFormat(meta?.aspectRatio, quality);
    const running = state.status === "running";
    // Before a run: what this build's encoder choice gives; after: what the encoder produced.
    const format = state.status === "done" ? exportFormatLabel(state.result) : gif ? GIF_FORMAT_LABEL : engine?.formatLabel ?? platform.formatLabel;
    // After a run, the result's warnings also say when the encoder fell back from H.264.
    const shownWarnings = state.status === "done" ? state.result.warnings : warnings;
    // The last ffmpeg log lines of a failed run (phase 3 showed six).
    const log = state.status === "error" && state.detail ? state.detail.split("\n").slice(-6) : [];

    // Which engine runs and what will be left out, recomputed while the timeline or the resolution changes.
    useEffect(() => {
        let live = true;
        void loadEffectCatalog(backend).then(async (effects) => {
            const input = exportInputFromSnapshot(controller.snapshot(), effects);
            const preview = exporter.engine ? await exporter.engine(input, quality, kind).catch(() => null) : null;
            if (!live) return;
            setEngine(preview);
            setWarnings(staticExportWarnings(input, { gl: preview?.gl ?? platform.gl, nativeSpeed: preview?.nativeSpeed ?? platform.nativeSpeed }));
        });
        return () => {
            live = false;
        };
    }, [backend, controller, timelineData, platform, exporter, quality, kind]);

    // A finished export (from this dialog or from export.start) is delivered once: web downloads it,
    // desktop reports the saved file.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        if (state.status !== "done" || handled.current === state.result) return;
        const result = state.result;
        handled.current = result;
        void exporter.deliver(result, meta?.name ?? "").then((next) => {
            if (mounted.current && handled.current === result) setDelivery(next);
            else exporter.release?.(next);
        });
    }, [state, meta, exporter]);
    useEffect(() => () => {
        if (delivery) exporter.release?.(delivery);
    }, [delivery, exporter]);

    const start = async () => {
        setDelivery(null);
        await exporter.start({ controller, backend, resolution: quality, ...(gif ? { format: kind } : {}) });
    };
    const close = () => {
        if (running) exporter.session.cancel();
        else exporter.session.reset();
        onClose();
    };

    return (
        // Escape and the backdrop close the dialog only when no export runs: an export can take
        // minutes, so Cancel is the one way to stop it.
        <Dialog title="Export video" onClose={running ? keepOpen : close}>
            {formats.length > 1 && (
                <fieldset className="field" disabled={running}>
                    <legend>Format</legend>
                    <div className="quality-picker" role="radiogroup" aria-label="Format">
                        {formats.map((option) => (
                            <label key={option} className="quality" data-checked={kind === option || undefined}>
                                <input type="radio" name="export-format" checked={kind === option} onChange={() => setKind(option)} />
                                {FORMAT_LABEL[option]}
                            </label>
                        ))}
                    </div>
                </fieldset>
            )}
            <fieldset className="field" disabled={running}>
                <legend>Resolution</legend>
                <div className="quality-picker" role="radiogroup" aria-label="Resolution">
                    {platform.resolutions.map((option) => (
                        <label key={option} className="quality" data-checked={quality === option || undefined}>
                            <input type="radio" name="export-quality" checked={quality === option} onChange={() => setQuality(option)} />
                            {option}
                        </label>
                    ))}
                </div>
                <span className="muted small">{size.width} × {size.height} · {format} · {size.fps} fps{platform.resolutionNote ? ` · ${platform.resolutionNote}` : ""}</span>
                {engine && (
                    <span className="export-engine small" data-engine={engine.engine}>
                        {engine.engine === "gpu" ? "Fast export (GPU)" : "Compatible export"}
                        {engine.engine === "ffmpeg" && engine.reason ? <span className="muted"> · {engine.reason}</span> : null}
                    </span>
                )}
            </fieldset>
            {shownWarnings.length > 0 && (
                <ul className="export-note muted small" aria-label="Left out of the export">
                    {shownWarnings.map((warning, i) => <li key={i}>{warning.message}</li>)}
                </ul>
            )}
            {state.status === "running" && (
                <div className="export-progress">
                    <progress max={1} value={state.progress.ratio} aria-label="Export progress" />
                    <span className="muted small" aria-live="polite">
                        {PHASE_LABEL[state.progress.phase]} {Math.round(state.progress.ratio * 100)}%
                        {formatTimeLeft(state.progress.etaSeconds) ? ` · ${formatTimeLeft(state.progress.etaSeconds)}` : ""}
                    </span>
                </div>
            )}
            {delivery && state.status === "done" && (
                <p className="export-done" role="status">
                    {delivery.path ? "Saved" : "Exported"} {delivery.fileName} ({(delivery.size / (1024 * 1024)).toFixed(1)} MB).{" "}
                    {delivery.url && <a href={delivery.url} download={delivery.fileName}>Download again</a>}
                    {delivery.path && exporter.reveal && (
                        <button type="button" className="button ghost small" onClick={() => exporter.reveal?.(delivery)}>Show in folder</button>
                    )}
                </p>
            )}
            {state.status === "error" && (
                <div role="alert" className="export-error">
                    <p className="error-text">{state.message}</p>
                    {log.length > 0 && <pre className="export-log">{log.join("\n")}</pre>}
                </div>
            )}
            {state.status === "cancelled" && <p className="muted small">Export cancelled.</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={close}>{running ? "Cancel" : "Close"}</button>
                <button type="button" className="button primary" disabled={running} onClick={() => void start()}>
                    {state.status === "done" ? "Export again" : gif ? "Export GIF" : "Export MP4"}
                </button>
            </div>
        </Dialog>
    );
}
