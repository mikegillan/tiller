import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Native modal dialog. Escape and a backdrop click call `onClose`; omit it for dialogs that must be answered. */
export function Modal({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Children mount once the dialog is open, so their autoFocus lands (nothing in a closed dialog can take focus).
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => { ref.current?.showModal(); setShown(true); }, []);
  return (
    <dialog
      ref={ref}
      className="dlg"
      aria-label={title}
      onCancel={(e) => { e.preventDefault(); onClose?.(); }}
      // Chrome skips cancel and closes anyway on a repeated Escape; reopen a dialog that must be answered.
      onClose={(e) => (onClose ? onClose() : e.currentTarget.isConnected && e.currentTarget.showModal())}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="modal">
        <h2>{title}</h2>
        {shown && children}
      </div>
    </dialog>
  );
}
