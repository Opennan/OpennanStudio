// Modal focus handling (WAI-ARIA dialog pattern): focus moves into the dialog when it opens (an element marked
// data-autofocus, else the first focusable), Tab and Shift+Tab stay inside, and focus returns to whatever had it
// before the dialog opened. Escape closes only the topmost dialog.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
    "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])", "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableIn(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden],[aria-hidden='true'],[inert]"));
}

const stack: Array<RefObject<HTMLElement | null>> = [];

/** True when `ref` is the most recently opened modal (Escape and Enter belong to it). */
export function isTopmost(ref: RefObject<HTMLElement | null>): boolean {
    return stack[stack.length - 1] === ref;
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
    const escape = useRef(onEscape);
    escape.current = onEscape;
    useEffect(() => {
        const container = ref.current;
        if (!container) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        stack.push(ref);
        if (!container.contains(document.activeElement)) {
            const target = container.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(container)[0] ?? container;
            target.focus();
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isTopmost(ref)) return;
            if (event.key === "Escape") {
                if (escape.current) {
                    event.preventDefault();
                    escape.current();
                }
                return;
            }
            if (event.key !== "Tab") return;
            const items = focusableIn(container);
            if (items.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }
            const first = items[0]!;
            const last = items[items.length - 1]!;
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !container.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !container.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            const index = stack.lastIndexOf(ref);
            if (index >= 0) stack.splice(index, 1);
            if (previous && previous.isConnected) previous.focus();
        };
    }, [ref]);
}
