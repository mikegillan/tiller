import { ActionButtons } from './ActionButtons';
import { hasChanges, NodeMeta, StateDot } from './Bits';
import { fmtAge } from '../src/shared/format';
import { subtreeSpend } from '../src/shared/spend';
import { useNow } from './hooks';
import { Icon } from './icons';
import { RenameInput } from './RenameInput';
import { selectNode, toggleCollapsed, useStore } from './store';
import { needsYou, statusKind, type Row } from './tree';

export function NodeRow({ row }: { row: Row }) {
  const { node, depth, hasChildren, collapsed, descendants } = row;
  const now = useNow();
  const selected = useStore((s) => s.selected === node.id);
  const renaming = useStore((s) => s.renaming === node.id);
  const s = node.status;
  const needs = descendants.filter(needsYou).length;
  const blocked = s.state === 'blocked' && !s.exited;

  return (
    <div className={`row${selected ? ' sel' : ''}`} role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? !collapsed : undefined}
      data-id={node.id} onClick={() => selectNode(node.id)}>
      {row.guides.map((g, i) => <span key={i} className={`g${g ? ' v' : ''}`} />)}
      {depth > 0 && <span className={`g e${row.last ? '' : ' t'}`} />}
      <div className="body">
        <div className="l1">
          {hasChildren ? (
            <button className={`caret${collapsed ? '' : ' open'}`} aria-label={collapsed ? 'Expand' : 'Collapse'}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(node.id); }}><Icon name="chevron" size={12} /></button>
          ) : <span className={`caret${depth > 0 ? ' stub' : ''}`} />}
          <StateDot kind={statusKind(node)} />
          {renaming ? <RenameInput id={node.id} title={node.title} /> : <span className={`title${s.exited ? ' dim' : ''}`}>{node.title}</span>}
          {node.unread && <i className="unread" title="unread" />}
          {hasChanges(node) && <span className="count" title={`unmerged work on ${node.status.git!.branch}: merge or close it`}>changes</span>}
          {collapsed && <span className="count" title={`${descendants.length} hidden`}>+{descendants.length}</span>}
          {collapsed && needs > 0 && <span className="count warn">{needs} needs you</span>}
          {s.stalled && !s.exited && <span className="count warn" title="working with no hook event">no activity {fmtAge(now - s.changedAt)}</span>}
          <span className="age">{s.exited ? 'exited' : fmtAge(now - s.changedAt)}</span>
          <ActionButtons node={node} />
        </div>
        {s.activity && <div className={`l2${blocked ? ' warn' : ''}`} title={s.activity}>{s.activity}</div>}
        <NodeMeta node={node} subtree={hasChildren ? subtreeSpend([node, ...descendants], node.id) : undefined} />
      </div>
    </div>
  );
}
