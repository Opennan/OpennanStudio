// The renderer's origin, the media scheme, and its Content Security Policy (spec §7.2). The page loads only
// its own files; media comes from opennan-media://; no remote origin is allowed anywhere. 'unsafe-eval' is
// there for one reason: regl (timeline-media's GL effects) compiles its draw commands with Function.
export const APP_SCHEME = "opennan-app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const MEDIA_SCHEME = "opennan-media";

export const CSP_DIRECTIVES: ReadonlyArray<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-eval'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", `${MEDIA_SCHEME}:`]],
    ["media-src", ["'self'", "blob:", `${MEDIA_SCHEME}:`]],
    ["connect-src", ["'self'", `${MEDIA_SCHEME}:`, "blob:", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");

/** The same policy for the page's <meta> tag: frame-ancestors only works as a header, so it is left out there. */
export const META_CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.filter(([name]) => name !== "frame-ancestors")
    .map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
