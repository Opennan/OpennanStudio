import {
    BILLING_SAFETY, captionBilledCharacters, estimateImageCost, estimateMusicCost, estimateSoundEffectCost, estimateStemsCost, estimateToolCost,
    estimateVideoModelCost, estimateReferenceVideoCost, referenceBilledSeconds, estimateVoiceCost, estimateTextCost, promptTokenBound, formatUsdEstimate, isOverLimit, startedUnits, toMicroUsd, type ToolPriceBlock,
} from "./prices";

const TRANSCRIBE: ToolPriceBlock = { unit: "source_minute", per: "minute", usd: 0.004768, max_minutes: 30 };
const ISOLATION: ToolPriceBlock = { unit: "source_minute", per: "minute", usd: 0.13, max_minutes: 10 };
const UPSCALE: ToolPriceBlock = {
    unit: "video_second", per: "second", usd: 0.00936, max_seconds: 60,
    tiers: [{ resolution: "1080p", usd: 0.00936 }, { resolution: "2k", usd: 0.01872 }, { resolution: "4k", usd: 0.03744 }],
};
const TRANSLATE: ToolPriceBlock = {
    unit: "thousand_characters", per: "1000 characters", usd: 0.00591, max_characters: 30_000, max_segments: 2_000, segment_overhead_characters: 10,
};
const MATTING: ToolPriceBlock = { unit: "video_second", per: "second", usd: 0.0026, max_seconds: 120 };
const LIPSYNC: ToolPriceBlock = { unit: "audio_second", per: "second", usd: 0.013, max_seconds: 60 };
const SFX: ToolPriceBlock = { unit: "sound_second", per: "second", usd: 0.0026, max_seconds: 22, max_usd: 0.0572 };

function estimate(block: ToolPriceBlock, units: Parameters<typeof estimateToolCost>[1]) {
    const answer = estimateToolCost(block, units);
    if (answer === null || isOverLimit(answer)) throw new Error(`expected an estimate, got ${JSON.stringify(answer)}`);
    return answer;
}

describe("startedUnits", () => {
    it("adds the decoded-length margin before rounding up, so a boundary never undercounts", () => {
        expect(startedUnits(59.4, 60)).toBe(1);
        expect(startedUnits(59.6, 60)).toBe(2);
        expect(startedUnits(60, 60)).toBe(2);
        expect(startedUnits(0.01, 60)).toBe(1);
        expect(startedUnits(9.5, 1)).toBe(10);
        expect(startedUnits(9.76, 1)).toBe(11);
        expect(startedUnits(0, 1)).toBe(1);
        expect(BILLING_SAFETY).toEqual({ seconds: 0.25, ratio: 0.005 });
    });

    it("never counts fewer units than the server's ceil(round(seconds, 3) / unit) on the same length", () => {
        for (let ms = 1; ms <= 180_000; ms += 7) {
            const seconds = ms / 1000;
            const server = Math.max(1, Math.ceil(Math.round(seconds * 1000) / 1000 / 60));
            expect(startedUnits(seconds, 60)).toBeGreaterThanOrEqual(server);
        }
    });
});

