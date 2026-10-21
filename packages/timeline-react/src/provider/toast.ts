// sonner-shaped toast API backed by TimelineProviderProps.onToast. Keeps the
// replace-by-id flow the canvas upload path uses (canvas-timeline.tsx:3757-3832).
import type { TimelineToast, TimelineToastKind } from "@opennan/timeline-core";

export interface TimelineToastOptions {
    id?: string;
    icon?: string;
}

export interface TimelineToastApi {
    (message: string, options?: TimelineToastOptions): string | undefined;
    error(message: string, options?: TimelineToastOptions): string | undefined;
    success(message: string, options?: TimelineToastOptions): string | undefined;
    warning(message: string, options?: TimelineToastOptions): string | undefined;
    info(message: string, options?: TimelineToastOptions): string | undefined;
    loading(message: string, options?: TimelineToastOptions): string;
    dismiss(id?: string): void;
}

export type ToastSink = (toast: TimelineToast) => string | void;

let generatedId = 0;

export function createToastApi(getSink: () => ToastSink | undefined, getDismiss: () => ((id: string) => void) | undefined): TimelineToastApi {
    const emit = (kind: TimelineToastKind, message: string, options?: TimelineToastOptions): string | undefined => {
        const toast: TimelineToast = { kind, message };
        if (options?.id) toast.id = options.id;
        if (options?.icon) toast.icon = options.icon;
        const returned = getSink()?.(toast);
        return typeof returned === "string" ? returned : options?.id;
    };
    const api = ((message: string, options?: TimelineToastOptions) => emit("info", message, options)) as TimelineToastApi;
    api.error = (message, options) => emit("error", message, options);
    api.success = (message, options) => emit("success", message, options);
    api.warning = (message, options) => emit("warning", message, options);
    api.info = (message, options) => emit("info", message, options);
    api.loading = (message, options) => {
        const id = options?.id ?? `opennan-toast-${++generatedId}`;
        return emit("loading", message, { ...options, id }) ?? id;
    };
    api.dismiss = (id) => {
        if (id) getDismiss()?.(id);
    };
    return api;
}

export const NOOP_TOAST: TimelineToastApi = createToastApi(() => undefined, () => undefined);
