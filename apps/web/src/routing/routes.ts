// Hash routes, so the static build works from any host or sub-path without
// server rewrites (spec §7.1: deployed as static files).
export type Route =
    | { name: "projects" }
    | { name: "editor"; projectId: string }
    | { name: "providers" }
    | { name: "not-found"; path: string };

export type KnownRoute = Exclude<Route, { name: "not-found" }>;

export function parseRoute(hash: string): Route {
    const path = hash.replace(/^#/, "") || "/";
    if (path === "/") return { name: "projects" };
    if (path === "/settings/providers") return { name: "providers" };
    const editor = /^\/p\/([^/]+)\/?$/.exec(path);
    if (editor) return { name: "editor", projectId: decodeURIComponent(editor[1]) };
    return { name: "not-found", path };
}

export function routeHref(route: KnownRoute): string {
    switch (route.name) {
        case "projects":
            return "#/";
        case "providers":
            return "#/settings/providers";
        case "editor":
            return `#/p/${encodeURIComponent(route.projectId)}`;
    }
}

export function navigate(route: KnownRoute): void {
    window.location.hash = routeHref(route);
}