describe("estimateToolCost", () => {
    it("prices started minutes of the source (transcribe, isolation)", () => {
        expect(estimate(TRANSCRIBE, { seconds: 20 })).toMatchObject({ units: 1, microUsd: 4769, label: "≈ $0.005", capped: false });
        expect(estimate(ISOLATION, { seconds: 125 })).toMatchObject({ units: 3, label: "≈ $0.391" });
    });

    it("caps at the block's maximum (the server's hold, which it never settles above) and reports over-limit past it", () => {
        expect(estimate(TRANSCRIBE, { seconds: 1799 })).toMatchObject({ units: 30, capped: true });
        expect(estimateToolCost(TRANSCRIBE, { seconds: 1801 })).toEqual({ kind: "seconds", max: 1800, actual: 1801 });
        expect(estimate(ISOLATION, { seconds: 600 })).toMatchObject({ units: 10, capped: true, label: "≈ $1.31" });
        expect(estimateToolCost(MATTING, { seconds: 121 })).toEqual({ kind: "seconds", max: 120, actual: 121 });
    });

    it("prices upscale per started second at the asked tier", () => {
        expect(estimate(UPSCALE, { seconds: 3, resolution: "1080p" })).toMatchObject({ units: 4, microUsd: 4 * 9361 });
        expect(estimate(UPSCALE, { seconds: 3, resolution: "4k" })).toMatchObject({ units: 4, label: "≈ $0.150" });
        expect(estimate(UPSCALE, { seconds: 2.5, resolution: "2k" }).microUsd).toBeGreaterThan(estimate(UPSCALE, { seconds: 2.5, resolution: "1080p" }).microUsd);
        expect(estimateToolCost(UPSCALE, { seconds: 3, resolution: "8k" })).toBeNull();
        expect(estimateToolCost(UPSCALE, { seconds: 59.9, resolution: "1080p" })).toMatchObject({ units: 60, capped: true });
    });

    it("prices caption translation on started thousands of billed characters, exactly", () => {
        const segments = [{ text: "Hello there." }, { text: "How are you?" }];
        expect(captionBilledCharacters(segments)).toBe(12 + 10 + 12 + 10);
        expect(estimate(TRANSLATE, { characters: 44, segments: 2 })).toMatchObject({ units: 1, microUsd: 5911 });
        expect(estimate(TRANSLATE, { characters: 1000, segments: 10 })).toMatchObject({ units: 1 });
        expect(estimate(TRANSLATE, { characters: 1001, segments: 10 })).toMatchObject({ units: 2 });
        expect(estimateToolCost(TRANSLATE, { characters: 30_001 + 20_000, segments: 2001 })).toEqual({ kind: "segments", max: 2000, actual: 2001 });
    });

    it("counts code points like the server (an emoji or a Thai character is one)", () => {
        expect(captionBilledCharacters([{ text: "😀" }])).toBe(11);
        expect(captionBilledCharacters([{ text: "สวัสดี" }])).toBe(6 + 10);
        expect(captionBilledCharacters([{ text: "ab" }], 0)).toBe(2);
    });

    it("prices lip sync per started second of the speech, matting per started video second, SFX per started second", () => {
        expect(estimate(LIPSYNC, { seconds: 4 })).toMatchObject({ units: 5, microUsd: 5 * 13001 });
        expect(estimate(MATTING, { seconds: 10 })).toMatchObject({ units: 11 });
        expect(estimateSoundEffectCost(SFX, 5)).toMatchObject({ units: 5, microUsd: 5 * 2601 });
    });

    it("answers null for a missing block or one it cannot read", () => {
        expect(estimateToolCost(null, { seconds: 1 })).toBeNull();
        expect(estimateToolCost({ unit: "mystery", usd: 1 }, { seconds: 1 })).toBeNull();
        expect(estimateToolCost({ unit: "video_second" }, { seconds: 1 })).toBeNull();
        expect(estimateToolCost(MATTING, {})).toBeNull();
    });
});

describe("rounding allowance", () => {
    it("allows one micro-dollar per billed unit: the server rounds N × its unit cost once, the block publishes the unit rounded", () => {
        // A unit cost of 0.0047673333…$ is published as 0.004768; 30 units bill round6(30 × 0.0047673333) = 0.143020.
        expect(estimate(TRANSCRIBE, { seconds: 1799 })).toMatchObject({ units: 30, microUsd: 30 * 4769 });
        for (let n = 1; n <= 600; n += 1) {
            const unitCost = 0.0047673333333; // more than six decimals
            const published = Math.ceil(unitCost * 1e6) / 1e6;
            const billed = Math.round(n * unitCost * 1e6);
            expect(n * Math.round(published * 1e6) + n).toBeGreaterThanOrEqual(billed);
        }
    });
});

