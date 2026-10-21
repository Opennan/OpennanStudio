/** The OpenNan mark: a 270° arc with three nodes and a core, drawn in currentColor. */
export function BrandMark({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M 17.66 17.66 A 8 8 0 1 1 17.66 6.34" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="20" r="1.6" fill="currentColor" />
            <circle cx="4" cy="12" r="1.6" fill="currentColor" />
            <circle cx="12" cy="4" r="1.6" fill="currentColor" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
    );
}
