// Reference videos (Story film's remake) against the fake server: the model's limits read from GET /v1/models, the
// request body a remake sends, its quote and never-under estimate with the reference seconds, and every limit refused
// before anything is uploaded or paid.
import { estimateReferenceVideoCost, type MediaPrepareInput, type MediaPreparePurpose, type MediaPreparer, type Provider } from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { createOpenNanProvider } from "./provider";
import { parseReferenceLimits, preparedReferenceProblem, referenceLengthProblem, referencePurpose } from "./references";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { FAKE_REFERENCE_VIDEOS, fakeMp4, fakeMp4Facts, fakeQuote, startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const mp4 = fakeMp4;

function preparer(seconds: number, size = { width: 1280, height: 720 }, extra: { frameRate?: number; contentType?: string } = {}) {
    const calls: Array<{ input: MediaPrepareInput; purpose: MediaPreparePurpose }> = [];
    const prepare: MediaPreparer = async (input, purpose) => {
        calls.push({ input, purpose });
        if (purpose.output === "image") return { data: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "sheet.png", sizeBytes: 3 };
        const data = mp4(seconds, size.width, size.height);
        return { data, contentType: extra.contentType ?? "video/mp4", filename: "shot.mp4", sizeBytes: data.byteLength, durationSeconds: seconds, ...size, ...(extra.frameRate ? { frameRate: extra.frameRate } : {}) };
    };
    return { prepare, calls };
}

async function provider(prepareMedia?: MediaPreparer): Promise<Provider> {
    const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: fake.mintKey(), keyId: "key_1" }), deviceName: "t", client: "desktop" });
    await session.restore();
    return createOpenNanProvider(session, { pollIntervalMs: 5, ...(prepareMedia ? { prepareMedia } : {}) });
}

const posts = (path: string) => fake.state().requests.filter((r) => r.method === "POST" && r.path === path);
const SHOT = { mediaUrl: "opennan-local://media/source", startSeconds: 3, endSeconds: 7.6 };
const remake = (extra: Record<string, unknown> = {}) => ({
    description: "Recreate @Video1 exactly. Replace the people with @Image1.", model: "seedance-2-5", durationSeconds: 5, quality: "720p", aspectRatio: "16:9", generateAudio: false,
    referenceVideos: [SHOT], referenceMode: "reference", referenceImages: [{ mediaUrl: "opennan-local://media/theo-sheet" }, { mediaUrl: "opennan-local://media/s01-keyframe" }],
    ...extra,
});

describe("reference video limits", () => {
    it("reads the model's reference_videos block into ProviderModel.referenceVideos", async () => {
        const models = await (await provider()).models!("video.image-to-video");
        expect(models.find((m) => m.id === "seedance-2-5")!.referenceVideos).toEqual({
            max: 3, minSeconds: 2, maxSeconds: 30, totalSeconds: 30, modes: ["reference", "editing", "extension"], formats: ["mp4", "mov"],
            maxMb: 60, minSide: 300, maxSide: 6000, minPixels: 409_600, minFps: 24, maxFps: 60, editMinSeconds: 4,
        });
        expect(models.find((m) => m.id === "seedance-2-mini")!.referenceVideos).toBeUndefined();
        expect(parseReferenceLimits({ modes: ["reference"] })).toBeUndefined();
        expect(parseReferenceLimits(null)).toBeUndefined();
    });

    it("explains a reference out of the limits: count, length, total, size, picture, frame rate, container", () => {
        const limits = parseReferenceLimits(FAKE_REFERENCE_VIDEOS)!;
        expect(referenceLengthProblem(limits, [1.5], "reference")).toMatch(/1\.5 s: the model takes 2 s at least/);
        expect(referenceLengthProblem(limits, [31], "reference")).toMatch(/30 s at most/);
        expect(referenceLengthProblem(limits, [15, 10, 10], "reference")).toMatch(/run 35 s: the model takes 30 s in all/);
        expect(referenceLengthProblem(limits, [5, 5, 5, 5], "reference")).toMatch(/at most 3 reference videos/);
        expect(referenceLengthProblem(limits, [3], "editing")).toMatch(/An edit needs a first video of 4 s/);
        expect(referenceLengthProblem(limits, [undefined, 5], "reference")).toBeNull();
        const file = { data: new Uint8Array(), contentType: "video/mp4", filename: "a.mp4", sizeBytes: 1000, durationSeconds: 5 };
        expect(preparedReferenceProblem(limits, { ...file, width: 640, height: 360 })).toMatch(/640x360: the model needs 409,600 pixels/);
        expect(preparedReferenceProblem(limits, { ...file, width: 1280, height: 280 })).toMatch(/each side must be 300 px at least/);
        expect(preparedReferenceProblem(limits, { ...file, width: 2000, height: 700 })).toMatch(/shape must be between 2:5 and 5:2/);
        expect(preparedReferenceProblem(limits, { ...file, width: 1280, height: 720, frameRate: 15 })).toMatch(/15 fps: the model takes 24 fps at least/);
        expect(preparedReferenceProblem(limits, { ...file, contentType: "video/webm", width: 1280, height: 720 })).toMatch(/must be MP4 or MOV/);
        expect(preparedReferenceProblem(limits, { ...file, sizeBytes: 61 * 1024 * 1024, width: 1280, height: 720 })).toMatch(/60 MB at most/);
        expect(preparedReferenceProblem(limits, { ...file, width: 1280, height: 720, frameRate: 30 })).toBeNull();
        expect(referencePurpose(limits)).toEqual({ output: "video", maxBytes: 60 * 1024 * 1024, maxSeconds: 30, contentTypes: ["video/mp4", "video/quicktime"], minPixels: 409_600, frameRate: { min: 24, max: 60 } });
    });
});

