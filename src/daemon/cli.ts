// Thin client for the daemon's POST /api/<tool>. Inside a node it uses O8_NODE_ID / O8_TOKEN_FILE / O8_ENDPOINT;
// outside it acts as `human` with the admin token in <home>/admin-token.
import { mux } from '../client/mux.js';
import { attach } from './attach.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promptPath } from './launch.js';
import { daemonPort as portFor, findDaemon, pickOrchestrator, startDaemon } from './up.js';

const usage = () => `o8: control orchestr8. With no arguments, start the daemon if needed and open the app on this directory's orchestrator.

  o8 [up|app] [--new] [--title T] [--prompt P]        start daemon if needed; open the app on (or create) this directory's orchestrator
  o8 mux [--new] [--title T] [--prompt P]             the same, in the terminal multiplexer (also: o8-mux)
  o8 status | stop                                    show or stop the daemon (o8d runs it in the foreground)
  o8 new <title> [--cwd P] [--model M] [--prompt T] [--role R]  start a Claude node and attach to it in the terminal
  o8 ps | list                                        show nodes
  o8 attach <id> [--plain]                            open the sidebar client on a node (Ctrl-\\ ? for keys; --plain is the old single-pane view)
  o8 select <id>                                      show a node in the app (opens the app if it is built)
  o8 resume <id>                                      relaunch an exited Claude node
  o8 prune                                            remove every exited node that has no live descendant
  o8 restart <id>                                     relaunch a node with a fresh session (clears its context; children are kept)
  o8 kill [--force] <id...> | close <id...>           close and delete nodes (an orchestrator needs --force)
  o8 send <id> "text"
  o8 read <id> [summary|transcript|terminal] [--lines N]
  o8 spawn --kind claude|terminal --title T --cwd PATH [--prompt P] [--model M] [--permission-mode M] [--role orchestrator|worker|none] [--request-id ID]
  o8 prompts                                          show the role prompt files and any override for this directory
  o8 help`;

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const home = process.env.O8_HOME ?? join(homedir(), '.orchestr8');
const readHome = (name: string) => readFileSync(join(home, name), 'utf8').trim();
const daemonPort = () => portFor(home);

async function call(tool: string, args: Record<string, unknown>, print = true, soft = false): Promise<{ data?: any; error?: string }> {
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
  if (!res.ok) return soft ? { error: body.error ?? `HTTP ${res.status}` } : fail(body.error ?? `HTTP ${res.status}`);
  if (print) console.log(body.text ?? JSON.stringify(body.data, null, 2));
  return body;
}

const APP = join(dirname(dirname(import.meta.dirname)), 'src-tauri/target/release/bundle/macos/orchestr8.app');
// Cold start: the app reads --node. Already running: `open` only activates it, so callers also post `select`.
const openApp = (port: number, node: string) =>
  spawnSync('open', ['--env', `O8_HOME=${home}`, '--env', `O8_PORT=${port}`, '-a', APP, '--args', '--node', node]); // same daemon as this CLI

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv[0]?.startsWith('-') ? ['up', ...argv] : argv; // `o8 --new` means `o8 up --new`
const { values: f, positionals: pos } = parseArgs({
  args: rest, allowPositionals: true,
  options: {
    kind: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' },
    'permission-mode': { type: 'string' }, role: { type: 'string' }, new: { type: 'boolean' }, 'request-id': { type: 'string' }, plain: { type: 'boolean' }, force: { type: 'boolean' }, lines: { type: 'string' },
  },
});

switch (cmd) {
  case 'list': await call('list_nodes', {}); break;
  case 'ps':
    for (const n of (await call('list_nodes', {}, false)).data ?? []) console.log([n.id, n.state, n.title, n.parentId ?? '-', n.age].join('\t'));
    break;
  case 'attach':
    if (!pos[0]) fail(usage());
    process.exit(await (f.plain ? attach : mux)(pos[0], { port: daemonPort(), token: readHome('admin-token') }));
    break;
  case 'new': {
    if (!pos[0]) fail(usage());
    const { data } = await call('spawn', { kind: 'claude', title: pos.join(' '), cwd: resolve(f.cwd ?? process.cwd()), prompt: f.prompt, model: f.model, role: f.role }, false);
    process.exit(await mux(data.nodeId, { port: daemonPort(), token: readHome('admin-token') }));
    break;
  }
  case 'prompts':
    for (const r of ['orchestrator', 'worker'] as const) {
      const { path, override } = promptPath(home, realpathSync(process.cwd()), r);
      console.log(`${r}: ${path}${override ? ' (repo override)' : ''}`);
    }
    break;
  case 'select':
    if (!pos[0]) fail(usage());
    await call('select', { nodeId: pos[0] }, false);
    if (existsSync(APP)) openApp(daemonPort(), pos[0]!);
    break;
  case 'resume':
    if (!pos[0]) fail(usage());
    await call('resume', { nodeId: pos[0] });
    break;
  case 'restart':
    if (!pos[0]) fail(usage());
    await call('restart', { nodeId: pos[0] });
    break;
  case 'prune': {
    const { data } = await call('prune', {}, false);
    console.log(`removed ${data.removed.length} exited node${data.removed.length === 1 ? '' : 's'}`);
    break;
  }
  case 'spawn':
    await call('spawn', { kind: f.kind, title: f.title, cwd: f.cwd ?? process.cwd(), prompt: f.prompt, model: f.model, permissionMode: f['permission-mode'], role: f.role, requestId: f['request-id'] });
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
    await call('close', { nodeIds: pos, force: f.force });
    break;
  case undefined:
  case 'up':
  case 'app':
  case 'mux': {
    const port = daemonPort();
    if (!(await findDaemon(port))) await startDaemon(home, port).catch((e: Error) => fail(e.message));
    const cwd = realpathSync(process.cwd());
    const all = f.new ? [] : (((await call('list_nodes', {}, false)).data ?? []) as any[]);
    const existing = pickOrchestrator(all, cwd);
    const dead = existing ? undefined : pickOrchestrator(all, cwd, true);
    let id: string | undefined;
    if (existing) { console.log(`reattaching to ${existing.title} (${existing.id})`); id = existing.id; }
    else if (dead) {
      console.log(`resuming ${dead.title} (${dead.id})`);
      const r = await call('resume', { nodeId: dead.id }, false, true);
      if (r.error) console.log(`cannot resume (${r.error}); starting a new orchestrator`);
      else id = dead.id;
    }
    if (!id) {
      const title = f.title ?? basename(cwd);
      id = (await call('spawn', { kind: 'claude', title, cwd, prompt: f.prompt }, false)).data.nodeId as string;
      console.log(`started ${title} (${id})`);
    }
    const target = id;
    if (cmd === 'mux') process.exit(await mux(target, { port, token: readHome('admin-token') }));
    if (existsSync(APP)) {
      openApp(port, target);
      await call('select', { nodeId: target }, false);
    } else {
      console.log('app not built: run npm run app:build');
      spawnSync('open', [`http://127.0.0.1:${port}/?k=${readHome('admin-token')}&node=${target}`]);
    }
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
