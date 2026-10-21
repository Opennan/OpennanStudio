import type { QueuedToast } from "./toast-queue";

export function ToastList({ toasts, onDismiss }: { toasts: QueuedToast[]; onDismiss(id: string): void }) {
    return (
        <ul className="toasts" aria-live="polite">
            {toasts.map((toast) => (
                <li key={toast.id} className="toast" data-kind={toast.kind} data-leaving={toast.leaving || undefined}>
                    {toast.icon && <span aria-hidden="true">{toast.icon}</span>}
                    <span className="toast-message">{toast.message}</span>
                    {toast.action && (
                        <button
                            type="button"
                            className="button ghost small toast-action"
                            onClick={() => {
                                toast.action!.run();
                                onDismiss(toast.id);
                            }}
                        >
                            {toast.action.label}
                        </button>
                    )}
                    <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>×</button>
                </li>
            ))}
        </ul>
    );
}