describe("model estimates", () => {
    it("images: from_usd plus each input image (a call without quality or size is charged from_usd)", () => {
        expect(estimateImageCost({ from_usd: 0.039, per_input_image_usd: 0.002 }, 1)).toMatchObject({ microUsd: 41001, label: "≈ $0.042" });
        expect(estimateImageCost({ from_usd: 0.039 }, 0)).toMatchObject({ microUsd: 39001 });
        expect(estimateImageCost(null, 0)).toBeNull();
    });

    it("video: the worst per-second price among the model's rows times the asked duration", () => {
        const price = { from_usd: 0.4, matrix: [{ ours_usd: 0.4, duration: 5, ours_usd_per_second: 0.08 }, { ours_usd: 1.2, duration: 5, ours_usd_per_second: 0.24 }] };
        // Per second from the row's own price, rounded up (the published per-second figure is rounded to the nearest
        // micro-dollar), plus a micro-dollar a second.
        expect(estimateVideoModelCost(price, 5)).toMatchObject({ microUsd: 1_200_005, label: "≈ $1.21" });
        expect(estimateVideoModelCost(price, 10)).toMatchObject({ microUsd: 2_400_010 });
        expect(estimateVideoModelCost({ matrix: [{ ours_usd: 0.7, duration: 3, ours_usd_per_second: 0.233333 }] }, 3)!.microUsd).toBeGreaterThanOrEqual(700_000);
        expect(estimateVideoModelCost({ from_usd: 0.5 }, 5)).toBeNull();
    });

    it("image: a sent size or quality prices the worst matching tier, plus each input image", () => {
        const price = {
            from_usd: 0.05, per_input_image_usd: 0.002,
            tiers: [{ quality: null, size: "1K", usd: 0.05 }, { quality: null, size: "2K", usd: 0.05 }, { quality: null, size: "4K", usd: 0.09 }, { quality: "high", size: "2K", usd: 0.07 }],
        };
        expect(estimateImageCost(price, 3, { size: "2K" })).toMatchObject({ microUsd: 70_000 + 6_000 + 1 });
        expect(estimateImageCost(price, 0, { size: "4K" })).toMatchObject({ microUsd: 90_001 });
        expect(estimateImageCost(price, 0, { quality: "high", size: "2K" })).toMatchObject({ microUsd: 70_001 });
        expect(estimateImageCost(price, 0, { size: "8K" })).toBeNull();
        expect(estimateImageCost({ from_usd: 0.05 }, 0, { size: "2K" })).toBeNull();
    });

    it("video: the call's quality and sound choice narrow the rows that price it", () => {
        const price = { matrix: [{ quality: "720p", duration: 5, ours_usd: 0.25, audio: false }, { quality: "1080p", duration: 5, ours_usd: 0.6, audio: false }, { quality: "720p", duration: 5, ours_usd: 0.4, audio: true }] };
        expect(estimateVideoModelCost(price, 5, { quality: "720p", audio: false })).toMatchObject({ microUsd: 250_005 });
        expect(estimateVideoModelCost(price, 5, { quality: "720p" })).toMatchObject({ microUsd: 400_005 });
        expect(estimateVideoModelCost(price, 5)).toMatchObject({ microUsd: 600_005 });
        expect(estimateVideoModelCost(price, 5, { quality: "4k" })).toBeNull();
    });

    it("text: the prompt bound at the input price plus max_tokens at the output price, never under", () => {
        const price = { input_usd: 3, output_usd: 15 };
        expect(estimateTextCost(price, { promptTokens: 10_000, maxTokens: 4_000 })).toMatchObject({ microUsd: 30_000 + 60_000 + 1, label: "≈ $0.091" });
        expect(estimateTextCost({ input_usd: 3 }, { promptTokens: 1, maxTokens: 1 })).toBeNull();
        expect(estimateTextCost(price, { promptTokens: 1, maxTokens: 0 })).toBeNull();
        // Every character a token, eight a message, 32 a call, each image at its maximum.
        expect(promptTokenBound(["abc", "héllo"], 2, 1000)).toBe(3 + 5 + 16 + 32 + 2000);
    });

    it("voice: started 1,000-character blocks at the block price", () => {
        expect(estimateVoiceCost({ billing_block_characters: 1000, minimum_usd: 0.026 }, 45)).toMatchObject({ units: 1, microUsd: 26001 });
        expect(estimateVoiceCost({ billing_block_characters: 1000, minimum_usd: 0.026 }, 2500)).toMatchObject({ units: 3, microUsd: 3 * 26001 });
        expect(estimateVoiceCost({ billing_block_characters: 1000, minimum_usd: 0.026 }, 1001)).toMatchObject({ units: 2 });
        expect(estimateVoiceCost({ minimum_usd: 0.026 }, 10)).toBeNull();
    });

    it("music: from_usd is a minute; stems: max(minimum, base + per minute × minutes with the margin)", () => {
        expect(estimateMusicCost({ from_usd: 0.0156 }, 30)).toMatchObject({ microUsd: 7801 });
        expect(estimateStemsCost({ minimum_usd: 0.01, base_usd: 0.0115, per_minute_usd: 0.0023 }, 180)).toMatchObject({ label: "≈ $0.019" });
        expect(estimateStemsCost({ minimum_usd: 0.01, base_usd: 0.002, per_minute_usd: 0.001 }, 10)).toMatchObject({ microUsd: 10_001 });
    });
});

