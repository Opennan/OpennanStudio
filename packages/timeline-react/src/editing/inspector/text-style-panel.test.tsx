import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import { ClipProperties } from "../../clip-properties";
import { getActiveRuntime } from "../../provider/registry";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { TEXT_SLIDER_DEBOUNCE_MS } from "./text-style-panel";

const textTrack: TimelineTrack = { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 };

async function setup(textStyle: Record<string, unknown> | null = { fontFamily: "Inter, sans-serif", fontWeight: "700", fontSize: 64, color: "#FFFFFF" }) {
    const runtime = createTimelineTestRuntime();
    const clip: TimelineClip = optimisticTimelineClipFromInput(
        { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", textStyle: textStyle ? JSON.stringify(textStyle) : null },
        runtime.projectId, "t1",
    );
    await seedTimeline(runtime, { tracks: [textTrack], clips: [clip] });
    runtime.store.getState().selectClip("t1");
    renderWithTimeline(<ClipProperties />, { runtime });
    const controller = getActiveRuntime()!.controller;
    const execute = vi.spyOn(controller, "execute");
    const style = () => JSON.parse(runtime.store.getState().timelineData!.clips[0].textStyle ?? "{}") as Record<string, unknown>;
    return { runtime, execute, style };
}

const slider = (testId: string) => within(screen.getByTestId(testId)).getByRole("slider");
const toggle = (testId: string) => within(screen.getByTestId(testId)).getByRole("switch");

describe("text inspector", () => {
    it("line spacing writes lineHeight through a coalesced text.style.set", async () => {
        const { execute, style } = await setup();
        await act(async () => fireEvent.change(slider("txt-line-height"), { target: { value: "1.8" } }));
        expect(execute).toHaveBeenCalledWith(
            { type: "text.style.set", clipIds: ["t1"], patch: { lineHeight: 1.8 } },
            expect.objectContaining({ coalesceKey: "text-style:t1:lineHeight", debounceMs: TEXT_SLIDER_DEBOUNCE_MS }),
        );
        await waitFor(() => expect(style().lineHeight).toBe(1.8));
        // Range 0.8–2.5.
        expect((slider("txt-line-height") as HTMLInputElement).min).toBe("0.8");
        expect((slider("txt-line-height") as HTMLInputElement).max).toBe("2.5");
    });

    it("glow turns on with defaults, edits its size, and turns off by removing its keys", async () => {
        const { execute, style } = await setup();
        await act(async () => fireEvent.click(toggle("txt-glow")));
        expect(execute).toHaveBeenLastCalledWith({ type: "text.style.set", clipIds: ["t1"], patch: { glowColor: "#FFFFFF", glowSize: 12 } }, expect.anything());
        await waitFor(() => expect(style()).toMatchObject({ glowColor: "#FFFFFF", glowSize: 12 }));
        await act(async () => fireEvent.change(slider("txt-glow-size"), { target: { value: "20" } }));
        await waitFor(() => expect(style().glowSize).toBe(20));
        await act(async () => fireEvent.change(within(screen.getByTestId("txt-glow-color")).getByLabelText("txt_color"), { target: { value: "#ff00aa" } }));
        await waitFor(() => expect(style().glowColor).toBe("#ff00aa"));
        await act(async () => fireEvent.click(toggle("txt-glow")));
        expect(execute).toHaveBeenLastCalledWith({ type: "text.style.set", clipIds: ["t1"], patch: { glowColor: null, glowSize: null } }, expect.anything());
        await waitFor(() => expect(style()).not.toHaveProperty("glowSize"));
    });

    it("the background box sets colour, padding, and corner radius, and none removes it", async () => {
        const { execute, style } = await setup();
        await act(async () => fireEvent.click(toggle("txt-box")));
        await waitFor(() => expect(style()).toMatchObject({ bgColor: "rgba(0,0,0,0.6)", bgPadding: 12, bgRadius: 8 }));
        await act(async () => fireEvent.change(slider("txt-box-padding"), { target: { value: "24" } }));
        await act(async () => fireEvent.change(slider("txt-box-radius"), { target: { value: "40" } }));
        await waitFor(() => expect(style()).toMatchObject({ bgPadding: 24, bgRadius: 40 }));
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ patch: { bgRadius: 40 } }), expect.objectContaining({ coalesceKey: "text-style:t1:bgRadius" }));
        await act(async () => fireEvent.click(toggle("txt-box")));
        await waitFor(() => expect(style()).not.toHaveProperty("bgColor"));
    });

    it("shadow offsets X and Y, stroke, and the gradient fill each patch their keys", async () => {
        const { style } = await setup();
        await act(async () => fireEvent.click(toggle("txt-shadow")));
        await act(async () => fireEvent.change(slider("txt-shadow-x"), { target: { value: "-6" } }));
        await act(async () => fireEvent.change(slider("txt-shadow-y"), { target: { value: "9" } }));
        await waitFor(() => expect(style()).toMatchObject({ shadowOffsetX: -6, shadowOffsetY: 9 }));
        await act(async () => fireEvent.click(toggle("txt-stroke")));
        await act(async () => fireEvent.change(slider("txt-stroke-width"), { target: { value: "7" } }));
        await waitFor(() => expect(style()).toMatchObject({ strokeWidth: 7, strokeColor: "#000000" }));
        await act(async () => fireEvent.click(toggle("txt-gradient")));
        await waitFor(() => expect(style().gradient).toEqual({ from: "#ffffff", to: "#3a86ff", angle: 90 }));
        await act(async () => fireEvent.change(slider("txt-gradient-angle"), { target: { value: "45" } }));
        await waitFor(() => expect(style().gradient).toEqual({ from: "#ffffff", to: "#3a86ff", angle: 45 }));
    });

    it("lists the 12 bundled families, limits weights to the family's faces, and keeps a legacy system family selectable", async () => {
        const { style } = await setup({ fontFamily: "Georgia, serif", fontWeight: "bold" });
        const family = screen.getByTestId("txt-font-family") as HTMLSelectElement;
        expect(family.options).toHaveLength(13);
        expect(family.value).toBe("Georgia, serif");
        await act(async () => fireEvent.change(family, { target: { value: "Bebas Neue" } }));
        await waitFor(() => expect(style()).toMatchObject({ fontWeight: "400" }));
        expect(String(style().fontFamily)).toMatch(/^"Bebas Neue", /);
        await waitFor(() => expect([...(screen.getByTestId("txt-font-weight") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["400"]));
        expect((screen.getByTestId("txt-font-family") as HTMLSelectElement).options).toHaveLength(12);
        await act(async () => fireEvent.change(screen.getByTestId("txt-font-family"), { target: { value: "Montserrat" } }));
        await waitFor(() => expect([...(screen.getByTestId("txt-font-weight") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["400", "700", "900"]));
    });

    it("alignment, letter spacing, and the template strip write through the controller", async () => {
        const { execute, style, runtime } = await setup();
        await act(async () => fireEvent.click(screen.getByTestId("txt-align-left")));
        await waitFor(() => expect(style().textAlign).toBe("left"));
        await act(async () => fireEvent.change(slider("txt-letter-spacing"), { target: { value: "3.5" } }));
        await waitFor(() => expect(style().letterSpacing).toBe(3.5));
        await act(async () => fireEvent.click(screen.getByTestId("txt-template-neon_cyan")));
        expect(execute).toHaveBeenLastCalledWith({ type: "text.template.apply", clipIds: ["t1"], templateId: "neon_cyan" }, expect.anything());
        await waitFor(() => expect(style()).toMatchObject(textTemplateById("neon_cyan")!.style));
        await waitFor(() => expect(screen.getByTestId("txt-template-neon_cyan").getAttribute("aria-pressed")).toBe("true"));
        expect(runtime.store.getState().timelineData!.clips[0].animationJson).toContain("flicker");
    });
});
