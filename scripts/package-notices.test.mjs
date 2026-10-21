import { test } from "node:test";
import assert from "node:assert/strict";
import { apacheDependencyProblems, dependencyRows, licenseAllowed, mergeListings, parseListing, renderNotices, workspaceClosure } from "./package-notices.mjs";

test("allows permissive licenses and denies the GPL family, SSPL, and unknown ones", () => {
    for (const ok of ["MIT", "Apache-2.0", "(MIT OR GPL-3.0-or-later)", "BSD-3-Clause AND MIT", "MPL-2.0", "BlueOak-1.0.0"]) {
        assert.equal(licenseAllowed(ok), true, ok);
    }
    for (const bad of ["GPL-3.0-only", "AGPL-3.0", "LGPL-2.1-or-later", "SSPL-1.0", "MIT AND GPL-2.0-only", "UNKNOWN", "", undefined]) {
        assert.equal(licenseAllowed(bad), false, String(bad));
    }
});

test("lists dependencies without this repo's packages and renders notices", () => {
    const rows = dependencyRows({
        MIT: [{ name: "dep-b", versions: ["2.0.0"], homepage: "https://b.test" }, { name: "@opennan/timeline-core", versions: ["0.2.0"] }],
        ISC: [{ name: "dep-a", versions: ["1.0.0"] }],
    });
    assert.deepEqual(rows.map((row) => `${row.name}@${row.version} ${row.license}`), ["dep-a@1.0.0 ISC", "dep-b@2.0.0 MIT"]);
    assert.match(renderNotices("@opennan/mcp", rows), /^dep-b@2\.0\.0 {2}MIT {2}https:\/\/b\.test$/m);
    assert.match(renderNotices("@opennan/mcp-schema", []), /no third-party runtime dependencies/);
});

test("follows workspace dependencies, which pnpm licenses list does not", () => {
    const manifests = new Map([
        ["@opennan/mcp", { dependencies: { "@opennan/export": "workspace:*", "@opennan/mcp-schema": "workspace:*", "@modelcontextprotocol/sdk": "1.32.1" } }],
        ["@opennan/export", { dependencies: { "@opennan/timeline-core": "workspace:*" } }],
        ["@opennan/timeline-core", { dependencies: { zustand: "^5.0.11" } }],
        ["@opennan/mcp-schema", {}],
    ]);
    assert.deepEqual(workspaceClosure("@opennan/mcp", manifests), ["@opennan/mcp", "@opennan/export", "@opennan/timeline-core", "@opennan/mcp-schema"]);
    const merged = mergeListings([
        { MIT: [{ name: "@modelcontextprotocol/sdk", versions: ["1.32.1"] }, { name: "zod", versions: ["3.25.0"] }] },
        { MIT: [{ name: "zustand", versions: ["5.0.11"] }, { name: "zod", versions: ["3.25.0"] }] },
    ]);
    assert.deepEqual(dependencyRows(merged).map((row) => row.name), ["@modelcontextprotocol/sdk", "zod", "zustand"]);
    // `pnpm licenses list` prints this line, not JSON, for a package whose only dependencies are workspace links.
    assert.deepEqual(parseListing("No licenses in packages found"), {});
});

test("Apache-2.0 packages depend only on Apache-2.0 workspace packages (spec §3)", () => {
    const manifests = new Map([
        ["@opennan/provider-sdk", { name: "@opennan/provider-sdk", license: "Apache-2.0" }],
        ["@opennan/timeline-core", { name: "@opennan/timeline-core", license: "SEE LICENSE IN LICENSE" }],
    ]);
    const schema = { name: "@opennan/mcp-schema", license: "Apache-2.0", dependencies: { "@opennan/provider-sdk": "workspace:*" } };
    assert.deepEqual(apacheDependencyProblems(schema, manifests), []);
    const leaky = { name: "@opennan/provider-local", license: "Apache-2.0", dependencies: { "@opennan/timeline-core": "workspace:*" } };
    assert.match(apacheDependencyProblems(leaky, manifests)[0], /must not depend on @opennan\/timeline-core/);
    const thirdParty = { name: "@opennan/provider-sdk", license: "Apache-2.0", dependencies: { zod: "^4" } };
    assert.match(apacheDependencyProblems(thirdParty, manifests)[0], /no third-party runtime dependencies/);
    assert.deepEqual(apacheDependencyProblems({ name: "@opennan/mcp", license: "SEE LICENSE IN LICENSE", dependencies: { zod: "^4" } }, manifests), []);
});

test("appends the package's THIRD_PARTY_ASSETS after the dependency list, deterministically", () => {
    const rows = [{ name: "zustand", version: "5.0.15", license: "MIT", homepage: null }];
    const assets = "Third-party assets\r\n\r\nTwemoji (graphics)  CC-BY-4.0  \r\n\r\n\r\n";
    const notices = renderNotices("@opennan/timeline-core", rows, assets);
    assert.equal(notices, renderNotices("@opennan/timeline-core", rows, assets));
    assert.ok(notices.indexOf("zustand@5.0.15  MIT") < notices.indexOf("Third-party assets"));
    assert.match(notices, /THIRD_PARTY_ASSETS/);
    assert.ok(notices.endsWith("Third-party assets\n\nTwemoji (graphics)  CC-BY-4.0\n"), JSON.stringify(notices.slice(-60)));
    assert.ok(!notices.includes("\r"));
    // Without an assets file (or with an empty one) the notices are unchanged.
    assert.equal(renderNotices("@opennan/mcp", rows, null), renderNotices("@opennan/mcp", rows));
    assert.equal(renderNotices("@opennan/mcp", rows, " \n"), renderNotices("@opennan/mcp", rows));
});
