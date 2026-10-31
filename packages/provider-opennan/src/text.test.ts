// Story film on OpenNan: reference images, quality and size on generations, text.generate, web.fetch, and their prices.
import type { MediaPreparer } from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { createOpenNanProvider } from "./provider";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;

beforeAll(async () => {
    fake = await startFakeOpenNan();
});
afterAll(async () => {
    await fake.close();
});
beforeEach(() => fake.reset());

const PNG: MediaPreparer = async () => ({ data: new Uint8Array([137, 80, 78, 71]), contentType: "image/png", filename: "sheet.png", sizeBytes: 4, width: 2, height: 2 });

async function provider() {
    const api = createOpenNanApi({ baseUrl: fake.url });
    const session = new OpenNanSession({ api, store: memoryCredentialStore({ apiKey: fake.mintKey(), keyId: "key_1" }), deviceName: "Mac", client: "desktop" });
    await session.restore();
    return createOpenNanProvider(session, { prepareMedia: PNG, pollIntervalMs: 1 });
}

const lastBody = (path: string) => fake.state().requests.filter((r) => r.path === path).at(-1)?.body as Record<string, unknown>;

describe("story film on OpenNan", () => {
    it("sends a keyframe with its reference images in order, at the asked size", async () => {
        const p = await provider();
        const out = await p.run!({
            capability: "image.generate",
            input: { description: "A frame", model: "nano-banana-pro", aspectRatio: "16:9", size: "2K", image: { mediaUrl: "opennan-local://media/a.png" }, images: [{ mediaUrl: "opennan-local://media/b.png" }, "https://cdn.example.com/c.png"] },
        }).result();
        expect(out.media[0]?.kind).toBe("image");
        const body = lastBody("/v1/images/generations");
        expect(body).toMatchObject({ model: "nano-banana-pro", size: "2K", aspect_ratio: "16:9" });
        expect(typeof body.image).toBe("string");
        expect(body.images).toHaveLength(2);
        expect((body.images as string[])[1]).toBe("https://cdn.example.com/c.png");
    });

    it("refuses more reference images than the server takes, before sending anything", async () => {
        const p = await provider();
        const images = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.png`);
        await expect(p.run!({ capability: "image.generate", input: { description: "x", images } }).result()).rejects.toThrow(/at most 9/);
        expect(fake.state().requests.some((r) => r.path === "/v1/images/generations")).toBe(false);
    });

    it("animates from a first frame at a quality, without sound", async () => {
        const p = await provider();
        await p.run!({
            capability: "video.image-to-video",
            input: { description: "She walks", model: "seedance-2-mini", image: { mediaUrl: "opennan-local://media/k.png" }, durationSeconds: 5, aspectRatio: "16:9", quality: "720p", generateAudio: false },
        }).result();
        expect(lastBody("/v1/videos/generations")).toMatchObject({ model: "seedance-2-mini", duration: 5, quality: "720p", generate_audio: false, aspect_ratio: "16:9" });
    });

    it("prices a keyframe at its size and references, and a clip at its quality", async () => {
        const p = await provider();
        const image = await p.price!({ capability: "image.generate", input: { model: "nano-banana-pro", size: "2K", image: "https://x/a.png", images: ["https://x/b.png", "https://x/c.png"] }, units: {} });
        // The fake's quote: the 2K tier plus three input images.
        expect(image).toMatchObject({ kind: "estimate", estimate: { usd: 0.056, source: "quote" } });
        const clip = await p.price!({ capability: "video.image-to-video", input: { model: "seedance-2-mini", durationSeconds: 5, quality: "720p", generateAudio: false }, units: {} });
        expect(clip).toMatchObject({ kind: "estimate", estimate: { usd: 0.26 } });
        expect(await p.price!({ capability: "web.fetch", input: { url: "https://www.instagram.com/reel/x/" }, units: {} })).toEqual({ kind: "free" });
    });

    it("lists video qualities, image sizes, and which text models see images", async () => {
        const p = await provider();
        expect((await p.models!("video.image-to-video")).find((m) => m.id === "seedance-2-mini")?.qualities).toEqual(["720p", "1080p"]);
        expect((await p.models!("image.generate")).find((m) => m.id === "nano-banana-pro")?.qualities).toEqual(["1K", "2K", "4K"]);
        expect((await p.models!("text.generate")).map((m) => [m.id, m.vision === true])).toEqual([["text-fast", false], ["text-vision", true]]);
    });

    it("writes text: a never-under estimate first, then one JSON answer with its cost", async () => {
        const p = await provider();
        const input = { prompt: "Write a story.", instruction: "Answer in JSON.", maxTokens: 2000, model: "text-fast" };
        const price = await p.price!({ capability: "text.generate", input, units: {} });
        expect(price.kind).toBe("estimate");
        fake.queueChatReply("{\"title\":\"Rain Check\"}");
        const out = await p.run!({ capability: "text.generate", input }).result();
        expect(out.result).toMatchObject({ text: "{\"title\":\"Rain Check\"}", model: "text-fast" });
        expect(out.costUsd).toBeGreaterThan(0);
        expect(out.costUsd!).toBeLessThanOrEqual(price.kind === "estimate" ? price.estimate.usd : 0);
        expect(lastBody("/v1/chat/completions")).toMatchObject({ model: "text-fast", max_tokens: 2000, stream: false, messages: [{ role: "system" }, { role: "user", content: "Write a story." }] });
    });

    it("sends images to the first text model that sees them, and a refusal charges nothing", async () => {
        const p = await provider();
        fake.queueChatReply("ok");
        await p.run!({ capability: "text.generate", input: { prompt: "What happens?", images: [{ mediaUrl: "opennan-local://media/sheet.png" }] } }).result();
        const body = lastBody("/v1/chat/completions");
        expect(body.model).toBe("text-vision");
        expect((body.messages as Array<{ content: unknown[] }>)[0]!.content[1]).toMatchObject({ type: "image_url" });
        const refused = await p.run!({ capability: "text.generate", input: { prompt: "x", model: "text-fast", images: ["https://x/a.png"] } }).result().catch((e: Error) => e);
        expect((refused as Error).message).toMatch(/not charged/);
    });

    it("downloads a video-site link as a video, free", async () => {
        const p = await provider();
        const out = await p.run!({ capability: "web.fetch", input: { url: "https://www.instagram.com/reel/abc/" } }).result();
        expect(out.media[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
        expect(out.media[0]!.bytes!.byteLength).toBeGreaterThan(0);
        expect(lastBody("/v1/media/video-download")).toEqual({ url: "https://www.instagram.com/reel/abc/", max_height: 720 });
        await expect(p.run!({ capability: "web.fetch", input: { url: "https://example.com/v.mp4" } }).result()).rejects.toThrow(/not charged/);
    });
});
