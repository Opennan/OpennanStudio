import { fireEvent, screen } from "@testing-library/react";
import { DEFAULT_TRANSLATE, type TimelineTranslate } from "../i18n/format";
import { en } from "../i18n/en";
import { EditorLibrary } from "../editing/library/editor-library";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { fakeAiHost } from "../test-utils/fake-ai-host";
import { AI_LIBRARY_TILES, AiLibraryTab } from "./ai-library-tab";

describe("AI library tab", () => {
    it("sits after Media in the rail and opens the host's generate dialog per tile", () => {
        const openGenerate = vi.fn();
        renderWithTimeline(<EditorLibrary media={<p>media</p>} audio={null} />, { translate: DEFAULT_TRANSLATE, ai: fakeAiHost({}, { openGenerate }) });
        const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
        expect(tabs.slice(0, 3)).toEqual(["Media", "AI", "Audio"]);
        fireEvent.click(screen.getByRole("tab", { name: "AI" }));
        expect(screen.getByTestId("library-ai")).toBeTruthy();
        expect(screen.getAllByTestId(/^ai-tile-/).map((tile) => tile.textContent)).toEqual([
            "ImageFrom a description", "VideoFrom text or an image", "From this frameAnimate the frame at the playhead",
            "VoiceText to speech", "MusicA track for the mood", "Sound effectAny sound from a description",
        ]);
        fireEvent.click(screen.getByTestId("ai-tile-image"));
        expect(openGenerate).toHaveBeenLastCalledWith("image", undefined);
        fireEvent.click(screen.getByTestId("ai-tile-frame"));
        expect(openGenerate).toHaveBeenLastCalledWith("video", { fromFrame: true });
        fireEvent.click(screen.getByTestId("ai-tile-sfx"));
        expect(openGenerate).toHaveBeenLastCalledWith("sfx", undefined);
    });

    it("without a host that generates, disables the tiles with the reason", () => {
        renderWithTimeline(<AiLibraryTab />, { translate: DEFAULT_TRANSLATE, ai: fakeAiHost() });
        expect(screen.getByTestId("library-ai-reason").textContent).toBe("AI tools need the OpenNan Studio app");
        for (const tile of screen.getAllByTestId(/^ai-tile-/)) {
            expect((tile as HTMLButtonElement).disabled).toBe(true);
            expect(tile.getAttribute("title")).toBe("AI tools need the OpenNan Studio app");
        }
    });

    it("every tile has its messages", () => {
        const table = en.studioEditor as Record<string, string>;
        for (const tile of AI_LIBRARY_TILES) {
            expect(table[tile.title]).toBeTruthy();
            expect(table[tile.sub]).toBeTruthy();
        }
        const translate: TimelineTranslate = DEFAULT_TRANSLATE;
        expect(translate("studioEditor", "ai_bg_transparent" as never)).toBe("Clear");
    });
});
