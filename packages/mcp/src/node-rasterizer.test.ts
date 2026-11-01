import { existsSync } from "node:fs";
import { createStudioExporter } from "./export";
import { createNodeRasterizer, fontsourceFile } from "./node-rasterizer";
import { createStubExportRunner } from "./testing/export-runner";
import { createFixtureStudio } from "./testing/fixture";

describe("createNodeRasterizer", () => {
    it("finds a bundled face in its @fontsource package", () => {
        const file = fontsourceFile({ family: "Montserrat", weight: 800, style: "normal" });
        expect(file).toMatch(/@fontsource[/\\]montserrat[/\\]files[/\\]montserrat-latin-800-normal\.woff2$/);
        expect(existsSync(file!)).toBe(true);
        expect(fontsourceFile({ family: "Comic Sans MS", weight: 400, style: "normal" })).toBeNull();
        expect(fontsourceFile({ family: "Montserrat", weight: 800, style: "normal" }, () => {
            throw new Error("not installed");
        })).toBeNull();
    });

    it("is undefined when @napi-rs/canvas is not installed", async () => {
        await expect(createNodeRasterizer(() => Promise.reject(new Error("Cannot find module")))).resolves.toBeUndefined();
        await expect(createNodeRasterizer(() => Promise.resolve({}))).resolves.toBeUndefined();
    });

    it("draws text clips into exports instead of leaving them out", async () => {
        const rasterizer = await createNodeRasterizer();
        expect(rasterizer).toBeDefined();
        const { controller } = await createFixtureStudio();
        const exporter = createStudioExporter({ runner: createStubExportRunner(), rasterizer });
        const outcome = await exporter.onExport({ resolution: "720p" }, controller.snapshot());
        const status = await exporter.settled((outcome as { jobId: string }).jobId);
        expect(status).toMatchObject({ status: "done" });
        expect(status?.status === "done" ? status.warnings.map((w) => w.code) : ["not done"]).not.toContain("text-unsupported");
    });
});
