import { defineConfig, devices } from "@playwright/test";

/**
 * AI specs that read or turn the fake OpenNan server's global state (requests, uploads, balance, knobs): one worker,
 * after the parallel suite (package.json e2e).
 */
const SERIAL_AI_SPECS = /(ai-(jobs|captions-cloud|media-tools|isolate-voice|generate|temp-upload|local-cuts))\.spec\.ts/;

export default defineConfig({
    testDir: "e2e",
    // The fake OpenNan server (e2e/fixtures/fake-opennan.ts) for Sign in with OpenNan and generation.
    globalSetup: "./e2e/global-setup.ts",
    timeout: 60_000,
    use: { baseURL: "http://localhost:4318", trace: "retain-on-failure", acceptDownloads: true },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: SERIAL_AI_SPECS },
        { name: "ai-serial", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testMatch: SERIAL_AI_SPECS },
    ],
    webServer: {
        command: "pnpm preview:e2e",
        url: "http://localhost:4318",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
