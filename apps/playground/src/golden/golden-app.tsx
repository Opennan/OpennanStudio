// ?golden=<fixture>: renders one export golden fixture in <Preview> only, for snapshot capture
// (e2e/golden-snapshots.spec.ts). Fixtures are shared with packages/export/golden.
import { useEffect, useMemo, useState } from "react";
import { LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import { createBrowserMediaEnvironment } from "@opennan/timeline-media";
import { Preview, TimelineProvider, useTimelineController } from "@opennan/timeline-react";
import { GOLDEN_FONT_FAMILY, GOLDEN_MEDIA_URL, goldenFixture } from "../../../../packages/export/golden/fixtures";

const PROJECT_ID = "golden";

export function GoldenApp({ name }: { name: string }) {
    const fixture = useMemo(() => goldenFixture(name), [name]);
    const backend = useMemo(() => new LocalBackend({ persistence: createMemoryPersistence() }), []);
    const media = useMemo(() => createBrowserMediaEnvironment(), []);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const font = new FontFace(GOLDEN_FONT_FAMILY, `url(${GOLDEN_MEDIA_URL}/golden-font.ttf)`, { weight: "700" });
        void font.load()
            .then((loaded) => {
                document.fonts.add(loaded);
                return backend.seedProject(PROJECT_ID, {
                    meta: { name: fixture.name, aspectRatio: fixture.aspectRatio, musicUrl: fixture.musicUrl, musicVolume: fixture.musicVolume },
                    tracks: fixture.tracks,
                    scenes: fixture.scenes,
                    clips: fixture.clips,
                });
            })
            .then(() => setReady(true));
    }, [backend, fixture]);

    if (!ready) return <p className="loading">Loading golden fixture…</p>;
    return (
        <TimelineProvider backend={backend} projectId={PROJECT_ID} media={media} debugHooks>
            <GoldenHandle />
            <Preview className="golden-preview" />
        </TimelineProvider>
    );
}

function GoldenHandle() {
    const controller = useTimelineController();
    useEffect(() => {
        Object.assign(window, { __golden: { controller } });
    }, [controller]);
    return null;
}
