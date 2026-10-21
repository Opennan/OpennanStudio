import { act } from "@testing-library/react";
import type { TimelineClip } from "@opennan/timeline-core";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { RemotionTimelineOverlay } from "./remotion-layer";
import { registerRemotionAddon } from "./registry";
import { getTemplates, templateById } from "./templates";

const graphic = (patch: Partial<TimelineClip> = {}): TimelineClip => ({
    id: "g1", projectId: "project-1", trackType: "remotion", trackIndex: 1, startTime: 1, endTime: 5, remotionTemplateId: "lower-third", remotionPropsJson: null,
    ...patch,
} as TimelineClip);

/** A 2D context that records the calls the renderer makes. */
function recordingContext() {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
        get(target, key: string) {
            if (key in target) return target[key];
            if (key === "measureText") return () => ({ width: 100 });
            return (...args: unknown[]) => {
                calls.push(key);
                return key === "createLinearGradient" || key === "createRadialGradient" ? { addColorStop: () => undefined } : undefined;
            };
        },
        set(target, key: string, value) {
            target[key] = value;
            return true;
        },
    });
    return { ctx, calls };
}

describe("built-in graphics in the preview", () => {
    let recorder: ReturnType<typeof recordingContext>;
    beforeEach(() => {
        recorder = recordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorder.ctx as never);
    });
    afterEach(() => vi.restoreAllMocks());

    it("lists the built-in templates when no add-on is registered", () => {
        expect(getTemplates().map((template) => template.id)).toContain("lower-third");
        expect(templateById("lower-third")?.name).toBe("Lower Third");
        const stop = registerRemotionAddon({ templates: [{ id: "x", name: "X", category: "c", description: "", params: [] }] });
        expect(getTemplates().map((template) => template.id)).toEqual(["x"]);
        stop();
    });

    it("draws a built-in graphic on its own layer while the playhead is inside the clip", () => {
        const view = renderWithTimeline(<RemotionTimelineOverlay clips={[graphic(), graphic({ id: "custom", remotionCode: "x" })]} playing={false} projectRatio={16 / 9} />);
        const layers = view.container.querySelectorAll("[data-remotion-clip-id]");
        // Custom-code graphics need the add-on: no layer.
        expect([...layers].map((layer) => layer.getAttribute("data-remotion-clip-id"))).toEqual(["g1"]);
        const layer = layers[0] as HTMLElement;
        act(() => view.store.getState().setCurrentTime(0.5));
        expect(layer.style.visibility).toBe("hidden");
        recorder.calls.length = 0;
        act(() => view.store.getState().setCurrentTime(3));
        expect(layer.style.visibility).toBe("visible");
        expect(recorder.calls).toContain("fill");
        expect(recorder.calls).toContain("fillText");
        // The painted box is marked for the selection handles.
        expect((layer.querySelector("[data-graphics-content]") as HTMLElement).style.display).toBe("block");
    });

    it("takes the clip's layer style (motion model) and redraws only when the template frame changes", () => {
        const layerStyle = vi.fn(() => ({ transform: "translate(10%, 0%) rotate(5deg) scale(0.5, 0.5)", opacity: 0.4, transformOrigin: "50% 50%" }));
        const view = renderWithTimeline(<RemotionTimelineOverlay clips={[graphic()]} playing={false} projectRatio={16 / 9} layerStyle={layerStyle} />);
        act(() => view.store.getState().setCurrentTime(2));
        const layer = view.container.querySelector("[data-remotion-clip-id]") as HTMLElement;
        expect(layer.style.transform).toContain("rotate(5deg)");
        expect(layer.style.opacity).toBe("0.4");
        recorder.calls.length = 0;
        // 2.001 s is the same 30 fps template frame: no redraw.
        act(() => view.store.getState().setCurrentTime(2.001));
        expect(recorder.calls).not.toContain("fillText");
        act(() => view.store.getState().setCurrentTime(2.1));
        expect(recorder.calls).toContain("fillText");
    });

    it("loads a logo once (one listener however often it draws), through the host's media mapping, and redraws when it arrives", () => {
        const created: FakeImage[] = [];
        class FakeImage {
            listeners: Record<string, Array<() => void>> = {};
            crossOrigin = "";
            decoding = "";
            src = "";
            constructor() {
                created.push(this);
            }
            addEventListener(type: string, listener: () => void) {
                (this.listeners[type] ??= []).push(listener);
            }
        }
        vi.stubGlobal("Image", FakeImage);
        try {
            const logo = graphic({ id: "logo", remotionTemplateId: "logo-sting", remotionPropsJson: JSON.stringify({ logoUrl: "opennan-local://media/abc", text: "Brand" }) });
            const view = renderWithTimeline(<RemotionTimelineOverlay clips={[logo]} playing={false} projectRatio={16 / 9} />, { media: { resolveMediaUrl: (url: string) => url.replace("opennan-local://media/", "https://media.test/") } } as never);
            for (const t of [2, 2.1, 2.2, 2.3]) act(() => view.store.getState().setCurrentTime(t));
            expect(created).toHaveLength(1);
            expect(created[0].src).toBe("https://media.test/abc");
            expect(created[0].listeners.load).toHaveLength(1);
            recorder.calls.length = 0;
            act(() => created[0].listeners.load[0]());
            expect(recorder.calls.length).toBeGreaterThan(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
