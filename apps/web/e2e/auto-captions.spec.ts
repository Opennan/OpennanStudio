// Auto captions on the web (phase 11): OpenNan cloud is the web's transcription engine. The button is live, the dialog
// says where the audio goes and waits for a price (an empty timeline has none), and a signed-out agent's ai.run answers
// with the sign-in guidance. The paid run itself: ai-captions-cloud.spec.ts.
import { expect, test } from "@playwright/test";
import { createProject, execute } from "./helpers";

test("Auto captions on the web runs on OpenNan cloud: live button, cloud dialog, signed-out agents get the sign-in guidance", async ({ page }) => {
    await createProject(page, "Captions");
    const button = page.locator(".topbar-gated");
    await expect(button).toHaveText("Auto captions");
    await expect(button).not.toHaveAttribute("data-unavailable", "true");
    await expect(button).toHaveAttribute("title", /OpenNan/);
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Auto captions" });
    await expect(dialog).toContainText("Sends the timeline audio to OpenNan cloud");
    // Nothing to transcribe yet, so no price: the cloud run waits for one.
    await expect(dialog.getByRole("button", { name: /Run$/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    const result = await execute(page, { type: "ai.run", capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } });
    expect(result).toMatchObject({ ok: false, unavailable: true, error: expect.stringMatching(/sign in/i) });
});
