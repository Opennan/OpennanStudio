import { IDENTITY_MEDIA_ENVIRONMENT, LOCAL_MEDIA_PROTOCOL, createBrowserMediaEnvironment } from "./media-environment";

describe("MediaEnvironment", () => {
    it("identity environment returns urls unchanged", () => {
        expect(IDENTITY_MEDIA_ENVIRONMENT.resolveMediaUrl("https://cdn.test/a.mp4")).toBe("https://cdn.test/a.mp4");
    });

    it("browser environment resolves local media urls and leaves other urls alone", () => {
        const env = createBrowserMediaEnvironment({
            origin: "http://localhost:4317",
            resolveLocalUrl: (url) => (url === `${LOCAL_MEDIA_PROTOCOL}//media/a` ? "blob:http://localhost:4317/a" : null),
        });
        expect(env.resolveMediaUrl("opennan-local://media/a")).toBe("blob:http://localhost:4317/a");
        expect(env.resolveMediaUrl("opennan-local://media/missing")).toBe("opennan-local://media/missing");
        expect(env.resolveMediaUrl("https://cdn.test/v.mp4")).toBe("https://cdn.test/v.mp4");
    });

    it("allows byte fetches only for fetchable schemes and paths", () => {
        const env = createBrowserMediaEnvironment({ origin: "http://localhost:4317" });
        expect(env.canFetchMediaBytes?.("https://cdn.test/a.mp3")).toBe(true);
        expect(env.canFetchMediaBytes?.("/sample/a.mp3")).toBe(true);
        expect(env.canFetchMediaBytes?.("blob:http://localhost:4317/x")).toBe(true);
        expect(env.canFetchMediaBytes?.("opennan-local://media/unknown")).toBe(false);
    });

    it("preloads only same-origin http urls", () => {
        const env = createBrowserMediaEnvironment({ origin: "http://localhost:4317" });
        expect(env.shouldPreloadBlob?.("/sample/a.mp4")).toBe(true);
        expect(env.shouldPreloadBlob?.("https://cdn.test/a.mp4")).toBe(false);
        expect(env.shouldPreloadBlob?.("blob:http://localhost:4317/x")).toBe(false);
    });
});
