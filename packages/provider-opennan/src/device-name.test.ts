import { cleanDeviceName, webDeviceName } from "./device-name";

describe("device names", () => {
    it("names the browser and the OS", () => {
        const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
        expect(webDeviceName(mac)).toBe("Web · Chrome on macOS");
        expect(webDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toBe("Web · Edge on Windows");
        expect(webDeviceName("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Web · Firefox on Linux");
        expect(webDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Web · Safari on macOS");
        expect(webDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Web · Safari on iOS");
        expect(webDeviceName("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("Web · Chrome on Android");
        expect(webDeviceName("")).toBe("Web · Browser");
    });

    it("cleans names: no control characters or angle brackets, at most 60 characters", () => {
        expect(cleanDeviceName("  Ada's <b>Mac</b>\u0000\n Pro ")).toBe("Ada's bMac/b Pro");
        expect(cleanDeviceName("x".repeat(80))).toHaveLength(60);
        expect(cleanDeviceName("\u0007")).toBe("this device");
    });
});
