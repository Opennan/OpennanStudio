// The device name shown on opennan.com's approval page and in the key name ("OpenNan Studio (<device>)").

/** What the approval page shows: no control characters or angle brackets, at most 60 characters. */
export function cleanDeviceName(name: string): string {
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
    return cleaned || "this device";
}

function browserOf(ua: string): string {
    if (/Edg\//.test(ua)) return "Edge";
    if (/OPR\//.test(ua)) return "Opera";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return "Chrome";
    if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
    return "Browser";
}

function osOf(ua: string): string | null {
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    if (/CrOS/.test(ua)) return "ChromeOS";
    if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux|X11/.test(ua)) return "Linux";
    return null;
}

/** "Web · Chrome on macOS" from a user agent string. */
export function webDeviceName(userAgent: string): string {
    const os = osOf(userAgent);
    return cleanDeviceName(`Web · ${browserOf(userAgent)}${os ? ` on ${os}` : ""}`);
}
