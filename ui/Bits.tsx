import type { NodeView } from '../src/shared/protocol';
import { ctxLevel, fmtTokens, shortEffort, shortModel } from '../src/shared/format';
import { KIND_LABEL, type StatusKind } from './tree';

export const StateDot = ({ kind }: { kind: StatusKind }) => <span className={`dot ${kind}`} title={KIND_LABEL[kind]} />;

export function CtxBar({ pct }: { pct: number }) {
  return (
    <span className={`ctx ${ctxLevel(pct)}`} title={`context ${Math.round(pct)}% used`}>
      <span className="bar"><i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
      <span className="pct">{Math.round(pct)}%</span>
    </span>
  );
}

/** A worktree node with commits or files its base does not have yet, once its work has stopped: someone should merge or close it. */
export const hasChanges = (node: NodeView): boolean => {
  const g = node.status.git;
  return !!g && !g.mergedAt && g.ahead + g.dirty > 0 && (!!node.status.exited || node.status.state === 'done');
};

/** A worktree node whose branch has commits for its base and that is not working. */
export const canMerge = (node: NodeView): boolean => {
  const g = node.status.git;
  return !!g && !g.mergedAt && g.ahead > 0 && (!!node.status.exited || node.status.state !== 'working');
};

/** `⎇ o8/n-3f2a · ↑2 · 1 dirty · opus 5.5 · high · [bar] 42% · $0.42`; null when the node reports none of it. */
export function NodeMeta({ node, detail }: { node: NodeView; detail?: boolean }) {
  const s = node.status, wt = node.worktree, g = s.git;
  const model = shortModel(s.model ?? node.model);
  const parts = [
    wt && <span className="branch" title={`branch ${wt.branch} from ${wt.base}`}>⎇ {wt.branch}</span>,
    g && g.ahead > 0 && <span title={`${g.ahead} commit(s) not in ${g.base}${g.behind ? `; ${g.base} has ${g.behind} not on the branch` : ''}`}>↑{g.ahead}</span>,
    g && g.dirty > 0 && <span title="uncommitted files in the worktree">{g.dirty} dirty</span>,
    g?.mergedAt && <span title={`merged into ${g.base}`}>merged</span>,
    (wt?.missing || g?.missing) && <span className="warn" title="the worktree directory is gone; resume is refused">missing</span>,
    model && <span>{model}</span>,
    s.effort && <span>{shortEffort(s.effort)}</span>,
    s.contextPct !== undefined && <CtxBar pct={s.contextPct} />,
    detail && s.contextTokens && s.contextWindow ? <span>{fmtTokens(s.contextTokens)}/{fmtTokens(s.contextWindow)}</span> : null,
    s.costUsd !== undefined && <span>${s.costUsd.toFixed(2)}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="meta">{parts.map((p, i) => <span className="part" key={i}>{p}</span>)}</div>;
}
