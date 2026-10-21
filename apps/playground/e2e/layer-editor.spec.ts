// apps/playground/e2e/layer-editor.spec.ts
import { expect, test } from "@playwright/test";

test("agent ops edit the demo design and keep original lettering", async ({ page }) => {
    await page.goto("/?demo=layers");
    await expect(page.getByRole("region", { name: "Layer editor" })).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__layerDemo));
    const results = await page.evaluate(() => window.__layerDemo!.apply([
        { op: "set_text", target: "12,450", text: "15,420" },
        { op: "set_text", target: "385", text: "999" },
    ]));
    expect(results).toMatchObject({ results: [{ ok: true }, { ok: true }] });
    const summary = await page.evaluate(() => window.__layerDemo!.describe()) as { layers: { text?: string; lettering?: string; missingGlyphs?: string[] }[] };
    expect(summary.layers.find((l) => l.text === "15,420")?.lettering).toBe("glyphs");
    expect(summary.layers.find((l) => l.text === "999")?.missingGlyphs).toEqual(["9"]);
});

test("sample ops all apply", async ({ page }) => {
    await page.goto("/?demo=layers");
    await page.waitForFunction(() => Boolean(window.__layerDemo));
    for (const name of ["Swap SHOP and GUILD tiles", "Make PLAY 15% bigger", "Hide the banner"]) {
        await page.getByRole("button", { name }).click();
        await expect(page.getByLabel("Result")).not.toContainText('"ok": false');
    }
});

test("double-click edits text inline", async ({ page }) => {
    await page.goto("/?demo=layers");
    await page.waitForFunction(() => Boolean(window.__layerDemo));
    const box = await page.evaluate(() => (window.__layerDemo!.describe() as { layers: { text?: string; bounds: { x: number; y: number; w: number; h: number } }[] }).layers.find((l) => l.text === "2,500")!.bounds);
    const canvas = page.getByTestId("layer-canvas");
    const rect = (await canvas.boundingBox())!;
    const k = rect.width / 1088;
    await canvas.dblclick({ position: { x: (box.x + box.w / 2) * k, y: (box.y + box.h / 2) * k } });
    const input = page.getByRole("textbox", { name: "Edit text" });
    await input.fill("5,000");
    await input.press("Enter");
    const summary = await page.evaluate(() => window.__layerDemo!.describe()) as { layers: { text?: string; lettering?: string }[] };
    expect(summary.layers.find((l) => l.text === "5,000")?.lettering).toBe("glyphs");
});
