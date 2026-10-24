import type { ClaudeAccountView, Conversation, NodeView } from '../src/shared/protocol';

export const mk = (id: string, parentId: string | null, changedAt: number, extra: Partial<NodeView['status']> = {}): NodeView => ({
  id, parentId, kind: 'claude', title: id, cwd: '/w/' + id, createdAt: 0, unread: false,
  status: { state: 'working', changedAt, ...extra },
});

const T = 1_700_000_000_000, M = 60_000;
/** An upward conversation: root "tiller" briefs worker "probes"; a queued message, a legacy one, an outcome, a notice and a merge. */
export const conversation: Conversation = {
  a: 'root', b: 'w', relation: 'parent', titles: { root: 'tiller', w: 'probes' },
  items: [
    { kind: 'brief', at: T, from: 'root', text: 'Coalesce the login probes.' },
    { kind: 'turn', at: T + M, from: 'w', role: 'assistant', text: '', tools: ['Read', 'Grep'] },
    { kind: 'turn', at: T + 2 * M, from: 'w', role: 'assistant', text: 'Reading the probe code.', tools: ['Bash'] },
    { kind: 'message', at: T + 9 * M, sentAt: T + 9 * M, from: 'w', to: 'root', text: 'Implementation done; adding tests.', messageId: 'm1', delivery: 'delivered' },
    { kind: 'message', at: T + 14 * M, sentAt: T + 11 * M, from: 'root', to: 'w', text: 'Also cover the 5 s window.', messageId: 'm2', delivery: 'delivered' },
    { kind: 'message', at: T + 15 * M, sentAt: T + 15 * M, from: 'root', to: 'w', text: 'Still there?', messageId: 'm3', delivery: 'queued' },
    { kind: 'message', at: T + 16 * M, sentAt: T + 16 * M, from: 'w', to: 'root', messageId: 'm4', delivery: 'delivered' },
    { kind: 'outcome', at: T + 19 * M, from: 'w', outcome: { outcome: 'succeeded', summary: 'Probes coalesced.', at: T + 19 * M } },
    { kind: 'message', at: T + 20 * M, sentAt: T + 20 * M, from: 'tiller', to: 'root', text: 'child w "probes" stopped: exited', messageId: 'm5', delivery: 'delivered' },
    { kind: 'event', at: T + 21 * M, id: 'w', text: 'merged tl/w into main' },
  ],
};

/** Configured Claude accounts: a logged-in default, a logged-in work account and one that is logged out. */
export const claudeAccounts: ClaudeAccountView[] = [
  { name: 'personal', projects: [], isDefault: true, loggedIn: true, email: 'me@example.com', loginCommand: 'claude auth login' },
  { name: 'work', configDir: '/Users/me/.claude-work', projects: ['/Users/me/work'], isDefault: false, loggedIn: true, email: 'me@work.example', orgName: 'Work Inc', loginCommand: 'CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login' },
  { name: 'client', configDir: '/Users/me/.claude-client', projects: [], isDefault: false, loggedIn: false, loginCommand: 'CLAUDE_CONFIG_DIR=/Users/me/.claude-client claude auth login' },
];
