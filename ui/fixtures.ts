import type { ClaudeAccountView, NodeView } from '../src/shared/protocol';

export const mk = (id: string, parentId: string | null, changedAt: number, extra: Partial<NodeView['status']> = {}): NodeView => ({
  id, parentId, kind: 'claude', title: id, cwd: '/w/' + id, createdAt: 0, unread: false,
  status: { state: 'working', changedAt, ...extra },
});

/** Configured Claude accounts: a logged-in default, a logged-in work account and one that is logged out. */
export const claudeAccounts: ClaudeAccountView[] = [
  { name: 'personal', projects: [], isDefault: true, loggedIn: true, email: 'me@example.com', loginCommand: 'claude auth login' },
  { name: 'work', configDir: '/Users/me/.claude-work', projects: ['/Users/me/work'], isDefault: false, loggedIn: true, email: 'me@work.example', orgName: 'Work Inc', loginCommand: 'CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login' },
  { name: 'client', configDir: '/Users/me/.claude-client', projects: [], isDefault: false, loggedIn: false, loginCommand: 'CLAUDE_CONFIG_DIR=/Users/me/.claude-client claude auth login' },
];
