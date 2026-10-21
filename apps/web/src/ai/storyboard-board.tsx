// The Storyboards board (AI tab → Storyboards): every scene in order with its storyboard status (none / drawing /
// ready, icon and words), its storyboard (phase 9c: each sheet OpenNan drew, then its panels; a 9b scene: its shots'
// panel images), Draw ≈ $x per scene
// and Draw all ≈ $Σ, each quoted before it runs and run as its own task (at most two at once); each finished drawing
// arrives through sync as one undo step. Click a panel to see it large.
import { useEffect, useMemo, useState } from "react";
import { formatUsdUp, pipelineRequest, type Quote } from "@opennan/director-client";
import { selectLiveScenes, type SceneData } from "@opennan/timeline-core";
import { storyboardImages, storyboardOf, useEditorStore, useTimelineMessages } from "@opennan/timeline-react";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import type { DirectorHost, DirectorError } from "./director-host";
import { directorErrorText, type DirectorT } from "./director-copy";
import { AlertIcon, CheckIcon, Spinner, TaskLine } from "./director-panel";
import { useDirectorState } from "./use-director";

/** Every image of a scene's storyboard in viewing order: each sheet's image, then its panels (9b: the shots' panels). */
export function boardImages(scene: Pick<SceneData, "shotBreakdown" | "storyboardSheets">): ReturnType<typeof storyboardImages> {
    return storyboardImages(storyboardOf(scene));
}

/** The panel images of a scene's storyboard, in order. */
export function scenePanels(scene: Pick<SceneData, "shotBreakdown" | "storyboardSheets">): string[] {
    return boardImages(scene).filter((image) => image.kind === "panel").map((image) => image.url);
}

export function orderedScenes(scenes: readonly SceneData[]): SceneData[] {
    return scenes.map((scene, index) => ({ scene, index })).sort((a, b) => (a.scene.order ?? 0) - (b.scene.order ?? 0) || a.index - b.index).map(({ scene }) => scene);
}

type PriceState = { quote: Quote } | { error: DirectorError } | "loading";

