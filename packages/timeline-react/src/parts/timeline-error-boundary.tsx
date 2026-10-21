"use client";
// Error boundary for the timeline: a timeline crash must degrade to a retry
// strip, never a blank editor.

import React, { useContext } from "react";
import { TimelineContext } from "../provider/context";
import { DEFAULT_TRANSLATE, type TimelineTranslate } from "../i18n/format";

interface Props {
    onError?(error: Error, info: React.ErrorInfo): void;
    children?: React.ReactNode;
}

interface InnerProps extends Props {
    translate: TimelineTranslate;
}

interface State { error: Error | null; }

class TimelineErrorBoundaryInner extends React.Component<InnerProps, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error("[TIMELINE] crashed:", error, info.componentStack);
        this.props.onError?.(error, info);
    }

    render() {
        if (this.state.error) {
            const t = this.props.translate;
            return (
                <div className="flex h-32 items-center justify-center gap-3 border-t border-[rgba(255,255,255,0.06)] bg-[#0A0A0B] text-[12px] text-[#A0A0A8]">
                    <span>{t("errorBoundary", "crashed", { message: this.state.error.message })}</span>
                    <button
                        onClick={() => this.setState({ error: null })}
                        className="rounded-md border border-white/10 px-2 py-1 hover:bg-white/[0.06]"
                    >
                        {t("errorBoundary", "reload")}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

/** Class boundaries cannot use hooks; the wrapper reads the provider's translate. */
export function TimelineErrorBoundary(props: Props) {
    const translate = useContext(TimelineContext)?.translate ?? DEFAULT_TRANSLATE;
    return <TimelineErrorBoundaryInner {...props} translate={translate} />;
}
