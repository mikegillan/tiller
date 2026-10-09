// Thin client for the daemon's POST /api/<tool>. Inside a node it uses O8_NODE_ID / O8_TOKEN_FILE / O8_ENDPOINT;
// outside it acts as `human` with the admin token in <home>/admin-token.
import { attach } from './attach.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `usage:
  o8 list | ps
  o8 attach <id>        (detach with Ctrl-\ then d)
  o8 spawn --kind claude|terminal --title T --cwd PATH [--prompt P] [--model M] [--permission-mode M] [--request-id ID]
  o8 send <id> "text"
  o8 read <id> [summary|transcript|terminal] [--lines N]
  o8 close <id...>`;

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const home = process.env.O8_HOME ?? join(homedir(), '.orchestr8');
const readHome = (name: string) => readFileSync(join(home, name), 'utf8').trim();
const daemonPort = () => Number(process.env.O8_PORT ?? (() => { try { return readHome('port'); } catch { return 7788; } })());

async function call(tool: string, args: Record<string, unknown>, print = true): Promise<{ data?: any }> {
  const env = process.env;
  const node = env.O8_NODE_ID && env.O8_TOKEN_FILE;
  let token: string;
  try { token = readFileSync(node ? env.O8_TOKEN_FILE! : join(home, 'admin-token'), 'utf8').trim(); }
  catch (e) { return fail(`cannot read token (is the daemon running?): ${(e as Error).message}`); }
  const endpoint = env.O8_ENDPOINT ?? `http://127.0.0.1:${daemonPort()}`;
  const res = await fetch(`${endpoint}/api/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': node ? env.O8_NODE_ID! : 'human', 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).catch((e: Error) => fail(`cannot reach daemon at ${endpoint}: ${e.message}`));
  if (res.status === 401) return fail('unauthorized: bad token, or the node no longer exists');
  const body = (await res.json().catch(() => ({}))) as { text?: string; data?: any; error?: string };
  if (!res.ok) return fail(body.error ?? `HTTP ${res.status}`);
  if (print) console.log(body.text ?? JSON.stringify(body.data, null, 2));
  return body;
}

const [cmd, ...rest] = process.argv.slice(2);
const { values: f, positionals: pos } = parseArgs({
  args: rest, allowPositionals: true,
  options: {
    kind: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' },
    'permission-mode': { type: 'string' }, 'request-id': { type: 'string' }, lines: { type: 'string' },
  },
});

switch (cmd) {
  case 'list': await call('list_nodes', {}); break;
  case 'ps':
    for (const n of (await call('list_nodes', {}, false)).data ?? []) console.log([n.id, n.state, n.title, n.parentId ?? '-', n.age].join('\t'));
    break;
  case 'attach':
    if (!pos[0]) fail(USAGE);
    process.exit(await attach(pos[0], { port: daemonPort(), token: readHome('admin-token') }));
    break;
  case 'spawn':
    await call('spawn', { kind: f.kind, title: f.title, cwd: f.cwd ?? process.cwd(), prompt: f.prompt, model: f.model, permissionMode: f['permission-mode'], requestId: f['request-id'] });
    break;
  case 'send':
    if (pos.length < 2) fail(USAGE);
    await call('send', { nodeId: pos[0], text: pos.slice(1).join(' ') });
    break;
  case 'read':
    if (!pos[0]) fail(USAGE);
    await call('read', { nodeId: pos[0], what: pos[1] ?? 'summary', lines: f.lines ? Number(f.lines) : undefined });
    break;
  case 'close':
    if (!pos.length) fail(USAGE);
    await call('close', { nodeIds: pos });
    break;
  default: fail(USAGE);
}
