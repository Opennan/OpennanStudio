import { act } from "react";
import { createRoot } from "react-dom/client";
import { MediaBannerView, findRefusedMedia } from "./media-banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("media banner", () => {
    it("counts items with refused media and ignores imported media", () => {
        const refused = findRefusedMedia([
            { mediaUrl: `opennan-local://media/${ID}` }, { mediaUrl: "https://evil.test/a.mp4" }, { videoUrl: "file:///y.mp4", sourceVideoUrl: "file:///y.mp4" },
            { textContent: "https://x" }, { mediaUrl: null },
        ], "opennan-app://app");
        expect(refused).toEqual(["https://evil.test/a.mp4", "file:///y.mp4"]);
    });

    it("renders an alert only when something is refused, as text", () => {
        const host = document.createElement("div");
        const root = createRoot(host);
        act(() => root.render(<MediaBannerView refused={[]} />));
        expect(host.textContent).toBe("");
        act(() => root.render(<MediaBannerView refused={["https://evil.test/a.mp4"]} />));
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("1 item uses media from outside this project");
        act(() => (host.querySelector("button") as HTMLButtonElement).click());
        expect(host.querySelector("li")?.textContent).toBe("https://evil.test/a.mp4");
        expect(host.querySelector("a")).toBeNull();
        act(() => root.unmount());
    });
});
