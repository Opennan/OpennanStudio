import { commandFailure, commandFailureText, failure, success, toCallToolResult, unavailable } from "./outcome";

describe("tool outcomes", () => {
    it("maps success with images to MCP content", () => {
        const image = { mimeType: "image/png" as const, data: new Uint8Array([1, 2]), width: 1, height: 1 };
        expect(toCallToolResult(success("done", { clipId: "c1" }, [image]))).toEqual({
            content: [{ type: "text", text: "done" }, { type: "image", data: "AQI=", mimeType: "image/png" }],
            structuredContent: { ok: true, clipId: "c1" },
            isError: false,
        });
    });

    it("marks failures and unavailable capabilities as tool errors", () => {
        expect(toCallToolResult(failure("bad"))).toMatchObject({ isError: true, structuredContent: { ok: false, error: "bad" } });
        expect(toCallToolResult(unavailable("Connect OpenNan to use qc_check.", "opennan.qc"))).toMatchObject({
            isError: true,
            structuredContent: { ok: false, unavailable: true, reason: "Connect OpenNan to use qc_check.", capability: "opennan.qc" },
        });
    });

    it("uses the UI's failure message for failed commands", () => {
        expect(commandFailureText("clip.split", "nothing to split at this time")).toBe("Failed to split clip: nothing to split at this time");
        expect(commandFailureText("marker.add", undefined)).toBe("Could not save your edit");
        expect(commandFailure("clip.split", { ok: true, changed: {} })).toBeNull();
        expect(commandFailure("export.start", { ok: false, changed: {}, unavailable: true, error: "no export" })).toMatchObject({ unavailable: { reason: "no export" } });
        expect(commandFailure("clip.update", { ok: false, changed: {}, cancelled: true })?.text).toBe("clip.update was cancelled");
    });
});
