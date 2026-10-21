// The media bin: import (file picker and drag-and-drop), list, drag to the timeline,
// and "Add to timeline" (src/media/place-media.ts).
import { useRef, useState } from "react";
import { selectLiveScenes, type UploadedMedia } from "@opennan/timeline-core";
import { useEditorStoreApi, useTimelineController, useTimelineMedia, useTimelineToast } from "@opennan/timeline-react";
import { formatDuration } from "../ui/format";
import { hasDraggedFiles, writeMediaDrag } from "./media-drag";
import { MEDIA_ACCEPT, mediaKindOfItem } from "./media-kind";
import { planAudioClipAtPlayhead, planVideoSceneAppend } from "./place-media";
import type { MediaLibrary } from "./use-media-library";
import "./media-bin.css";

/** `kind`: "visual" (all media, the Media tab) or "audio" (sound only, the Audio tab); both import any media. */
export function MediaBin({ library, kind: binKind = "visual" }: { library: MediaLibrary; kind?: "visual" | "audio" }) {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const toast = useTimelineToast();
    const inputRef = useRef<HTMLInputElement>(null);
    const warnedStorage = useRef(false);
    const [dragging, setDragging] = useState(false);

    const runImport = async (files: File[]) => {
        if (files.length === 0) return;
        const id = toast.loading(files.length === 1 ? `Importing ${files[0].name}…` : `Importing ${files.length} files…`);
        const result = await library.importFiles(files);
        if (result.persist !== "persistent" && !warnedStorage.current) {
            warnedStorage.current = true;
            toast.warning("This browser may delete local projects when it runs low on space. Export finished videos to keep a copy.");
        }
        if (result.imported.length > 0) {
            toast.success(result.imported.length === 1 ? `Imported ${result.imported[0].name}` : `Imported ${result.imported.length} files`, { id });
        } else {
            toast.dismiss(id);
        }
        for (const rejected of result.rejected) toast.error(`${rejected.name}: ${rejected.reason}`);
    };

    // Media lists everything (as CapCut's media panel does); Audio lists only sound.
    const shown = (library.items ?? []).filter((item) => binKind !== "audio" || mediaKindOfItem(item) === "audio");

    const addToTimeline = async (item: UploadedMedia) => {
        const kind = mediaKindOfItem(item);
        const state = storeApi.getState();
        if (kind === "video") {
            await controller.execute({ type: "scene.add", input: planVideoSceneAppend(selectLiveScenes(state), item) });
        } else if (kind === "image") {
            state.setAddImageRequest(item.url);
        } else if (kind === "audio") {
            const plan = planAudioClipAtPlayhead(state.timelineData?.clips ?? [], state.timelineData?.tracks ?? [], state.currentTime, item);
            if (plan.tracks && !(await controller.execute({ type: "track.update", tracks: plan.tracks })).ok) return;
            await controller.execute({ type: "clip.create", input: plan.input });
        }
    };

    return (
        <section className="media-bin" aria-label={binKind === "audio" ? "Audio" : "Media"}>
            <header className="panel-header">
                <h2>{binKind === "audio" ? "Audio" : "Media"}</h2>
                <button type="button" className="button small" disabled={library.busy} onClick={() => inputRef.current?.click()}>Import media</button>
                <input
                    ref={inputRef}
                    data-testid="media-import-input"
                    type="file"
                    multiple
                    hidden
                    accept={MEDIA_ACCEPT}
                    onChange={(event) => {
                        const files = [...(event.target.files ?? [])];
                        event.target.value = "";
                        void runImport(files);
                    }}
                />
            </header>
            <div
                className="media-drop"
                data-testid="media-drop-zone"
                data-dragging={dragging || undefined}
                onDragOver={(event) => {
                    if (!hasDraggedFiles(event.dataTransfer)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDragging(true);
                }}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                }}
                onDrop={(event) => {
                    if (!hasDraggedFiles(event.dataTransfer)) return;
                    event.preventDefault();
                    setDragging(false);
                    void runImport([...event.dataTransfer.files]);
                }}
            >
                {library.items === null ? (
                    <p className="muted small">Loading media…</p>
                ) : shown.length === 0 ? (
                    <div className="media-empty">
                        <p>{binKind === "audio" ? "Drop music or sound effects here" : "Drop video, audio, or images here"}</p>
                        <p className="muted small">or use Import media. Files stay on this device.</p>
                    </div>
                ) : (
                    <ul className="media-grid">
                        {shown.map((item) => (
                            <MediaTile key={item.url} item={item} onAdd={() => void addToTimeline(item)} onRemove={() => void library.remove(item.url)} />
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}

function MediaTile({ item, onAdd, onRemove }: { item: UploadedMedia; onAdd(): void; onRemove(): void }) {
    const media = useTimelineMedia();
    const kind = mediaKindOfItem(item);
    const src = media.resolveMediaUrl(item.url);
    return (
        <li className="media-tile" data-testid="media-item" draggable title={item.name} onDragStart={(event) => writeMediaDrag(event.dataTransfer, item)}>
            <div className="media-thumb">
                {kind === "image" ? <img src={src} alt="" draggable={false} />
                    : kind === "video" ? <video src={src} muted preload="metadata" />
                        : <span className="media-glyph">Audio</span>}
                {item.durationSeconds ? <span className="media-duration">{formatDuration(item.durationSeconds)}</span> : null}
            </div>
            <div className="media-name">{item.name}</div>
            {(kind === "video" || kind === "audio") && !item.durationSeconds && (
                <div className="media-warning" title="The browser could not read this file's length. Preview and export may fail.">
                    May not play in this browser
                </div>
            )}
            <div className="media-actions">
                <button type="button" className="icon-button" aria-label={`Add ${item.name} to timeline`} onClick={onAdd}>Add</button>
                <button type="button" className="icon-button danger" aria-label={`Remove ${item.name} from media`} onClick={onRemove}>Remove</button>
            </div>
        </li>
    );
}
