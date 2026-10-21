import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { TimelineProvider } from "../provider/timeline-provider";
import { createTimelineTestRuntime } from "../test-utils/render-with-timeline";
import { useVideoCache } from "./use-video-cache";

function wrapperWith(media: { resolveMediaUrl(u: string): string; shouldPreloadBlob?(u: string): boolean }) {
    const runtime = createTimelineTestRuntime();
    return ({ children }: { children: ReactNode }) => createElement(TimelineProvider, {
        backend: runtime.backend, projectId: runtime.projectId, media, autoLoad: false, children,
    });
}

describe("useVideoCache", () => {
    afterEach(() => vi.restoreAllMocks());

    it("returns the resolved url when nothing is cached", () => {
        const { result } = renderHook(() => useVideoCache(), { wrapper: wrapperWith({ resolveMediaUrl: (u) => `r:${u}` }) });
        expect(result.current.cachedUrl("a.mp4")).toBe("r:a.mp4");
    });

    it("preloads only urls the environment allows and then serves the blob url", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }));
        const createObjectURL = vi.fn(() => "blob:test/1");
        Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
        const { result } = renderHook(() => useVideoCache(), {
            wrapper: wrapperWith({ resolveMediaUrl: (u) => u, shouldPreloadBlob: (u) => u.startsWith("/local/") }),
        });
        result.current.preload(["/local/a.mp4", "https://cdn.test/b.mp4"]);
        await waitFor(() => expect(result.current.cachedUrl("/local/a.mp4")).toBe("blob:test/1"));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(result.current.cachedUrl("https://cdn.test/b.mp4")).toBe("https://cdn.test/b.mp4");
    });
});
