import { fmtAge, usageParts } from '../src/shared/format';
import type { UsageSource } from '../src/shared/protocol';
import { usageScope, usageStale, usageToolName } from '../src/shared/usage';
import { useNow } from './hooks';
import { refreshUsage } from './conn';
import { Modal } from './Modal';
import { useStore } from './store';

export function UsageWindows({ source, now }: { source: UsageSource; now: number }) {
  return <>{usageParts(source.rateLimits, false, now).map((part, i) => (
    <span key={i} className={`ctx ${part.level}`}><span className="pct">{part.text}{(!source.rateLimits[i].resetsAt || !Number.isFinite(Date.parse(source.rateLimits[i].resetsAt!))) && ' · reset unknown'}</span></span>
  ))}</>;
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const sources = useStore((s) => s.usageSources);
  const scanning = useStore((s) => s.usageScanning);
  const connected = useStore((s) => s.connected);
  const nodes = useStore((s) => s.nodes);
  const now = useNow();
  return <Modal title="CLI usage" className="modal usage-panel" onClose={onClose}>
    <p>Account quotas reported by your CLI tools. Context tokens and dollar spend are tracked separately.</p>
    <p>Supported tools are detected on the daemon’s launch PATH. Version checks are cached for one minute.</p>
    <div className="usage-scan"><button className="btn" disabled={!connected || !sources || scanning} onClick={refreshUsage}>{scanning ? 'Scanning tools…' : 'Rescan tools'}</button>
      {sources?.[0] && <span>Last checked {fmtAge(now - sources[0].checkedAt)} ago</span>}
    </div>
    {!connected && <p>Daemon disconnected. Showing retained reports.</p>}
    {!sources && <p>This daemon has no source overview yet. Reconnect to an updated daemon to discover CLI tools.</p>}
    {(['claude', 'codex', 'pi'] as const).map((tool) => {
      const discovery = sources?.find((s) => s.id === `discovery:${tool}`);
      const unavailable = sources?.filter((s) => s.tool === tool && s.at === undefined && s.nodeIds.length > 0 && s.availability === 'unavailable') ?? [];
      const reports = sources?.filter((s) => s.tool === tool && s.at !== undefined) ?? [];
      return <section className="usage-tool" key={tool} aria-label={usageToolName(tool)}>
        <h3>{usageToolName(tool)}</h3>
        <p>{discovery?.installed ? 'Detected' : discovery?.installed === false ? 'Not found on daemon PATH' : 'Installation unknown'}
          {' · '}{reports.length || discovery?.configured ? 'configured' : 'configuration unknown'}
          {' · '}{reports.length ? 'authenticated at last report' : 'authentication unknown'}</p>
        {discovery?.version && <p>{discovery.version}</p>}
        {discovery?.executableStatus === 'broken' && <p>Detected, but the version check failed. Check that this CLI runs correctly before opening an agent.</p>}
        {unavailable.map((source) => <p key={source.id}>{source.nodeIds.map((id) => nodes[id]?.title ?? 'Closed agent').join(', ')} · {source.detail}</p>)}
        {reports.length === 0 && unavailable.length === 0 && <p>{discovery?.detail ?? 'No quota report available.'}</p>}
        {reports.map((source) => <div className="usage-report" key={source.id}>
          <div className="usage-scope">{source.pool || usageScope(source)}{source.pool && ` · ${usageScope(source)}`}{source.provider && ` · ${source.provider}`}</div>
          <p>{source.accountId ? `Account ${source.accountId}` : `Account identity not reported · ${source.nodeIds.map((id) => nodes[id]?.title ?? 'closed agent').join(', ') || 'previous agent'}`}</p>
          <div className="usage-windows"><UsageWindows source={source} now={now} /></div>
          <p>{usageStale(source, now) || source.nodeIds.every((id) => !nodes[id] || nodes[id].status.exited) ? 'Stale · ' : ''}Reported {fmtAge(now - source.at!)} ago</p>
        </div>)}
      </section>;
    })}
    <div className="btns"><button className="btn" autoFocus onClick={onClose}>Close</button></div>
  </Modal>;
}
