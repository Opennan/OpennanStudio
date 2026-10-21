// Small line icons for cloud states (currentColor; the conflict icon is the one filled shape).
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const cloudPath = "M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18Z";

export function CloudIcon({ kind }: { kind: "saved" | "syncing" | "offline" | "conflict" | "signed-out" | "over-quota" | "opening" }) {
    if (kind === "conflict") {
        return (
            <svg {...base}>
                <path d="M12 3 2.5 20h19L12 3Z" fill="currentColor" stroke="none" />
                <path d="M12 9.5v4.5M12 17h.01" stroke="var(--on-background)" />
            </svg>
        );
    }
    return (
        <svg {...base}>
            <path d={cloudPath} />
            {kind === "saved" && <path d="m9.5 13.5 2 2 3.5-4" />}
            {(kind === "syncing" || kind === "opening") && <path d="M9.5 14a2.5 2.5 0 0 1 4.6-1.3M14.5 12.5V11M14.5 12.5H13" />}
            {kind === "offline" && <path d="m4 4 16 16" />}
            {kind === "over-quota" && <path d="M12 10.5v3M12 15.8h.01" />}
        </svg>
    );
}
