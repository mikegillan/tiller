import { fmtAge, usageParts } from '../src/shared/format';
import type { RateLimit, UsageSource } from '../src/shared/protocol';
import { usageStale, usageToolName } from '../src/shared/usage';
import { useNow } from './hooks';
import { refreshUsage } from './conn';
import { Modal } from './Modal';
import { useStore } from './store';
import openaiLogo from './assets/usage/openai.svg';
import claudeLogo from './assets/usage/claude.png';
import './usage.css';

export function UsageWindows({ source, now }: { source: UsageSource; now: number }) {
  return <>{usageParts(source.rateLimits, false, now).map((part, i) => (
    <span key={i} className={`ctx ${part.level}`}><span className="pct">{part.text}{(!source.rateLimits[i].resetsAt || !Number.isFinite(Date.parse(source.rateLimits[i].resetsAt!))) && ' · reset unknown'}</span></span>
  ))}</>;
}

const windowNames: Record<string, string> = {
  five_hour: '5-hour limit', '5h': '5-hour limit', seven_day: 'Weekly limit', '7d': 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit',
};

function QuotaWindow({ limit, title, now }: { limit: RateLimit; title?: string; now: number }) {
  const name = windowNames[limit.kind] ?? limit.kind;
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  const expired = reset <= now;
  const valid = Number.isFinite(limit.percentUsed) && limit.percentUsed >= 0;
  const percent = Math.round(limit.percentUsed);
  const resetText = !Number.isFinite(reset) ? 'Reset time unavailable'
    : expired ? 'Reset passed · awaiting update'
    : `Resets ${new Date(reset).toLocaleString([], { ...(reset - now >= 86_400_000 ? { weekday: 'short' as const, month: 'short' as const, day: 'numeric' as const } : {}), hour: 'numeric', minute: '2-digit' })}`;
  return <div className="usage-quota">
    <div className="usage-quota-heading"><span>{title ?? name}</span><span className="usage-percent">{valid && !expired ? `${percent}% used` : 'Awaiting update'}</span></div>
    {valid && !expired && <progress className={percent > 95 ? 'usage-critical' : percent > 80 ? 'usage-warning' : ''} aria-label={`${title ?? name}: ${name}`} max={100} value={Math.min(100, limit.percentUsed)} aria-valuetext={`${percent}% used`} />}
    <p className="usage-caption">{title && <>{name} · </>}{resetText}{limit.observedAt !== undefined && now - limit.observedAt > 300_000 && ' · Stale reading'}</p>
  </div>;
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const sources = useStore((s) => s.usageSources);
  const scanning = useStore((s) => s.usageScanning);
  const connected = useStore((s) => s.connected);
  const nodes = useStore((s) => s.nodes);
  const now = useNow();
  const tools = (['codex', 'claude', 'pi'] as const).filter((tool) => {
    const discovery = sources?.find((source) => source.id === `discovery:${tool}`);
    return discovery ? discovery.installed === true : sources?.some((source) => source.tool === tool && source.installed === true);
  });
  return <Modal title="Usage" className="modal usage-panel" onClose={onClose}>
    <p className="usage-subtitle">Account limits for installed CLIs</p>
    {!connected && <p className="usage-notice" role="status">Disconnected. Retained usage may be out of date.</p>}
    {!sources && <p className="usage-notice" role="status">{connected ? 'Waiting for CLI usage…' : 'Connect to load CLI usage.'}</p>}
    {sources && tools.length === 0 && <p className="usage-notice" role="status">{scanning ? 'Checking installed CLIs…' : 'No supported CLIs detected.'}</p>}
    {tools.map((tool) => {
      const name = usageToolName(tool);
      const discovery = sources?.find((source) => source.id === `discovery:${tool}`);
      const reports = sources?.filter((source) => source.tool === tool && source.at !== undefined && source.rateLimits.length > 0) ?? [];
      return <section className="usage-cli" key={tool} aria-label={name}>
        <div className="usage-brand" aria-hidden="true">{tool !== 'pi' && <img className={tool === 'codex' ? 'usage-openai-logo' : undefined} src={tool === 'codex' ? openaiLogo : claudeLogo} alt="" width="24" height="24" />}</div>
        <div className="usage-cli-content">
          <h3 className={reports.length === 1 ? 'usage-sr-only' : ''}>{name}</h3>
          {reports.map((source, index) => {
            const unavailable = sources?.some((candidate) => candidate.tool === tool && candidate.at === undefined && candidate.availability === 'unavailable' && candidate.nodeIds.some((id) => source.nodeIds.includes(id)));
            return <div className="usage-quota-report" key={source.id}>
            {reports.length > 1 && <p className="usage-report-label">Separate quota {index + 1}{source.scope === 'model' && source.model ? ` · ${source.model}` : ''}</p>}
            {source.rateLimits.map((limit, i) => <QuotaWindow key={limit.windowId ?? `${limit.kind}:${i}`} limit={limit} title={i === 0 && reports.length === 1 ? name : undefined} now={now} />)}
            {(usageStale(source, now) || source.nodeIds.every((id) => !nodes[id] || nodes[id].status.exited) || unavailable) && <p className="usage-caption">{unavailable ? 'Usage unavailable · ' : ''}Last report: {fmtAge(now - source.at!)}{now - source.at! >= 1000 ? ' ago' : ''} · may be out of date</p>}
            {reports.length === 1 && source.scope === 'model' && source.model && <p className="usage-caption">{source.model} model limit</p>}
          </div>; })}
          {!reports.length && <p className="usage-caption" role="status">{discovery?.executableStatus === 'broken' ? `Unable to run ${name}. Check the CLI installation.` : tool === 'pi' ? 'Pi does not report account limits.' : scanning ? 'Checking usage…' : `Open ${name} to load usage.`}</p>}
        </div>
      </section>;
    })}
    <div className="usage-actions"><button className="btn" disabled={!connected || scanning} onClick={refreshUsage}>{scanning ? 'Refreshing…' : 'Refresh'}</button><button className="btn" autoFocus onClick={onClose}>Close</button></div>
  </Modal>;
}