export function StoryboardBoard({ host }: { host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const live = useEditorStore(selectLiveScenes);
    const scenes = useMemo(() => orderedScenes(live), [live]);
    const state = useDirectorState(host);
    const drawing = host.drawingScenes();
    const serverId = host.serverId;
    const [prices, setPrices] = useState<Record<string, PriceState>>({});
    const [viewer, setViewer] = useState<{ scene: number; images: ReturnType<typeof boardImages>; index: number } | null>(null);
    // Re-priced when a scene appears or goes, gets its panels, or changes what its price depends on.
    const sceneKey = scenes.map((s) => `${s.id}:${scenePanels(s).length > 0 ? 1 : 0}:${s.duration ?? ""}:${s.cardType ?? ""}:${s.caption.length}`).join(",");
    useEffect(() => {
        let live = true;
        const timer = setTimeout(() => {
            for (const scene of scenes) {
                const regenerate = scenePanels(scene).length > 0;
                const request = pipelineRequest("storyboard", serverId, { sceneId: scene.id, ...(regenerate ? { body: { regenerate: true } } : {}) });
                setPrices((p) => ({ ...p, [scene.id]: "loading" }));
                void host.priceStep(request).then((answer) => {
                    if (live) setPrices((p) => ({ ...p, [scene.id]: answer }));
                });
            }
        }, 300);
        return () => {
            live = false;
            clearTimeout(timer);
        };
        // Re-priced when a scene appears, goes, or gets its panels.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sceneKey, host, serverId]);
    const toDraw = scenes.filter((scene) => scenePanels(scene).length === 0 && !drawing.has(scene.id));
    const total = toDraw.reduce((sum, scene) => {
        const price = prices[scene.id];
        return price && price !== "loading" && "quote" in price ? sum + price.quote.holdUsd : Number.NaN;
    }, 0);
    const draw = (scene: SceneData) => {
        const regenerate = scenePanels(scene).length > 0;
        const price = prices[scene.id];
        const known = price && price !== "loading" && "quote" in price ? price.quote : null;
        void host.runStep(pipelineRequest("storyboard", serverId, { sceneId: scene.id, ...(regenerate ? { body: { regenerate: true } } : {}) }), t("boardScene", { n: scenes.indexOf(scene) + 1 }), known).then((outcome) => {
            // The price went up: show the new one (nothing ran); the next click runs at it.
            if (outcome.quote) setPrices((p) => ({ ...p, [scene.id]: { quote: outcome.quote! } }));
        });
    };
    const tasks = new Map(state.tasks.filter((task) => task.sceneId).map((task) => [task.sceneId!, task]));
    return (
        <div className="director-board" data-testid="storyboard-board">
            <header className="director-head">
                <h2 className="director-title">{t("boardTitle")}</h2>
                {toDraw.length > 1 && (
                    <button type="button" className="button primary small" disabled={!Number.isFinite(total)} onClick={async () => { if (await host.checkHold(total)) toDraw.forEach(draw); }}>
                        {Number.isFinite(total) ? t("boardDrawAll", { usd: formatUsdUp(total) }) : t("boardPricing")}
                    </button>
                )}
            </header>
            <p className="muted director-intro">{t("boardIntro")}</p>
            {scenes.length === 0 && <p className="director-empty">{t("boardEmpty")}</p>}
            <ol className="director-board-list">
                {scenes.map((scene, i) => {
                    const panels = scenePanels(scene);
                    const images = boardImages(scene);
                    const busy = drawing.has(scene.id);
                    const price = prices[scene.id];
                    const task = tasks.get(scene.id);
                    return (
                        <li key={scene.id} className="director-board-scene" data-testid="storyboard-scene" data-status={busy ? "drawing" : panels.length ? "ready" : "none"}>
                            <div className="director-board-head">
                                <span className="director-board-name">{t("boardScene", { n: i + 1 })}</span>
                                <span className="director-board-status">
                                    {busy ? <><Spinner /> {t("boardDrawing")}</> : panels.length ? <><CheckIcon /> {t("boardReady", { count: panels.length })}</> : t("boardNone")}
                                </span>
                            </div>
                            {scene.caption && <p className="director-board-caption">{scene.caption}</p>}
                            {images.some((image) => image.kind === "sheet") && (
                                <div className="director-sheets" data-testid="storyboard-sheets">
                                    {images.map((image, n) => (image.kind === "sheet" ? (
                                        <PanelThumb key={`sheet-${image.url}-${n}`} url={image.url} sheet alt={t("sheetAlt", { scene: i + 1, n: image.sheet + 1 })} onOpen={() => setViewer({ scene: i + 1, images, index: n })} />
                                    ) : null))}
                                </div>
                            )}
                            {panels.length > 0 && (
                                <div className="director-panels">
                                    {images.map((image, n) => (image.kind === "panel" ? (
                                        <PanelThumb key={`${image.url}-${n}`} url={image.url} alt={t("panelAlt", { scene: i + 1, n: image.panel + 1 })} onOpen={() => setViewer({ scene: i + 1, images, index: n })} />
                                    ) : null))}
                                </div>
                            )}
                            {task && (busy || task.status === "failed") && <TaskLine task={task} host={host} onRetry={task.status === "failed" ? () => draw(scene) : undefined} />}
                            {!busy && (
                                <div className="director-card-actions">
                                    {price === undefined || price === "loading" ? <span className="muted">{t("boardPricing")}</span>
                                        : "quote" in price ? (
                                            <button type="button" className="button ghost small" onClick={() => draw(scene)}>
                                                {t(panels.length ? "boardRedraw" : "boardDraw", { usd: formatUsdUp(price.quote.holdUsd) })}
                                            </button>
                                        ) : <span className="director-error"><AlertIcon /> {price.error.code === "price_unavailable" ? t("boardNoPrice") : directorErrorText(t, price.error)}</span>}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
            {viewer && (() => {
                const image = viewer.images[viewer.index]!;
                const count = viewer.images.filter((i) => i.kind === "panel").length;
                const title = image.kind === "sheet" ? t("sheetAlt", { scene: viewer.scene, n: image.sheet + 1 }) : t("panelOf", { n: image.panel + 1, count });
                return (
                <Dialog title={title} onClose={() => setViewer(null)} className="director-viewer">
                    <PanelImage url={image.url} alt={image.kind === "sheet" ? title : t("panelAlt", { scene: viewer.scene, n: image.panel + 1 })} />
                    <div className="dialog-footer">
                        <button type="button" className="button ghost" disabled={viewer.index === 0} onClick={() => setViewer({ ...viewer, index: viewer.index - 1 })}>{t("back")}</button>
                        <button type="button" className="button ghost" disabled={viewer.index >= viewer.images.length - 1} onClick={() => setViewer({ ...viewer, index: viewer.index + 1 })}>{t("next")}</button>
                        <button type="button" className="button primary" data-autofocus onClick={() => setViewer(null)}>{t("close")}</button>
                    </div>
                </Dialog>
                );
            })()}
        </div>
    );
}

function PanelThumb({ url, alt, onOpen, sheet = false }: { url: string; alt: string; onOpen(): void; sheet?: boolean }) {
    return (
        <button type="button" className={sheet ? "director-panel-thumb director-sheet-thumb" : "director-panel-thumb"} onClick={onOpen} aria-label={alt}>
            <PanelImage url={url} alt="" />
        </button>
    );
}

function PanelImage({ url, alt }: { url: string; alt: string }) {
    const { media } = useStudioRuntime();
    return <img src={media.resolveMediaUrl(url)} alt={alt} loading="lazy" decoding="async" />;
}
