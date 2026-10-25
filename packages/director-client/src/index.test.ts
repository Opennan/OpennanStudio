import { readFileSync } from "node:fs";
import * as api from "./index";

it("exports the version from package.json and the public API", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(api.DIRECTOR_CLIENT_VERSION).toBe(pkg.version);
    for (const name of ["createProjectApi", "createQuotes", "createProjectTasks", "checkPipelineRequest", "cutScript"]) expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
});
