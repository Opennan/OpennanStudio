import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");

describe("styles.css build", () => {
  const css = (() => {
    execFileSync("pnpm", ["run", "build:css"], { cwd: root, stdio: "pipe" });
    return readFileSync(resolve(root, "dist/styles.css"), "utf8");
  })();

  it("includes utilities used by package and core sources", () => {
    expect(css).toContain(".on-slider-input");
    // bg-[rgba(0,210,255,0.14)] exists only in core nle-timeline-layout.ts:15.
    expect(css).toMatch(/bg-\\\[rgba\\\(0\\?,210\\?,255\\?,0\\?\.14\\\)\\\]/);
  });

  it("ships the timeline theme tokens under the scope", () => {
    expect(css).toMatch(/\.opennan-studio[^{]*\{[^}]*--timeline-playhead/);
  });

  it("does not reset the host page", () => {
    expect(css).not.toMatch(/(^|[},])\s*(html|body|\*)\s*[,{]/);
  });
});
