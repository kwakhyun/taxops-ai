"use client";

import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

/** Native top-layer dialogs stay clear of table clipping and sticky headers. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  header,
  className = "",
  closeLabel = "닫기",
  closeDisabled = false,
  returnFocusRef,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  className?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const trigger = returnFocusRef?.current ?? document.activeElement;
    const overflow = document.body.style.overflow;
    const viewport = window.visualViewport;
    const resize = () => {
      if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return;
      dialog.style.setProperty(
        "--dialog-viewport-height",
        `${viewport.height}px`,
      );
      dialog.style.setProperty(
        "--dialog-viewport-top",
        `${viewport.offsetTop}px`,
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      dialog.close();
      document.body.style.overflow = overflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open, returnFocusRef]);

  return (
    <dialog
      ref={ref}
      className={`app-dialog ${className}`}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "a[href], button, input, select, textarea, summary, [tabindex]",
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled, [inert]") &&
            element.getClientRects().length > 0,
        );
        const first = focusable.at(0);
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || closeDisabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      {open ? (
        <div className="app-dialog-frame">
          {header ? (
            <>
              <h2 className="sr-only" id={titleId}>
                {title}
              </h2>
              {header}
            </>
          ) : (
            <header className="app-dialog-header">
              <h2 id={titleId}>{title}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label={closeLabel}
                onClick={onClose}
                disabled={closeDisabled}
                autoFocus
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
          )}
          <div
            className="app-dialog-body"
            tabIndex={0}
            role="region"
            aria-label={`${title} 내용`}
          >
            {children}
          </div>
          {footer ? <div className="app-dialog-footer">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
