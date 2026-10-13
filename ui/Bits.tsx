import type { NodeView } from '../src/shared/protocol';
import { ctxLevel, fmtTokens, shortEffort, shortModel } from '../src/shared/format';
import { fmtUsd } from '../src/shared/spend';
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

/** `⎇ o8/n-3f2a · opus 5.5 · high · [bar] 42% · $0.42 · Σ$3.10`; null when the node reports none of it. `subtree`: spend with descendants. */
export function NodeMeta({ node, detail, subtree }: { node: NodeView; detail?: boolean; subtree?: number }) {
  const s = node.status, wt = node.worktree;
  const model = shortModel(s.model ?? node.model);
  const parts = [
    wt && <span className="branch" title={`branch ${wt.branch} from ${wt.base}`}>⎇ {wt.branch}</span>,
    wt?.missing && <span className="warn" title="the worktree directory is gone; resume is refused">missing</span>,
    model && <span>{model}</span>,
    s.effort && <span>{shortEffort(s.effort)}</span>,
    s.contextPct !== undefined && <CtxBar pct={s.contextPct} />,
    detail && s.contextTokens && s.contextWindow ? <span>{fmtTokens(s.contextTokens)}/{fmtTokens(s.contextWindow)}</span> : null,
    node.spentUsd !== undefined && <span title="spent, all sessions">{fmtUsd(node.spentUsd)}</span>,
    subtree !== undefined && subtree > (node.spentUsd ?? 0) && <span title="spent with descendants">Σ{fmtUsd(subtree)}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="meta">{parts.map((p, i) => <span className="part" key={i}>{p}</span>)}</div>;
}
