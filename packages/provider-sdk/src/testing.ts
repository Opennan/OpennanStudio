// The shared Provider contract (spec §11): framework-free cases every adapter's test suite runs.
//   for (const c of providerContractCases(provider)) it(c.name, c.run);
import { isLocalOnlyCapability, isOpenNanCapability, isProviderCapability, type ProviderCapability } from "./capabilities";
import { CapabilityUnavailableError, JobCancelledError, JobFailedError } from "./errors";
import { OPENNAN_PROVIDER_ID } from "./registry";
import type { PriceAnswer, Provider } from "./types";

export interface ProviderContractCase {
    name: string;
    run(): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Provider contract: ${message}`);
}

const STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

/** Phase 11 media tools: each one a provider declares gets its own cancellable-job case. */
const MEDIA_TOOLS: readonly ProviderCapability[] = [
    "captions.translate", "audio.isolate-voice", "video.upscale", "video.remove-background", "video.lipsync", "audio.separate",
];

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

/** Whether a value is a well-formed PriceAnswer. */
function isPriceAnswer(value: unknown): value is PriceAnswer {
    if (typeof value !== "object" || value === null) return false;
    const answer = value as Record<string, unknown>;
    switch (answer.kind) {
        case "estimate": {
            const estimate = answer.estimate as Record<string, unknown> | null;
            return typeof estimate === "object" && estimate !== null && isNumber(estimate.microUsd) && isNumber(estimate.usd) && typeof estimate.label === "string"
                && isNumber(estimate.units) && typeof estimate.capped === "boolean";
        }
        case "free":
        case "unknown":
            return answer.reason === undefined || typeof answer.reason === "string";
        case "billed-elsewhere":
            return typeof answer.by === "string" && answer.by !== "";
        case "unavailable":
            return typeof answer.reason === "string" && answer.reason !== "";
        case "over-limit": {
            const limit = answer.limit as Record<string, unknown> | null;
            return typeof limit === "object" && limit !== null && ["seconds", "characters", "segments"].includes(String(limit.kind)) && isNumber(limit.max) && isNumber(limit.actual);
        }
        default:
            return false;
    }
}

async function checkCancellableRun(provider: Provider, capability: ProviderCapability): Promise<void> {
    let job;
    try {
        job = provider.run!({ capability, input: {} });
    } catch (error) {
        check(error instanceof CapabilityUnavailableError, `run() may only throw CapabilityUnavailableError, got ${error instanceof Error ? error.name : typeof error}`);
        return;
    }
    check(typeof job.id === "string" && job.id !== "", "Job.id must be a non-empty string");
    check(STATUSES.has(await job.status()), "Job.status() must be a JobStatus");
    await job.cancel();
    try {
        await job.result();
    } catch (error) {
        check(
            error instanceof JobCancelledError || error instanceof JobFailedError || error instanceof CapabilityUnavailableError,
            `Job.result() must reject with an SDK error, got ${error instanceof Error ? error.name : typeof error}`,
        );
    }
    check(["cancelled", "failed", "succeeded"].includes(await job.status()), "a cancelled Job must settle");
}

export function providerContractCases(provider: Provider): ProviderContractCase[] {
    const { info } = provider;
    const cases: ProviderContractCase[] = [
        {
            name: "has an id and a name",
            run: async () => {
                check(typeof info.id === "string" && info.id.trim() !== "", "info.id must be a non-empty string");
                check(typeof info.name === "string" && info.name.trim() !== "", "info.name must be a non-empty string");
            },
        },
        {
            name: "declares known capabilities and follows the opennan.* rule",
            run: async () => {
                check(Array.isArray(info.capabilities), "info.capabilities must be an array");
                for (const capability of info.capabilities) {
                    check(isProviderCapability(capability), `unknown capability ${String(capability)}`);
                    check(!isOpenNanCapability(capability) || info.id === OPENNAN_PROVIDER_ID, `only "opennan" may declare ${capability}`);
                    check(!isLocalOnlyCapability(capability) || info.id !== OPENNAN_PROVIDER_ID, `"opennan" may not declare the local-only ${capability}`);
                }
            },
        },
    ];
    if (info.capabilities.includes("audio.transcribe")) {
        cases.push({
            name: "audio.transcribe returns a Job that can be cancelled",
            run: async () => {
                const transcribe = provider.audio?.transcribe;
                check(typeof transcribe === "function", "declares audio.transcribe but has no audio.transcribe()");
                const job = transcribe.call(provider.audio, { audio: { kind: "media", url: "contract:empty" } });
                check(typeof job.id === "string" && job.id !== "", "Job.id must be a non-empty string");
                check(STATUSES.has(await job.status()), "Job.status() must be a JobStatus");
                await job.cancel();
                try {
                    await job.result();
                } catch (error) {
                    check(
                        error instanceof JobCancelledError || error instanceof JobFailedError || error instanceof CapabilityUnavailableError,
                        `Job.result() must reject with an SDK error, got ${error instanceof Error ? error.name : typeof error}`,
                    );
                }
                check(["cancelled", "failed", "succeeded"].includes(await job.status()), "a cancelled Job must settle");
            },
        });
    }
    const runnable = info.capabilities.find((capability) => capability !== "audio.transcribe");
    if (provider.run && runnable) {
        cases.push({ name: "run returns a Job that can be cancelled", run: () => checkCancellableRun(provider, runnable) });
    }
    if (provider.run) {
        for (const capability of MEDIA_TOOLS.filter((c) => info.capabilities.includes(c))) {
            cases.push({ name: `${capability}: run returns a Job that can be cancelled`, run: () => checkCancellableRun(provider, capability) });
        }
    }
    const priced = info.capabilities[0];
    if (provider.price && priced) {
        cases.push({
            name: "price answers a PriceAnswer and never rejects",
            run: async () => {
                let answer: unknown;
                try {
                    answer = await provider.price!({ capability: priced, input: {}, units: {} });
                } catch (error) {
                    throw new Error(`Provider contract: price() must not reject (answer { kind: "unknown" } instead), got ${error instanceof Error ? error.message : String(error)}`);
                }
                check(isPriceAnswer(answer), `price() must answer a PriceAnswer, got ${JSON.stringify(answer)}`);
            },
        });
    }
    return cases;
}
