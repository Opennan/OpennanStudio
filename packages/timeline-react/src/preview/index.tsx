"use client";
// Public <Preview>: PreviewPanel inside the provider; graphics render only when
// @opennan/remotion-addon is registered (spec §5.3).
import { PreviewPanel } from "./preview-panel";

export interface PreviewProps {
    className?: string;
}

export function Preview({ className }: PreviewProps) {
    return (
        <div className={className}>
            <PreviewPanel />
        </div>
    );
}
