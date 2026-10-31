// A scripted TimelineAiHost for tests (phase 11): tool views per tool id (or a function of the params), a mutable job
// list, and every call recorded. change() bumps the version and notifies, like a price that finished loading.
import { vi } from "vitest";
import type { AiToolId, AiToolParams } from "@opennan/timeline-core";
import type { AiJobView, AiToolView, TimelineAiHost } from "../ai/ai-host";

export type FakeToolViews = Partial<Record<AiToolId, Partial<AiToolView> | ((params: AiToolParams) => Partial<AiToolView>)>>;

export interface FakeAiHost extends TimelineAiHost {
    views: FakeToolViews;
    jobList: AiJobView[];
    run: ReturnType<typeof vi.fn<(toolId: AiToolId, params: AiToolParams) => void>>;
    tool: ReturnType<typeof vi.fn<(toolId: AiToolId, params: AiToolParams) => AiToolView>>;
    cancel: ReturnType<typeof vi.fn<(jobId: string) => void>>;
    retry: ReturnType<typeof vi.fn<(jobId: string) => void>>;
    dismiss: ReturnType<typeof vi.fn<(jobId: string) => void>>;
    change(): void;
}

export function fakeAiHost(views: FakeToolViews = {}, extra: Partial<Pick<TimelineAiHost, "openGenerate" | "openAutoCaptions" | "openStoryFilm">> = {}): FakeAiHost {
    const listeners = new Set<() => void>();
    let version = 0;
    const host: FakeAiHost = {
        views,
        jobList: [],
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        version: () => version,
        tool: vi.fn((toolId: AiToolId, params: AiToolParams): AiToolView => {
            const entry = host.views[toolId];
            const patch = typeof entry === "function" ? entry(params) : entry ?? {};
            return { id: toolId, state: "ready", price: { kind: "estimate", label: "≈ $0.05", usd: 0.05 }, ...patch };
        }),
        run: vi.fn(),
        jobs: () => host.jobList,
        cancel: vi.fn(),
        retry: vi.fn(),
        dismiss: vi.fn(),
        change() {
            version += 1;
            for (const listener of [...listeners]) listener();
        },
        ...extra,
    };
    return host;
}
