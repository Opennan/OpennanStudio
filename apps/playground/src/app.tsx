import { useEffect, useMemo, useRef, useState } from "react";
import { LocalBackend, createIndexedDbPersistence, createMemoryPersistence, type TimelineToast } from "@opennan/timeline-core";
import { createBrowserMediaEnvironment } from "@opennan/timeline-media";
import {
    ClipProperties, Preview, Timeline, TimelineProvider, createLocalStorageMarkerStorage, useEditorStoreApi, useTimelineController,
    type TimelineHandle,
} from "@opennan/timeline-react";
import { SAMPLE_PROJECT_ID, seedSampleProject } from "./sample-project";

const E2E = new URLSearchParams(location.search).has("e2e");

export function App() {
    const backend = useMemo(() => new LocalBackend({
        persistence: E2E ? createMemoryPersistence() : createIndexedDbPersistence({ dbName: "opennan-playground" }),
    }), []);
    const media = useMemo(() => createBrowserMediaEnvironment({ resolveLocalUrl: (url) => backend.resolveLocalUrl(url) }), [backend]);
    // Markers survive reload outside e2e, as the app's localStorage markers did (SRC/stores/editor-store.ts:26-46).
    const markerStorage = useMemo(() => (E2E ? undefined : createLocalStorageMarkerStorage("opennan-playground:markers:")), []);
    const [ready, setReady] = useState(false);
    const [toasts, setToasts] = useState<TimelineToast[]>([]);

    useEffect(() => {
        void seedSampleProject(backend, { force: E2E }).then(() => setReady(true));
    }, [backend]);

    if (!ready) return <p className="loading">Loading sample project…</p>;
    return (
        <TimelineProvider
            backend={backend}
            projectId={SAMPLE_PROJECT_ID}
            media={media}
            debugHooks={E2E || import.meta.env.DEV}
            markerStorage={markerStorage}
            onToast={(toast) => setToasts((list) => [...list.slice(-4), toast])}
        >
            <Editor />
            <ul className="toasts" aria-live="polite">
                {toasts.map((toast, i) => <li key={i} data-kind={toast.kind}>{toast.message}</li>)}
            </ul>
        </TimelineProvider>
    );
}

function Editor() {
    const handle = useRef<TimelineHandle>(null);
    const controller = useTimelineController();
    const store = useEditorStoreApi();
    useEffect(() => {
        if (E2E) Object.assign(window, { __playground: { controller, store, handle } });
    }, [controller, store]);
    return (
        <div className="layout">
            <section className="preview"><Preview /></section>
            <aside className="inspector"><ClipProperties /></aside>
            <section className="timeline"><Timeline ref={handle} /></section>
            <a className="playground-tool-link" href="/?demo=layers">Layer tool: image → editable layers</a>
        </div>
    );
}
