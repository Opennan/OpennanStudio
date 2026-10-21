// useUpload (SRC/hooks/use-upload.ts:35-150) over TimelineBackend.uploadFile, with the
// same return shape { upload, progress, uploading, url, error, reset } and abort semantics.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MediaKind } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import { getActiveRuntime } from "../provider/registry";

function kindOf(file: File): MediaKind {
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return "image";
}

export function useTimelineUpload() {
    // Never throws during render: seeded components render without a provider in tests.
    const runtime = useContext(TimelineContext) ?? getActiveRuntime();
    const [progress, setProgress] = useState(0);
    const [uploading, setUploading] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const upload = useCallback(async (file: File, _path?: string): Promise<string> => {
        if (!runtime) throw new Error("No <TimelineProvider> is mounted");
        const { backend, projectId } = runtime;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setUploading(true);
        setProgress(0);
        setError(null);
        try {
            const media = await backend.uploadFile(projectId, file, kindOf(file), { signal: controller.signal, onProgress: setProgress });
            setUrl(media.url);
            return media.url;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            throw err;
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setUploading(false);
        }
    }, [runtime]);

    const reset = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setProgress(0);
        setUploading(false);
        setUrl(null);
        setError(null);
    }, []);

    return { upload, progress, uploading, url, error, reset };
}
