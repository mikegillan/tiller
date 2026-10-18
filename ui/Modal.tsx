import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './modal.css';

/**
 * Native modal dialog. Escape and a backdrop click call `onClose`; omit it for dialogs that must be answered.
 * `title` is shown as a heading and names the dialog; `label` names a dialog without one. `className` replaces the `modal` box.
 * Opt content dialogs into `resizable`; put actions in `footer` to keep them outside the scrolling body.
 */
export function Modal({ title, label = title, className = 'modal', onClose, resizable = false, footer, children }: { title?: string; label?: string; className?: string; onClose?: () => void; resizable?: boolean; footer?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
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
      <div className={`${className}${resizable ? ` modal-resizable${expanded ? ' modal-expanded' : ''}` : ''}`}>
        {resizable ? <>
          <div className="modal-header">
            {title && <h2>{title}</h2>}
            <button type="button" className="btn modal-expand" aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Restore size' : 'Expand dialog'}
            </button>
          </div>
          <div className="modal-body" tabIndex={0} aria-label={label ? `${label} content` : 'Dialog content'}>{shown && children}</div>
        </> : <>{title && <h2>{title}</h2>}{shown && children}</>}
        {shown && footer && <div className="modal-footer">{footer}</div>}
      </div>
    </dialog>
  );
}
