const FAMILY = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/;

/** "claude-opus-5-5" -> "opus 5.5"; other ids lose a leading "claude-". */
export function shortModel(model?: string): string {
  if (!model) return '';
  const m = FAMILY.exec(model);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model.replace(/^claude-/, '');
}

export const shortEffort = (level: string): string => (level === 'medium' ? 'med' : level);

export function fmtAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type CtxLevel = 'ok' | 'warn' | 'bad';
/** Context use: green below 50%, amber up to 80%, red above. */
export const ctxLevel = (pct: number): CtxLevel => (pct < 50 ? 'ok' : pct <= 80 ? 'warn' : 'bad');

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
