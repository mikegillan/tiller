import { useEffect } from 'react';
import { send } from './conn';
import { Modal } from './controls/Modal';
import { fmtAge } from '../src/shared/format';
import { dismissDigest, dismissToast, dropConfirm, selectNode, useStore, type Toast } from './store';

function ToastItem({ t }: { t: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(t.id), 6000);
    return () => clearTimeout(timer);
  }, [t.id]);
  return (
    <div className={`toast ${t.tone}`} role="status" onClick={() => { if (t.nodeId) selectNode(t.nodeId); dismissToast(t.id); }}>{t.text}</div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts">{toasts.map((t) => <ToastItem key={t.id} t={t} />)}</div>;
}

/** An agent asks the human to approve an action. Must be answered; the daemon closes it on timeout. */
export function ConfirmModal() {
  const queue = useStore((s) => s.confirms);
  const c = queue[0];
  if (!c) return null;
  const answer = (ok: boolean) => { send({ t: 'confirm', confirmId: c.confirmId, ok }); dropConfirm(c.confirmId); };
  return (
    <Modal title={queue.length > 1 ? `Agent request (1 of ${queue.length})` : 'Agent request'}>
      <pre className="ask">{c.text}</pre>
      <div className="btns">
        <button className="btn danger" onClick={() => answer(false)}>Deny</button>
        <button className="btn primary" onClick={() => answer(true)}>Approve</button>
      </div>
    </Modal>
  );
}

const DIGEST_LABEL = { needsYou: 'Needs you', errored: 'Errored', finished: 'Finished' } as const;

/** What happened while you were away, needs-you first. A row selects its node. Waits behind agent requests. */
export function DigestCard() {
  const digest = useStore((s) => s.digest);
  const blocked = useStore((s) => s.confirms.length > 0);
  if (!digest || blocked) return null;
  return (
    <Modal title={`While you were away (${fmtAge(Date.now() - digest.since)})`} onClose={dismissDigest}>
      <ul className="digest">
        {digest.items.map((i) => (
          <li key={i.id}>
            <button className={`row ${i.kind}`} onClick={() => { selectNode(i.id); dismissDigest(); }}>
              <span className="kind">{DIGEST_LABEL[i.kind]}</span> <strong>{i.title}</strong>
              {i.text && <span className="text">{i.text}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="btns"><button className="btn primary" autoFocus onClick={dismissDigest}>Dismiss</button></div>
    </Modal>
  );
}
