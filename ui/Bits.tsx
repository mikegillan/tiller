import type { NodeView } from '../src/shared/protocol';
import { shortEffort, shortModel } from '../src/shared/format';
import { ctxLevel, fmtTokens } from './format';
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

/** `opus 5.5 · high · [bar] 42% · $0.42`; null when the node reports none of it. */
export function NodeMeta({ node, detail }: { node: NodeView; detail?: boolean }) {
  const s = node.status;
  const model = shortModel(s.model ?? node.model);
  const parts = [
    model && <span key="m">{model}</span>,
    s.effort && <span key="e">{shortEffort(s.effort)}</span>,
    s.contextPct !== undefined && <CtxBar key="c" pct={s.contextPct} />,
    detail && s.contextTokens && s.contextWindow ? <span key="t">{fmtTokens(s.contextTokens)}/{fmtTokens(s.contextWindow)}</span> : null,
    s.costUsd !== undefined && <span key="$">${s.costUsd.toFixed(2)}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="meta">{parts.map((p, i) => <span className="part" key={i}>{p}</span>)}</div>;
}
