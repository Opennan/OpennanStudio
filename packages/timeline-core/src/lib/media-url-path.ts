// Generic media URL path parsing. Copied from opennan frontend lib/local-media-path.ts:59-68.
export function getRawPathnameFromMediaUrl(url: string): string | null {
    const absoluteMatch = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
    if (absoluteMatch) return absoluteMatch[1] || "/";
    if (url.startsWith("//")) {
        const protocolRelativeMatch = /^\/\/[^/?#]*([^?#]*)/.exec(url);
        return protocolRelativeMatch?.[1] || "/";
    }
    if (url.startsWith("/")) return url.split(/[?#]/, 1)[0] || "/";
    return `/${url.split(/[?#]/, 1)[0]}`;
}
