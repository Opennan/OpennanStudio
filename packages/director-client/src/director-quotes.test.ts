import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest } from "@opennan/cloud-backend";
import { pipelineRequest } from "./director-pipelines";
import { createQuotes, formatUsdExact, formatUsdNear, formatUsdUp, QUOTE_UNSUPPORTED_MS, TOOL_QUOTE_MS, TURN_QUOTE_MS } from "./director-quotes";

function fakeApi(answer: (body: Record<string, unknown>) => unknown) {
    const calls: Array<Record<string, unknown>> = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(_method: CloudMethod, _path: string, request?: CloudRequest) {
            calls.push(request?.body as Record<string, unknown>);
            return { status: 200, body: (await answer(request?.body as Record<string, unknown>)) as T, etag: null };
        },
    };
    return { api, calls };
}

const TURN_QUOTE = { object: "quote", tool: "director-turn", price_usd: 0.429, hold_usd: 0.429, priced: { rounds: 6, tool_calls: 10, typical_usd: 0.078 } };

describe("createQuotes", () => {
    it("reads a turn's hold and typical price and keeps it 10 minutes", async () => {
        let t = 0;
        const { api, calls } = fakeApi(() => TURN_QUOTE);
        const quotes = createQuotes(api, { now: () => t });
        expect(await quotes.turn()).toEqual({ holdUsd: 0.429, typicalUsd: 0.078, limits: expect.objectContaining({ rounds: 6, toolCalls: 10 }) });
        expect(calls).toEqual([{ tool: "director-turn" }]);
        t = TURN_QUOTE_MS - 1;
        await quotes.turn();
        expect(calls).toHaveLength(1);
        t = TURN_QUOTE_MS + 1;
        await quotes.turn();
        expect(calls).toHaveLength(2);
    });

    it("an older server (404) answers null and is not asked again for a while; a typical above the hold is capped", async () => {
        let t = 0;
        let mode: "404" | "odd" = "404";
        const { api, calls } = fakeApi(() => {
            if (mode === "404") throw new CloudApiError(404, "not_found", "Not Found");
            return { price_usd: 0.2, hold_usd: 0.2, priced: { typical_usd: 0.5 } };
        });
        const quotes = createQuotes(api, { now: () => t });
        expect(await quotes.turn()).toBeNull();
        t = QUOTE_UNSUPPORTED_MS - 1;
        expect(await quotes.turn()).toBeNull();
        expect(calls).toHaveLength(1);
        mode = "odd";
        t = QUOTE_UNSUPPORTED_MS + 1;
        expect(await quotes.turn()).toMatchObject({ holdUsd: 0.2, typicalUsd: 0.2 });
    });

    it("a network failure is not cached", async () => {
        let fail = true;
        const { api, calls } = fakeApi(() => {
            if (fail) throw new CloudApiError(0, "network", "x");
            return TURN_QUOTE;
        });
        const quotes = createQuotes(api);
        expect(await quotes.turn()).toBeNull();
        fail = false;
        expect(await quotes.turn()).toMatchObject({ holdUsd: 0.429 });
        expect(calls).toHaveLength(2);
    });

    it("quotes a pipeline request with its own body, cached per body for 60 s and shared in flight", async () => {
        let t = 0;
        const { api, calls } = fakeApi((body) => ({ price_usd: body.scene_id === "s1" ? 0.31 : 0.62, hold_usd: body.scene_id === "s1" ? 0.31 : 0.62 }));
        const quotes = createQuotes(api, { now: () => t });
        const request = pipelineRequest("storyboard", "p1", { sceneId: "s1" });
        const [a, b] = await Promise.all([quotes.tool(request), quotes.tool(pipelineRequest("storyboard", "p1", { sceneId: "s1" }))]);
        expect(a).toEqual({ kind: "quote", priceUsd: 0.31, holdUsd: 0.31 });
        expect(b).toEqual(a);
        expect(calls).toEqual([{ tool: "storyboard", project_id: "p1", scene_id: "s1" }]);
        expect(await quotes.tool(pipelineRequest("storyboard", "p1", { sceneId: "s2" }))).toMatchObject({ priceUsd: 0.62 });
        t = TOOL_QUOTE_MS + 1;
        await quotes.tool(request);
        expect(calls).toHaveLength(3);
        await quotes.tool(request, { fresh: true });
        expect(calls).toHaveLength(4);
    });

    it("a refusal answers its reason; an outage answers unavailable; neither is cached", async () => {
        let mode: "400" | "503" | "ok" = "400";
        const { api, calls } = fakeApi(() => {
            if (mode === "400") throw new CloudApiError(400, "invalid_request", "srt_content: add subtitles first", { fromServer: true });
            if (mode === "503") throw new CloudApiError(503, "unavailable", "down");
            return { price_usd: 0.2, hold_usd: 0.25 };
        });
        const quotes = createQuotes(api);
        const request = pipelineRequest("story-scenes", "p1");
        expect(await quotes.tool(request)).toEqual({ kind: "refused", code: "invalid_request", message: "srt_content: add subtitles first" });
        mode = "503";
        expect(await quotes.tool(request)).toEqual({ kind: "unavailable" });
        mode = "ok";
        expect(await quotes.tool(request)).toEqual({ kind: "quote", priceUsd: 0.2, holdUsd: 0.25 });
        expect(calls).toHaveLength(3);
    });
});

describe("money formats", () => {
    it("rounds every price, typical figure and charge up (phase 9c: never shown under)", () => {
        expect(formatUsdUp(0.429)).toBe("$0.43");
        expect(formatUsdUp(0.3)).toBe("$0.30");
        expect(formatUsdUp(0.301)).toBe("$0.31");
        expect(formatUsdNear(0.078)).toBe("$0.08");
        expect(formatUsdNear(0.071)).toBe("$0.08");
        expect(formatUsdNear(0.07)).toBe("$0.07");
        expect(formatUsdExact(0.026)).toBe("$0.026");
        expect(formatUsdExact(0.0261)).toBe("$0.027");
        expect(formatUsdExact(0)).toBe("$0.00");
        expect(formatUsdExact(1.2345)).toBe("$1.24");
        expect(formatUsdExact(1.2)).toBe("$1.20");
        expect(formatUsdExact(0.0004)).toBe("$0.001");
    });

    it("never shows an amount under what it is, and at most one unit over (5,000 random amounts)", () => {
        let seed = 7;
        const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
        for (let i = 0; i < 5_000; i++) {
            const usd = Math.round(random() * (i % 2 ? 30 : 1.5) * 1_000_000) / 1_000_000;
            for (const [format, unit] of [[formatUsdUp, 0.01], [formatUsdNear, 0.01], [formatUsdExact, usd >= 1 ? 0.01 : 0.001]] as const) {
                const shown = Number(format(usd).slice(1));
                expect(shown + 1e-9, `${format.name}(${usd})`).toBeGreaterThanOrEqual(usd);
                expect(shown - usd, `${format.name}(${usd})`).toBeLessThanOrEqual(unit + 1e-9);
            }
        }
    });
});
