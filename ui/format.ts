export const cwdBase = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() || cwd || '/';

export const titleFor = (needsYou: number) => (needsYou > 0 ? `(${needsYou}) orchestr8` : 'orchestr8');
