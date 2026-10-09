// Thin client for the daemon's POST /api/<tool>. Inside a node it uses O8_NODE_ID / O8_TOKEN_FILE / O8_ENDPOINT;
// outside it acts as `human` with the admin token in <home>/admin-token.
import { attach } from './attach.js';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { daemonPort as portFor, findDaemon, pickOrchestrator, startDaemon } from './up.js';

const usage = () => `o8: control orchestr8. With no arguments, start the daemon if needed and attach to this directory's orchestrator.

  o8 [up] [--new] [--title T] [--prompt P]            start daemon if needed; attach to (or create) this directory's orchestrator
  o8 status | stop                                    show or stop the daemon (o8d runs it in the foreground)
  o8 new <title> [--cwd P] [--model M] [--prompt T]   start a Claude node and attach to it
  o8 ps | list                                        show nodes
  o8 attach <id>                                      view a node's terminal (Ctrl-\\ then d detach, n/p next/prev, ! needs you, b back, l list, 1-9 jump)
  o8 resume <id>                                      relaunch an exited Claude node
  o8 kill <id...> | close <id...>                     close and delete nodes
  o8 send <id> "text"
  o8 read <id> [summary|transcript|terminal] [--lines N]
  o8 spawn --kind claude|terminal --title T --cwd PATH [--prompt P] [--model M] [--permission-mode M] [--request-id ID]
  o8 help`;

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const home = process.env.O8_HOME ?? join(homedir(), '.orchestr8');
const readHome = (name: string) => readFileSync(join(home, name), 'utf8').trim();
const daemonPort = () => portFor(home);

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

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv[0]?.startsWith('-') ? ['up', ...argv] : argv; // `o8 --new` means `o8 up --new`
const { values: f, positionals: pos } = parseArgs({
  args: rest, allowPositionals: true,
  options: {
    kind: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' },
    'permission-mode': { type: 'string' }, new: { type: 'boolean' }, 'request-id': { type: 'string' }, lines: { type: 'string' },
  },
});

switch (cmd) {
  case 'list': await call('list_nodes', {}); break;
  case 'ps':
    for (const n of (await call('list_nodes', {}, false)).data ?? []) console.log([n.id, n.state, n.title, n.parentId ?? '-', n.age].join('\t'));
    break;
  case 'attach':
    if (!pos[0]) fail(usage());
    process.exit(await attach(pos[0], { port: daemonPort(), token: readHome('admin-token') }));
    break;
  case 'new': {
    if (!pos[0]) fail(usage());
    const { data } = await call('spawn', { kind: 'claude', title: pos.join(' '), cwd: resolve(f.cwd ?? process.cwd()), prompt: f.prompt, model: f.model }, false);
    process.exit(await attach(data.nodeId, { port: daemonPort(), token: readHome('admin-token') }));
    break;
  }
  case 'resume':
    if (!pos[0]) fail(usage());
    await call('resume', { nodeId: pos[0] });
    break;
  case 'spawn':
    await call('spawn', { kind: f.kind, title: f.title, cwd: f.cwd ?? process.cwd(), prompt: f.prompt, model: f.model, permissionMode: f['permission-mode'], requestId: f['request-id'] });
    break;
  case 'send':
    if (pos.length < 2) fail(usage());
    await call('send', { nodeId: pos[0], text: pos.slice(1).join(' ') });
    break;
  case 'read':
    if (!pos[0]) fail(usage());
    await call('read', { nodeId: pos[0], what: pos[1] ?? 'summary', lines: f.lines ? Number(f.lines) : undefined });
    break;
  case 'close':
  case 'kill':
    if (!pos.length) fail(usage());
    await call('close', { nodeIds: pos });
    break;
  case undefined:
  case 'up': {
    const port = daemonPort();
    if (!(await findDaemon(port))) await startDaemon(home, port).catch((e: Error) => fail(e.message));
    const cwd = realpathSync(process.cwd());
    const existing = f.new ? undefined : pickOrchestrator(((await call('list_nodes', {}, false)).data ?? []) as any[], cwd);
    let id: string;
    if (existing) { console.log(`reattaching to ${existing.title} (${existing.id})`); id = existing.id; }
    else id = (await call('spawn', { kind: 'claude', title: f.title ?? basename(cwd), cwd, prompt: f.prompt }, false)).data.nodeId;
    process.exit(await attach(id, { port, token: readHome('admin-token') }));
    break;
  }
  case 'status': {
    const h = await findDaemon(daemonPort());
    if (!h) { console.log('no daemon'); break; }
    const n = ((await call('list_nodes', {}, false)).data ?? []).length;
    console.log(`daemon pid ${h.pid}, home ${h.home}, port ${daemonPort()}, ${n} node${n === 1 ? '' : 's'}`);
    break;
  }
  case 'stop':
    if (!(await findDaemon(daemonPort()))) { console.log('no daemon'); break; }
    await call('shutdown', {}, false);
    console.log('daemon stopped');
    break;
  case 'help': console.log(usage()); break;
  default: fail(usage());
}
