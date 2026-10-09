import { selectNode, toggleCollapsed, useStore } from './store';
import { KIND_LABEL, fmtAge, statusKind, type Row } from './tree';

export function NodeRow({ row, now }: { row: Row; now: number }) {
  const { node, depth, hasChildren, collapsed, descendants } = row;
  const selected = useStore((s) => s.selected === node.id);
  const kind = statusKind(node);
  const needs = descendants.filter((d) => statusKind(d) === 'needs').length;
  const unread = descendants.filter((d) => d.unread).length;
  return (
    <div className={`row${selected ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => selectNode(node.id)}>
      <span
        className={`caret${hasChildren ? '' : ' none'}`}
        onClick={(e) => { e.stopPropagation(); toggleCollapsed(node.id); }}
      >{collapsed ? '▸' : '▾'}</span>
      <span className={`dot ${kind}`} title={KIND_LABEL[kind]} />
      <span className="title">{node.title}</span>
      {collapsed && needs > 0 && <span className="badge">{needs} needs you</span>}
      {collapsed && unread > 0 && <span className="unread" title={`${unread} unread below`} />}
      {node.unread && <span className="unread" title="unread" />}
      <span className="glyph">{node.kind === 'claude' ? 'C' : '$'}</span>
      <span className="age">{fmtAge(now - node.status.changedAt)}</span>
    </div>
  );
}
