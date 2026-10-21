import { act, fireEvent, screen } from "@testing-library/react";
import { DEFAULT_TRANSLATE } from "../i18n/format";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { fakeAiHost } from "../test-utils/fake-ai-host";
import type { AiJobView } from "./ai-host";
import { AiJobTray } from "./ai-job-tray";

const job = (id: string, patch: Partial<AiJobView>): AiJobView => ({ id, toolId: "voice-isolation", label: `Isolate voice · ${id}`, status: "queued", cancellable: true, canRetry: false, ...patch });

describe("AiJobTray", () => {
    it("renders nothing without a host or without jobs", () => {
        const empty = renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE, ai: fakeAiHost() });
        expect(empty.container.querySelector(".on-ai-tray")).toBeNull();
        empty.unmount();
        const none = renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE });
        expect(none.container.querySelector(".on-ai-tray")).toBeNull();
    });

    it("shows queued and preparing jobs with a refunded cancel, running ones with stage, percent, and a bar", () => {
        const host = fakeAiHost();
        host.jobList = [
            job("a", { status: "queued" }),
            job("b", { status: "preparing", stage: "Uploading", progress: 0.25 }),
            job("c", { status: "running", stage: "Isolating", progress: 0.5 }),
        ];
        renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE, ai: host });
        expect(screen.getByTestId("ai-job-a").textContent).toContain("Queued");
        expect(screen.getByTestId("ai-job-a-cancel").textContent).toBe("Cancel · refunded");
        expect(screen.getByTestId("ai-job-b").textContent).toContain("Uploading · 25%");
        expect(screen.getByTestId("ai-job-b-cancel").textContent).toBe("Cancel · refunded");
        expect(screen.getByTestId("ai-job-c").textContent).toContain("Isolating · 50%");
        expect(screen.getByRole("progressbar", { name: "Isolate voice · c progress" }).getAttribute("aria-valuenow")).toBe("50");
        fireEvent.click(screen.getByRole("button", { name: "Cancel Isolate voice · c" }));
        expect(host.cancel).toHaveBeenCalledWith("c");
    });

    it("drops Cancel once the paid step started and says it will be charged", () => {
        const host = fakeAiHost();
        host.jobList = [job("a", { status: "running", stage: "Isolating", progress: 0.6 })];
        renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE, ai: host });
        expect(screen.getByTestId("ai-job-a-cancel")).toBeTruthy();
        host.jobList = [job("a", { status: "running", stage: "Isolating", progress: 0.7, cancellable: false })];
        act(() => host.change());
        expect(screen.queryByTestId("ai-job-a-cancel")).toBeNull();
        expect(screen.getByTestId("ai-job-a-charging").textContent).toBe("Already running: it will finish and be charged.");
    });

    it("failed: the error, the refund, Retry and Dismiss", () => {
        const host = fakeAiHost();
        host.jobList = [job("a", { status: "failed", cancellable: false, error: "The provider failed.", refunded: true, canRetry: true })];
        renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE, ai: host });
        expect(screen.getByRole("alert").textContent).toBe("The provider failed. You were not charged.");
        fireEvent.click(screen.getByTestId("ai-job-a-retry"));
        expect(host.retry).toHaveBeenCalledWith("a");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss Isolate voice · a" }));
        expect(host.dismiss).toHaveBeenCalledWith("a");
        expect(screen.queryByTestId("ai-job-a-cancel")).toBeNull();
    });

    it("succeeded: Done with what it cost; cancelled: its message", () => {
        const host = fakeAiHost();
        host.jobList = [
            job("a", { status: "succeeded", cancellable: false, costUsd: 0.13, progress: 1 }),
            job("b", { status: "cancelled", cancellable: false, message: "Cancelled. You were not charged." }),
            job("c", { status: "succeeded", cancellable: false }),
        ];
        renderWithTimeline(<AiJobTray />, { translate: DEFAULT_TRANSLATE, ai: host });
        expect(screen.getByTestId("ai-job-a").textContent).toContain("Done");
        expect(screen.getByTestId("ai-job-a-cost").textContent).toBe("$0.13 charged");
        expect(screen.queryByTestId("ai-job-c-cost")).toBeNull();
        expect(screen.getByTestId("ai-job-b").textContent).toContain("Cancelled. You were not charged.");
        expect(screen.getByTestId("ai-job-b-dismiss")).toBeTruthy();
        expect(screen.queryByRole("progressbar")).toBeNull();
    });

    it("inline, shows only the jobs on one item", () => {
        const host = fakeAiHost();
        host.jobList = [job("a", { targetId: "c1" }), job("b", { targetId: "c2" })];
        renderWithTimeline(<AiJobTray targetId="c1" />, { translate: DEFAULT_TRANSLATE, ai: host });
        expect(screen.getByTestId("ai-job-tray-inline")).toBeTruthy();
        expect(screen.getByTestId("ai-job-a")).toBeTruthy();
        expect(screen.queryByTestId("ai-job-b")).toBeNull();
    });
});
