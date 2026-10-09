import { useEffect } from 'react';
import { send } from './conn';
import { dismissToast, dropConfirm, selectNode, useStore, type Toast } from './store';

function ToastItem({ t }: { t: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(t.id), 6000);
    return () => clearTimeout(timer);
  }, [t.id]);
  return (
    <div className="toast" onClick={() => { if (t.nodeId) selectNode(t.nodeId); dismissToast(t.id); }}>{t.text}</div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts">{toasts.map((t) => <ToastItem key={t.id} t={t} />)}</div>;
}

export function ConfirmModal() {
  const c = useStore((s) => s.confirms[0]);
  if (!c) return null;
  const answer = (ok: boolean) => { send({ t: 'confirm', confirmId: c.confirmId, ok }); dropConfirm(c.confirmId); };
  return (
    <div className="overlay">
      <div className="modal">
        <p>{c.text}</p>
        <div className="btns"><button onClick={() => answer(true)}>Approve</button><button className="danger" onClick={() => answer(false)}>Deny</button></div>
      </div>
    </div>
  );
}