describe("formatUsdEstimate", () => {
    it("rounds up: three decimals under $1, two from $1", () => {
        expect(formatUsdEstimate(4_768)).toBe("≈ $0.005");
        expect(formatUsdEstimate(5_000)).toBe("≈ $0.005");
        expect(formatUsdEstimate(5_001)).toBe("≈ $0.006");
        expect(formatUsdEstimate(1)).toBe("≈ $0.001");
        expect(formatUsdEstimate(999_999)).toBe("≈ $1.00");
        expect(formatUsdEstimate(1_250_100)).toBe("≈ $1.26");
        expect(formatUsdEstimate(2_246_400)).toBe("≈ $2.25");
        expect(formatUsdEstimate(0)).toBe("≈ $0.000");
    });

    it("converts dollars to micro-dollars without float drift", () => {
        expect(toMicroUsd(0.004768)).toBe(4768);
        expect(toMicroUsd(0.00936)).toBe(9360);
        expect(toMicroUsd(0.1 + 0.2)).toBe(300000);
    });
});

describe("displayedUsd (phase 11: what the user agreed to)", () => {
    it("is the label's rounded-up amount, so a re-check against it accepts anything the label covers", async () => {
        const { displayedUsd } = await import("./prices");
        expect(displayedUsd(4_769)).toBe(0.005);
        expect(displayedUsd(18_445)).toBe(0.019);
        expect(displayedUsd(1_300_001)).toBe(1.31);
        expect(displayedUsd(1_000_000)).toBe(1);
    });
});

describe("quotedEstimate (phase 11.1: POST /v1/quotes)", () => {
    it("is the quote's settle amount with the hold kept, rounded up for the label, marked as a quote", async () => {
        const { quotedEstimate } = await import("./prices");
        const quote = quotedEstimate({ priceUsd: 0.4, holdUsd: 0.4, units: 5 });
        expect(quote).toEqual({ microUsd: 400_000, usd: 0.4, label: "≈ $0.400", units: 5, capped: false, source: "quote", holdUsd: 0.4 });
        const tool = quotedEstimate({ priceUsd: 0.0047681, holdUsd: 0.14304, units: 1 });
        expect(tool.microUsd).toBe(4_769);
        expect(tool.label).toBe("≈ $0.005");
        expect(tool.holdUsd).toBe(0.14304);
        expect(tool.capped).toBe(false);
        expect(quotedEstimate({ priceUsd: 0.13, holdUsd: 0.13, units: 1, capped: true }).capped).toBe(true);
    });

    it("never holds less than it settles", async () => {
        const { quotedEstimate } = await import("./prices");
        expect(quotedEstimate({ priceUsd: 0.5, holdUsd: 0.2, units: 1 }).holdUsd).toBe(0.5);
    });
});

