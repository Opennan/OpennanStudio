import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./focus-trap";

export function Dialog({ title, onClose, children, describedBy, className }: {
    title: string;
    onClose(): void;
    children?: ReactNode;
    /** id of the element that describes the dialog (aria-describedby). */
    describedBy?: string;
    className?: string;
}) {
    const titleId = useId();
    const panel = useRef<HTMLDivElement>(null);
    useFocusTrap(panel, onClose);
    return createPortal(
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div ref={panel} className={className ? `dialog ${className}` : "dialog"} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} tabIndex={-1}>
                <h2 id={titleId} className="dialog-title">{title}</h2>
                <div className="dialog-body">{children}</div>
            </div>
        </div>,
        document.body,
    );
}

export function ConfirmDialog(props: {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm(): Promise<void> | void;
    onCancel(): void;
}) {
    const messageId = useId();
    return (
        <Dialog title={props.title} onClose={props.onCancel} describedBy={messageId}>
            <p id={messageId} className="muted" style={{ margin: 0 }}>{props.message}</p>
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={props.onCancel}>Cancel</button>
                <button type="button" className="button danger" data-autofocus onClick={() => void props.onConfirm()}>{props.confirmLabel}</button>
            </div>
        </Dialog>
    );
}
