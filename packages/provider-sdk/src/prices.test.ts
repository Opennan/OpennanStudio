import {
    BILLING_SAFETY, captionBilledCharacters, estimateImageCost, estimateMusicCost, estimateSoundEffectCost, estimateStemsCost, estimateToolCost,
    estimateVideoModelCost, estimateVoiceCost, formatUsdEstimate, isOverLimit, startedUnits, toMicroUsd, type ToolPriceBlock,
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
