import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "e2e",
    timeout: 30_000,
    use: { baseURL: "http://localhost:4317", trace: "retain-on-failure" },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "pnpm preview",
        url: "http://localhost:4317",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
