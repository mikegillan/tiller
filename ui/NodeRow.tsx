import { ActionButtons } from './ActionButtons';
import { CtxBar, GateMark, hasChanges, StateDot } from './Bits';
import { shortModel, fmtAge } from '../src/shared/format';
import { useNow } from './hooks';
import { Icon } from './icons';
import { RenameInput } from './RenameInput';
import { selectNode, toggleCollapsed, useStore } from './store';
import { needsYou } from '../src/shared/protocol';
import { kindTag, KIND_LABEL, statusKind, type Row } from './tree';

export function NodeRow({ row }: { row: Row }) {
  const { node, depth, hasChildren, collapsed, descendants } = row;
  const now = useNow();
  const selected = useStore((s) => s.selected === node.id);
  const renaming = useStore((s) => s.renaming === node.id);
  const s = node.status;
  const needs = descendants.filter((d) => needsYou(d.status)).length;
  const blocked = s.state === 'blocked' && !s.exited;
  const kind = statusKind(node);
  const state = kind === 'needs' ? s.state : KIND_LABEL[kind];

  return (
    <div className={`row${selected ? ' sel' : ''}`} role="treeitem" aria-selected={selected} aria-level={depth + 1} aria-expanded={hasChildren ? !collapsed : undefined}
      data-id={node.id} onClick={() => selectNode(node.id)}>
      {row.guides.map((g, i) => <span key={i} className={`g${g ? ' v' : ''}`} />)}
      {depth > 0 && <span className={`g e${row.last ? '' : ' t'}`} />}
      <div className="body">
        <div className="l1">
          {hasChildren ? (
            <button className={`caret${collapsed ? '' : ' open'}`} aria-label={collapsed ? 'Expand' : 'Collapse'}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(node.id); }}><Icon name="chevron" size={12} /></button>
          ) : <span className={`caret${depth > 0 ? ' stub' : ''}`} />}
          <StateDot kind={kind} />
          {renaming ? <RenameInput id={node.id} title={node.title} /> : <span className={`title${s.exited ? ' dim' : ''}`} title={node.title}>{node.title}</span>}
          {node.unread && <i className="unread" title="unread" />}
          {node.muted && <span className="muted" title="notifications muted"><Icon name="bellOff" size={11} /></span>}
          <ActionButtons node={node} />
        </div>
        <div className="row-status">
          <span className={`row-state ${kind}`}>{state}</span>
          {s.activity && <span className={`row-activity${blocked ? ' warn' : ''}`} title={s.activity}>{s.activity}</span>}
          <span className="age">{fmtAge(now - s.changedAt)}</span>
        </div>
        {(node.gate || hasChanges(node) || collapsed || (s.stalled && !s.exited)) && <div className="row-signals">
          {node.gate && <GateMark gate={node.gate} />}
          {hasChanges(node) && <span className="count" title={`unmerged work on ${node.status.git!.branch}: merge or close it`}>changes</span>}
          {collapsed && <span className="count" title={`${descendants.length} hidden`}>+{descendants.length}</span>}
          {collapsed && needs > 0 && <span className="count warn">{needs} needs you</span>}
          {s.stalled && !s.exited && <span className="count warn" title="working with no hook event">no activity {fmtAge(now - s.changedAt)}</span>}
        </div>}
        <div className="row-meta">
          <span className="row-model" title={`${kindTag(node)}${s.model ?? node.model ? ` · ${s.model ?? node.model}` : ''}`}>{shortModel(s.model ?? node.model) || kindTag(node)}</span>
          {node.worktree && <span className="row-branch" title={`branch ${node.worktree.branch} from ${node.worktree.base}`}>{node.worktree.branch}</span>}
          {node.worktree?.missing && <span className="warn" title="the worktree directory is gone; resume is refused">missing</span>}
          {s.contextPct !== undefined && <CtxBar pct={s.contextPct} />}
        </div>
      </div>
    </div>
  );
}
