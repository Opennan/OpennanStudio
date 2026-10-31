"use client";
// The AI library (phase 11): tiles that open the editor host's generate dialog in one mode — image, video, video from the
// frame at the playhead, voice (text to speech), music, sound effect. The host prices each run, signs in, and places the
// result at the playhead (one undo step). Without a host that can generate, the tiles are disabled with the reason.
import { AudioLines, Clapperboard, Film, Frame, Image as ImageIcon, Mic, Music } from "lucide-react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import type { GenerateKind } from "./ai-host";
import { useAiHost } from "./use-ai";

export const AI_LIBRARY_TILES: ReadonlyArray<{ id: string; kind: GenerateKind; fromFrame?: boolean; icon: typeof Film; title: string; sub: string }> = [
    { id: "image", kind: "image", icon: ImageIcon, title: "ai_tileImage", sub: "ai_tileImageSub" },
    { id: "video", kind: "video", icon: Film, title: "ai_tileVideo", sub: "ai_tileVideoSub" },
    { id: "frame", kind: "video", fromFrame: true, icon: Frame, title: "ai_tileFrame", sub: "ai_tileFrameSub" },
    { id: "voice", kind: "voice", icon: Mic, title: "ai_tileVoice", sub: "ai_tileVoiceSub" },
    { id: "music", kind: "music", icon: Music, title: "ai_tileMusic", sub: "ai_tileMusicSub" },
    { id: "sfx", kind: "sfx", icon: AudioLines, title: "ai_tileSfx", sub: "ai_tileSfxSub" },
];

export function AiLibraryTab() {
    const t = useTimelineMessages("studioEditor");
    const host = useAiHost();
    const open = host?.openGenerate;
    const reason = open ? null : t("ai_needsApp");
    return (
        <div className="on-tabpanel on-ai-library" data-testid="library-ai">
            <div className="on-panel-head">
                <h2 className="on-panel-title">{t("ai_libTitle")}</h2>
            </div>
            <p className="on-panel-sub">{t("ai_libHint")}</p>
            {reason && <p className="on-panel-sub" data-testid="library-ai-reason">{reason}</p>}
            <div className="on-scroll">
                <ul className="on-ai-tiles">
                    {AI_LIBRARY_TILES.map((tile) => {
                        const Icon = tile.icon;
                        return (
                            <li key={tile.id}>
                                <button
                                    type="button" className="on-ai-tile" data-testid={`ai-tile-${tile.id}`} disabled={!open}
                                    title={reason ?? undefined} aria-description={reason ?? undefined}
                                    onClick={() => open?.(tile.kind, tile.fromFrame ? { fromFrame: true } : undefined)}
                                >
                                    <Icon aria-hidden="true" />
                                    <span>{t(tile.title as never)}</span>
                                    <span className="on-ai-tile-sub">{t(tile.sub as never)}</span>
                                </button>
                            </li>
                        );
                    })}
                    {host?.openStoryFilm && (
                        <li className="on-ai-tile-wide">
                            <button type="button" className="on-ai-tile" data-testid="ai-tile-story-film" onClick={() => host.openStoryFilm?.()}>
                                <Clapperboard aria-hidden="true" />
                                <span>{t("ai_tileStoryFilm")}</span>
                                <span className="on-ai-tile-sub">{t("ai_tileStoryFilmSub")}</span>
                            </button>
                        </li>
                    )}
                </ul>
            </div>
        </div>
    );
}
