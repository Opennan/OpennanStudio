// The visible "media not allowed" state (phase 5 hand-off): clips or scenes whose media the desktop app does
// not play (an agent's https:// or file:// URL) are counted and named, as text, never as links.
import { useMemo, useState } from "react";
import { selectLiveScenes, selectTimelineClips } from "@opennan/timeline-core";
import { useEditorStore } from "@opennan/timeline-react";
import { isMediaField, previewMediaUrl } from "../shared/media-policy";

type MediaHolder = Record<string, unknown>;

export function findRefusedMedia(items: readonly MediaHolder[], appOrigin: string): string[] {
    const refused: string[] = [];
    for (const item of items) {
        for (const [field, value] of Object.entries(item)) {
            if (!isMediaField(field)) continue;
            if (typeof value === "string" && value !== "" && !previewMediaUrl(value, appOrigin).allowed) {
                refused.push(value);
                break;
            }
        }
    }
    return refused;
}

export function MediaBannerView({ refused }: { refused: string[] }) {
    const [open, setOpen] = useState(false);
    if (refused.length === 0) return null;
    return (
        <div role="alert" className="desktop-media-banner">
            <span>
                {refused.length === 1 ? "1 item uses" : `${refused.length} items use`} media from outside this project. The desktop app only plays
                media imported into the project; import the file to use it.
            </span>
            <button type="button" className="button ghost small" onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>
            {open && (
                <ul className="desktop-media-banner-list">
                    {refused.slice(0, 5).map((url, i) => <li key={i}>{url.slice(0, 200)}</li>)}
                </ul>
            )}
        </div>
    );
}

export function MediaBanner() {
    const clips = useEditorStore(selectTimelineClips);
    const scenes = useEditorStore(selectLiveScenes);
    const refused = useMemo(
        () => findRefusedMedia([...(clips as unknown as MediaHolder[]), ...(scenes as unknown as MediaHolder[])], window.location.origin),
        [clips, scenes],
    );
    return <MediaBannerView refused={refused} />;
}
