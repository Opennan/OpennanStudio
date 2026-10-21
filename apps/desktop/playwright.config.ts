import { defineConfig } from "@playwright/test";

// Playwright-Electron smoke tests against the built, unpacked app (dist/; `pnpm e2e` builds it first). The
// packaged app has the inspector fuse off, so it gets scripts/packaged-smoke.mjs instead.
export default defineConfig({
    testDir: "e2e",
    timeout: 240_000,
    workers: 1,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: { trace: "retain-on-failure" },
});
