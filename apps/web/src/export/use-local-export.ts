// React binding for the platform exporter's session (web: ffmpeg.wasm; desktop: native ffmpeg in main).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ExportSessionState } from "@opennan/export";
import type { MediaEnvironment } from "@opennan/timeline-media";
import type { ExportPlatform, PlatformExporter } from "../platform/export-platform";

export interface LocalExport {
    exporter: PlatformExporter;
    state: ExportSessionState;
}

export function useLocalExport(platform: ExportPlatform, media: MediaEnvironment): LocalExport {
    const exporter = useMemo(() => platform.createExporter(media), [platform, media]);
    // dispose() only frees what the exporter holds (the wasm instance on web); StrictMode remounts are safe.
    useEffect(() => () => exporter.dispose(), [exporter]);
    const state = useSyncExternalStore(exporter.session.subscribe, exporter.session.getState, exporter.session.getState);
    return { exporter, state };
}
