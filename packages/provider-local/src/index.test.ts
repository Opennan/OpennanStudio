import * as local from "./index";

describe("@opennan/provider-local", () => {
    it("exports its version and the provider factory", () => {
        expect(local.PROVIDER_LOCAL_VERSION).toBe("0.3.0");
        expect(typeof local.createLocalProvider).toBe("function");
        expect(local.LOCAL_PROVIDER_ID).toBe("local");
    });
});
