import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Native modal dialog. Escape and a backdrop click call `onClose`; omit it for dialogs that must be answered.
 * `title` is shown as a heading and names the dialog; `label` names a dialog without one. `className` replaces the `modal` box.
 */
export function Modal({ title, label = title, className = 'modal', onClose, children }: { title?: string; label?: string; className?: string; onClose?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Children mount once the dialog is open, so their autoFocus lands (nothing in a closed dialog can take focus).
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => { ref.current?.showModal(); setShown(true); }, []);
  return (
    <dialog
      ref={ref}
      className="dlg"
      aria-label={label}
      onCancel={(e) => { e.preventDefault(); onClose?.(); }}
      // Chrome skips cancel and closes anyway on a repeated Escape; reopen a dialog that must be answered.
      onClose={(e) => (onClose ? onClose() : e.currentTarget.isConnected && e.currentTarget.showModal())}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className={className}>
        {title && <h2>{title}</h2>}
        {shown && children}
      </div>
    </dialog>
  );
}
