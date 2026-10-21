// Small stroke icons drawn in currentColor (theme colors come from CSS).
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };

export function CloseIcon() {
    return <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
export function CopyIcon() {
    return <svg {...base}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
}
export function CheckIcon() {
    return <svg {...base}><path d="M20 6 9 17l-5-5" /></svg>;
}
export function AlertIcon() {
    return <svg {...base} width={22} height={22}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>;
}
export function LockIcon() {
    return <svg {...base} width={14} height={14}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
}
export function ChevronIcon() {
    return <svg {...base} width={14} height={14}><path d="m6 9 6 6 6-6" /></svg>;
}
