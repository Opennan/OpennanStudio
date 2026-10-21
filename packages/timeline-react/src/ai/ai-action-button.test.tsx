import { act, fireEvent, screen } from "@testing-library/react";
import { DEFAULT_TRANSLATE } from "../i18n/format";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { fakeAiHost, type FakeAiHost } from "../test-utils/fake-ai-host";
import { AiActionButton } from "./ai-action-button";
import { formatUsd, plainPrice } from "./use-ai";

const params = { clipId: "c1" };

function show(host: FakeAiHost | null, toolId: Parameters<typeof AiActionButton>[0]["toolId"] = "voice-isolation", extra: Partial<Parameters<typeof AiActionButton>[0]> = {}) {
    return renderWithTimeline(<AiActionButton toolId={toolId} params={params} testId="b" {...extra} />, { translate: DEFAULT_TRANSLATE, ai: host });
}

describe("AiActionButton", () => {
    it("shows the estimate on the button, says it in the accessible name, and promises the billing rule", () => {
        const host = fakeAiHost();
        show(host);
        const button = screen.getByRole("button", { name: "Run, about $0.05" });
        expect(button.textContent).toBe("≈ $0.05 · Run");
        expect(screen.getByTestId("b-billing").textContent).toBe("Charged when it finishes. Refunded if it fails.");
        fireEvent.click(button);
        expect(host.run).toHaveBeenCalledWith("voice-isolation", params);
        expect(host.tool).toHaveBeenCalledWith("voice-isolation", params);
    });

    it("reads free, billed elsewhere, and unknown prices", () => {
        const host = fakeAiHost({ silences: { price: { kind: "free" } }, "video-upscale": { price: { kind: "billed-elsewhere", by: "fal.ai" } }, stems: { price: { kind: "unknown" } } });
        const view = show(host, "silences");
        expect(screen.getByRole("button", { name: "Run, free" }).textContent).toBe("Run · free");
        expect(screen.queryByTestId("b-billing")).toBeNull();
        view.unmount();
        const fal = show(host, "video-upscale");
        expect(screen.getByRole("button", { name: "Run, billed by fal.ai" }).textContent).toBe("Billed by fal.ai · Run");
        expect(screen.queryByTestId("b-billing")).toBeNull();
        fal.unmount();
        show(host, "stems");
        expect(screen.getByRole("button", { name: "Run, price unavailable" }).textContent).toBe("Run");
        expect(screen.getByTestId("b-price-unknown").textContent).toBe("Price unavailable");
        expect(screen.getByTestId("b-billing")).toBeTruthy();
    });

    it("follows the host: a loading price becomes the estimate when the host notifies", () => {
        const host = fakeAiHost({ "voice-isolation": { price: { kind: "loading" } } });
        show(host);
        expect(screen.getByTestId("b-run").getAttribute("aria-busy")).toBe("true");
        expect(screen.getByRole("status").textContent).toBe("Checking the price…");
        // A paid tool cannot run before its price is shown.
        expect((screen.getByTestId("b-run") as HTMLButtonElement).disabled).toBe(true);
        host.views["voice-isolation"] = { price: { kind: "estimate", label: "≈ $0.013", usd: 0.013 } };
        act(() => host.change());
        expect(screen.getByTestId("b-run").textContent).toBe("≈ $0.013 · Run");
        expect((screen.getByTestId("b-run") as HTMLButtonElement).disabled).toBe(false);
    });

    it("signed out, reads Sign in to OpenNan and hands the run to the host (which opens the modal)", () => {
        const host = fakeAiHost({ "voice-isolation": { state: "sign-in" } });
        show(host);
        fireEvent.click(screen.getByRole("button", { name: "Sign in to OpenNan" }));
        expect(host.run).toHaveBeenCalledWith("voice-isolation", params);
    });

    it("is disabled with the host's reason when the tool cannot run", () => {
        const host = fakeAiHost({ stabilize: { state: "unavailable", reason: "Desktop app only", price: { kind: "unknown" } } });
        show(host, "stabilize");
        const button = screen.getByTestId("b-run") as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(screen.getByTestId("b-reason").textContent).toBe("Desktop app only");
        expect(button.getAttribute("aria-describedby")).toBe(screen.getByTestId("b-reason").id);
    });

    it("past the limit, offers the first N seconds with their price", () => {
        const host = fakeAiHost({ "video-upscale": { state: "over-limit", limit: { maxSeconds: 60 }, price: { kind: "estimate", label: "≈ $0.57", usd: 0.57 } } });
        show(host, "video-upscale", { params: { clipId: "c1", resolution: "4k" } });
        expect(screen.getByTestId("b-limit").textContent).toBe("This tool takes up to 60 s at once.");
        const first = screen.getByRole("button", { name: "Use the first 60 s, about $0.57" });
        expect(first.textContent).toBe("Use the first 60 s · ≈ $0.57");
        fireEvent.click(first);
        expect(host.run).toHaveBeenCalledWith("video-upscale", { clipId: "c1", resolution: "4k", maxSeconds: 60 });
    });

    it("without a host, is disabled and says the tools need the app", () => {
        show(null);
        expect((screen.getByTestId("b-run") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("b-reason").textContent).toBe("AI tools need the OpenNan Studio app");
    });

    it("can run through the caller instead (a host dialog)", () => {
        const host = fakeAiHost();
        const onRun = vi.fn();
        show(host, "captions", { onRun, label: "Auto captions…" });
        fireEvent.click(screen.getByRole("button", { name: "Auto captions…, about $0.05" }));
        expect(onRun).toHaveBeenCalledWith(params);
        expect(host.run).not.toHaveBeenCalled();
    });
});

describe("price helpers", () => {
    it("formats charges and strips the estimate sign", () => {
        expect(formatUsd(0.13)).toBe("$0.13");
        expect(formatUsd(1.3)).toBe("$1.30");
        expect(formatUsd(0.005)).toBe("$0.005");
        expect(formatUsd(0.05)).toBe("$0.05");
        expect(formatUsd(0.0001)).toBe("$0.001");
        // Rounded up (phase 9c): never shown under what it charged.
        expect(formatUsd(0.1301)).toBe("$0.14");
        expect(formatUsd(0.0051)).toBe("$0.006");
        expect(formatUsd(0.0999)).toBe("$0.10");
        expect(formatUsd(0.09)).toBe("$0.09");
        expect(formatUsd(1.2)).toBe("$1.20");
        for (let i = 1; i < 3_000; i++) {
            const usd = (i * 7_919 % 2_500_000) / 1_000_000;
            const shown = Number(formatUsd(usd).slice(1));
            expect(shown + 1e-9).toBeGreaterThanOrEqual(usd);
            expect(shown - usd).toBeLessThanOrEqual((usd >= 0.1 ? 0.01 : 0.001) + 1e-9);
        }
        expect(plainPrice("≈ $0.005")).toBe("$0.005");
    });
});