describe("paddedSeconds (the decode margin a per-unit quote is asked with)", () => {
    it("adds 0.25 s + 0.5 % and rounds up to the millisecond, capped at the tool's maximum", async () => {
        const { paddedSeconds } = await import("./prices");
        expect(paddedSeconds(10)).toBe(10.3);
        expect(paddedSeconds(59.6)).toBe(60.148);
        expect(paddedSeconds(59.9, 60)).toBe(60);
        expect(paddedSeconds(0)).toBe(0.25);
        // Never below what it pads.
        for (let s = 0; s < 700; s += 0.0137) expect(paddedSeconds(s)).toBeGreaterThanOrEqual(s + BILLING_SAFETY.seconds + s * BILLING_SAFETY.ratio - 1e-9);
    });
});

describe("reference video prices", () => {
    // Seedance 2.5 as GET /v1/models publishes it (2026-10-31): one row per quality and reference length, 4 s output.
    const ROWS = [
        { quality: "480p", duration: 4, reference_video_seconds: 2, usd: 1.03194 },
        { quality: "480p", duration: 4, reference_video_seconds: 30, usd: 5.84766 },
        { quality: "720p", duration: 4, reference_video_seconds: 2, usd: 2.21364 },
        { quality: "720p", duration: 4, reference_video_seconds: 5, usd: 3.32046 },
        { quality: "720p", duration: 4, reference_video_seconds: 30, usd: 12.54396 },
        { quality: "1080p", duration: 4, reference_video_seconds: 2, usd: 5.44752 },
    ];

    it("bills output and reference seconds at the quality's per-second price, never under the live quote", () => {
        // The live quote of a 5 s shot with a 5 s reference at 720p: $3.6894 (10 s × $0.36894).
        const shot = estimateReferenceVideoCost(ROWS, 5, 5, "720p")!;
        expect(shot.microUsd).toBe(3_689_410);
        expect(shot.microUsd).toBeGreaterThanOrEqual(3_689_400);
        expect(shot.label).toBe("≈ $3.69");
        // A quote with 3 billed reference seconds answers $2.95152.
        expect(estimateReferenceVideoCost(ROWS, 5, 3, "720p")!.microUsd).toBeGreaterThanOrEqual(2_951_520);
        expect(estimateReferenceVideoCost(ROWS, 4, 30, "480p")!.microUsd).toBeGreaterThanOrEqual(5_847_660);
        expect(estimateReferenceVideoCost(ROWS, 5, 5, "4k")).toBeNull();
        expect(estimateReferenceVideoCost([], 5, 5, "720p")).toBeNull();
    });

    it("rounds the reference length up with the decode margin, inside the model's limits; unknown is the most it takes", () => {
        const limits = { minSeconds: 2, totalSeconds: 30 };
        expect(referenceBilledSeconds(2.4, limits)).toBe(3);
        expect(referenceBilledSeconds(4.6, limits)).toBe(5);
        expect(referenceBilledSeconds(5, limits)).toBe(6);
        expect(referenceBilledSeconds(1, limits)).toBe(2);
        expect(referenceBilledSeconds(29.9, limits)).toBe(30);
        expect(referenceBilledSeconds(undefined, limits)).toBe(30);
        // Never under the server's ceil of the length it decodes (a few ms past the container's).
        for (let ms = 2000; ms <= 29_000; ms += 37) expect(referenceBilledSeconds(ms / 1000, limits)).toBeGreaterThanOrEqual(Math.ceil((ms + 5) / 1000));
    });
});
