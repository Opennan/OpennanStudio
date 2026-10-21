import { parseRoute, routeHref } from "./routes";

describe("routes", () => {
    it("parses the project list, editor, and provider settings", () => {
        expect(parseRoute("")).toEqual({ name: "projects" });
        expect(parseRoute("#/")).toEqual({ name: "projects" });
        expect(parseRoute("#/p/abc-123")).toEqual({ name: "editor", projectId: "abc-123" });
        expect(parseRoute("#/p/a%20b/")).toEqual({ name: "editor", projectId: "a b" });
        expect(parseRoute("#/settings/providers")).toEqual({ name: "providers" });
    });

    it("reports anything else as not found", () => {
        expect(parseRoute("#/p/")).toEqual({ name: "not-found", path: "/p/" });
        expect(parseRoute("#/nope")).toEqual({ name: "not-found", path: "/nope" });
    });

    it("builds hrefs that parse back to the same route", () => {
        expect(routeHref({ name: "projects" })).toBe("#/");
        expect(routeHref({ name: "providers" })).toBe("#/settings/providers");
        const href = routeHref({ name: "editor", projectId: "a b/c" });
        expect(href).toBe("#/p/a%20b%2Fc");
        expect(parseRoute(href)).toEqual({ name: "editor", projectId: "a b/c" });
    });
});