describe("a remake run", () => {
    it("uploads the shot as a reference video and sends reference_videos, reference_mode and reference_images (no first frame)", async () => {
        const { prepare, calls } = preparer(4.6);
        const output = await (await provider(prepare)).run!({ capability: "video.image-to-video", input: remake() }).result();
        expect(output.media[0]).toMatchObject({ kind: "video" });
        // The shot's range, prepared at the model's size, frame rate and container, without sound.
        expect(calls[0]).toEqual({ input: { kind: "media", source: SHOT }, purpose: expect.objectContaining({ output: "video", contentTypes: ["video/mp4", "video/quicktime"], minPixels: 409_600, maxSeconds: 30 }) });
        const [create] = posts("/v1/videos/generations");
        expect(create!.body).toEqual({
            model: "seedance-2-5", prompt: expect.stringMatching(/^Recreate @Video1/), duration: 5, quality: "720p", aspect_ratio: "16:9", generate_audio: false,
            reference_mode: "reference", reference_videos: [expect.stringMatching(/\/files\/uploads\/temp\/.*\.mp4$/)],
            reference_images: [expect.stringMatching(/\/files\/uploads\/temp\//), expect.stringMatching(/\/files\/uploads\/temp\//)],
        });
        expect(create!.body).not.toHaveProperty("image");
        // Settled on the measured reference seconds: (5 + ceil(4.6)) × $0.36894.
        expect(output.costUsd).toBe(3.6894);
        expect(fake.state().uploads.map((u) => u.contentType)).toContain("video/mp4");
    });

    it("refuses before any upload: a model without reference videos, a shot too short, a picture too small, a first frame beside them", async () => {
        const small = preparer(5, { width: 640, height: 360 });
        const p = await provider(small.prepare);
        await expect(p.run!({ capability: "video.image-to-video", input: remake({ model: "seedance-2-mini" }) }).result()).rejects.toThrow(/seedance-2-mini does not take reference videos/);
        await expect(p.run!({ capability: "video.image-to-video", input: remake({ referenceVideos: [{ mediaUrl: "opennan-local://media/source", startSeconds: 1, endSeconds: 2.5 }] }) }).result())
            .rejects.toThrow(/1\.5 s: the model takes 2 s at least\. Nothing was sent\./);
        await expect(p.run!({ capability: "video.image-to-video", input: remake() }).result()).rejects.toThrow(/640x360: the model needs 409,600 pixels.*Nothing was sent/);
        await expect(p.run!({ capability: "video.image-to-video", input: remake({ image: "https://x/a.png" }) }).result()).rejects.toThrow(/without image or endImage/);
        expect(fake.state().uploads).toHaveLength(0);
        expect(posts("/v1/videos/generations")).toHaveLength(0);
    });

    it("never pays more than it was priced at: a prepared clip longer than its range is not sent", async () => {
        const long = preparer(6.2);
        await expect((await provider(long.prepare)).run!({ capability: "video.image-to-video", input: remake() }).result()).rejects.toThrow(/longer than the length it was priced at/);
        expect(posts("/v1/videos/generations")).toHaveLength(0);
    });

    it("needs a host that can prepare project media", async () => {
        await expect((await provider()).run!({ capability: "video.image-to-video", input: remake() }).result()).rejects.toThrow(/cannot prepare local media/);
    });
});

describe("remake prices", () => {
    const quoteBodies = () => fake.state().requests.filter((r) => r.path === "/v1/quotes").map((r) => r.body);

    it("quotes the reference seconds with the output seconds (a 5 s shot with a 4.6 s reference: 10 billed seconds)", async () => {
        const answer = await (await provider()).price!({ capability: "video.image-to-video", input: remake(), units: { seconds: 5 } });
        expect(answer).toMatchObject({ kind: "estimate", estimate: { usd: 3.6894, source: "quote", holdUsd: 3.6894 } });
        expect(quoteBodies()[0]).toEqual({
            model: "seedance-2-5", duration: 5, quality: "720p", aspect_ratio: "16:9", generate_audio: false,
            reference_videos: ["https://opennan.com/studio/quote-input.mp4"], reference_mode: "reference", seconds: 5,
            reference_images: ["https://opennan.com/studio/quote-input.png", "https://opennan.com/studio/quote-input.png"],
        });
    });

    it("estimates never under the quote when the server gives none, and prices an unmeasured reference at the most it takes", async () => {
        await fetch(`${fake.url}/__test/quotes?status=404`);
        const p = await provider();
        const answer = await p.price!({ capability: "video.image-to-video", input: remake(), units: {} });
        expect(answer.kind).toBe("estimate");
        const usd = answer.kind === "estimate" ? answer.estimate.usd : 0;
        expect(usd).toBeGreaterThanOrEqual(fakeQuote({ model: "seedance-2-5", duration: 5, quality: "720p", reference_videos: ["https://x/a.mp4"], seconds: 5 }).body.price_usd as number);
        expect(answer).toMatchObject({ estimate: { source: "estimate", label: "≈ $3.69" } });
        const unmeasured = await p.price!({ capability: "video.image-to-video", input: remake({ referenceVideos: ["https://cdn.example.org/shot.mp4"] }), units: {} });
        expect(unmeasured).toMatchObject({ kind: "estimate", estimate: { microUsd: estimateReferenceVideoCost([{ quality: "720p", duration: 4, reference_video_seconds: 2, usd: 2.21364 }], 5, 30, "720p")!.microUsd } });
        const mini = await p.price!({ capability: "video.image-to-video", input: remake({ model: "seedance-2-mini" }), units: {} });
        expect(mini).toEqual({ kind: "unavailable", reason: "Seedance 2 Mini does not take reference videos." });
    });
});

describe("the fake server mirrors the live API", () => {
    it("prices, refuses and measures like /v1", () => {
        const quote = (extra: Record<string, unknown>) => fakeQuote({ model: "seedance-2-5", quality: "720p", duration: 5, generate_audio: false, ...extra });
        expect(quote({}).body.price_usd).toBe(3.0745);
        expect(quote({ reference_videos: ["https://x/a.mp4"], reference_mode: "reference", seconds: 5 }).body).toMatchObject({ price_usd: 3.6894, priced: { reference_video_seconds: 5, reference_videos: 1 } });
        expect(quote({ reference_videos: ["https://x/a.mp4"], seconds: 2.4 }).body.price_usd).toBe(2.95152);
        expect(quote({ reference_videos: ["https://x/a.mp4"] }).body).toMatchObject({ price_usd: 12.9129, priced: { reference_video_seconds: 30 } });
        expect(quote({ seconds: 5 }).body).toMatchObject({ error: { message: "reference video seconds need reference_videos" } });
        expect(quote({ reference_videos: ["https://x/a.mp4"], seconds: 31 }).body).toMatchObject({ error: { message: "reference videos must total 2-30 seconds" } });
        expect(quote({ reference_videos: ["https://x/a.mp4"], image: "https://x/a.png" }).status).toBe(400);
        expect(fakeQuote({ model: "seedance-2-mini", duration: 5, reference_videos: ["https://x/a.mp4"] }).body).toMatchObject({ error: { message: expect.stringMatching(/^reference_videos.*not a field of seedance-2-mini/) } });
        expect(fakeMp4Facts(Buffer.from(mp4(4.6, 1280, 720)))).toEqual({ seconds: 4.6, width: 1280, height: 720 });
    });
});
