const FAMILY = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/;

/** "claude-opus-5-5" -> "opus 5.5"; other ids lose a leading "claude-". */
export function shortModel(model?: string): string {
  if (!model) return '';
  const m = FAMILY.exec(model);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model.replace(/^claude-/, '');
}

export const shortEffort = (level: string): string => (level === 'medium' ? 'med' : level);
