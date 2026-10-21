import * as sdk from "./index";

describe("@opennan/provider-sdk", () => {
    it("exports its version and the capability API", () => {
        expect(sdk.PROVIDER_SDK_VERSION).toBe("0.5.0");
        expect(sdk.OPEN_CAPABILITIES).toContain("audio.transcribe");
        expect(typeof sdk.CapabilityUnavailableError).toBe("function");
    });

    it("exports the phase 11 API", () => {
        expect(typeof sdk.AiJobBook).toBe("function");
        expect(sdk.MAX_AI_JOB_RECORDS).toBe(200);
        expect(typeof sdk.estimateToolCost).toBe("function");
        expect(typeof sdk.parseMediaSourceRef).toBe("function");
        expect(sdk.CANCEL_REFUSED_MESSAGE).toBe("Already running: it will finish and be charged.");
        expect(sdk.LOCAL_ONLY_CAPABILITIES).toEqual(["media.stabilize"]);
    });
});
