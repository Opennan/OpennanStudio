import { createJob } from "./job";
import { providerContractCases } from "./testing";
import type { CapabilityOutput } from "./capability-output";
import type { Provider } from "./types";

const transcript = { language: "en", segments: [] };

describe("providerContractCases", () => {
    it("passes a well-formed provider", async () => {
        const provider: Provider = {
            info: { id: "fake", name: "Fake", capabilities: ["audio.transcribe"] },
            audio: { transcribe: () => createJob(() => new Promise<typeof transcript>(() => undefined)) },
        };
        const cases = providerContractCases(provider);
        expect(cases.map((c) => c.name)).toHaveLength(3);
        for (const c of cases) await c.run();
    });

    it("fails a provider that declares audio.transcribe without the method", async () => {
        const provider: Provider = { info: { id: "fake", name: "Fake", capabilities: ["audio.transcribe"] } };
        const results = await Promise.allSettled(providerContractCases(provider).map((c) => c.run()));
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    });

    it("fails a provider that claims an OpenNan capability", async () => {
        const provider: Provider = { info: { id: "fal", name: "fal", capabilities: ["opennan.qc"] } };
        await expect(providerContractCases(provider)[1].run()).rejects.toThrow(/only "opennan"/);
    });

    it("fails a Job that rejects with a plain error", async () => {
        const provider: Provider = {
            info: { id: "fake", name: "Fake", capabilities: ["audio.transcribe"] },
            audio: {
                transcribe: () => ({
                    id: "j", status: async () => "failed" as const, cancel: async () => undefined,
                    result: async () => { throw new TypeError("boom"); },
                }),
            },
        };
        await expect(providerContractCases(provider)[2].run()).rejects.toThrow(/SDK error, got TypeError/);
    });
});

describe("providerContractCases: run", () => {
    it("checks run() jobs of providers that have run", async () => {
        const { createJob } = await import("./job");
        const good = providerContractCases({
            info: { id: "fal", name: "fal", capabilities: ["image.generate"] },
            run: () => createJob(() => new Promise(() => undefined)),
        });
        expect(good.map((c) => c.name)).toContain("run returns a Job that can be cancelled");
        for (const c of good) await c.run();
        const bad = providerContractCases({
            info: { id: "fal", name: "fal", capabilities: ["image.generate"] },
            run: () => { throw new Error("boom"); },
        });
        await expect(bad.find((c) => c.name.startsWith("run"))!.run()).rejects.toThrow(/may only throw CapabilityUnavailableError/);
    });
});

describe("providerContractCases: phase 11", () => {
    const hanging = () => createJob<CapabilityOutput>(() => new Promise(() => undefined));

    it("adds a cancellable-job case for each media tool a provider declares", async () => {
        const cases = providerContractCases({
            info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "captions.translate", "audio.isolate-voice", "video.upscale", "video.lipsync", "audio.separate", "video.remove-background"] },
            run: hanging,
        });
        const names = cases.map((c) => c.name);
        for (const capability of ["captions.translate", "audio.isolate-voice", "video.upscale", "video.lipsync", "audio.separate", "video.remove-background"]) {
            expect(names).toContain(`${capability}: run returns a Job that can be cancelled`);
        }
        for (const c of cases) await c.run();
    });

    it("fails opennan declaring a local-only capability", async () => {
        const cases = providerContractCases({ info: { id: "opennan", name: "OpenNan", capabilities: ["media.stabilize"] } });
        await expect(cases[1]!.run()).rejects.toThrow(/media\.stabilize/);
    });

    it("checks the shape of price() answers", async () => {
        const good = providerContractCases({
            info: { id: "fal", name: "fal", capabilities: ["image.generate"] }, run: hanging,
            price: async () => ({ kind: "billed-elsewhere", by: "fal.ai" }),
        });
        const priceCase = good.find((c) => c.name.startsWith("price"));
        expect(priceCase).toBeDefined();
        await priceCase!.run();
        for (const answer of [
            { kind: "estimate", estimate: { microUsd: 5001, usd: 0.005001, label: "≈ $0.006", units: 1, capped: false } },
            { kind: "free" }, { kind: "unknown" }, { kind: "unavailable", reason: "Soon." }, { kind: "over-limit", limit: { kind: "seconds", max: 60, actual: 61 } },
        ]) {
            const cases = providerContractCases({ info: { id: "x", name: "x", capabilities: ["image.generate"] }, price: async () => answer as never });
            await cases.find((c) => c.name.startsWith("price"))!.run();
        }
        for (const answer of [{ kind: "estimate", estimate: { label: 3 } }, { kind: "billed-elsewhere" }, { kind: "cheap" }, null]) {
            const cases = providerContractCases({ info: { id: "x", name: "x", capabilities: ["image.generate"] }, price: async () => answer as never });
            await expect(cases.find((c) => c.name.startsWith("price"))!.run()).rejects.toThrow(/PriceAnswer/);
        }
        const throwing = providerContractCases({ info: { id: "x", name: "x", capabilities: ["image.generate"] }, price: async () => { throw new Error("offline"); } });
        await expect(throwing.find((c) => c.name.startsWith("price"))!.run()).rejects.toThrow(/must not reject/);
    });
});
