// Thin client for the daemon's POST /api/<tool>. Inside a node it uses O8_NODE_ID / O8_TOKEN_FILE / O8_ENDPOINT;
// outside it acts as `human` with the admin token in <home>/admin-token.
import { mux } from '../client/mux.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { promptPath } from './launch.js';
import { ADMIN_TOKEN_FILE, daemonPort as portFor, homeDir } from './home.js';
import { agentStatus, install, kickstart, LABEL, O8D, plistPath, uninstall } from './autostart.js';
import { loginShellPath } from './pty.js';
import { findDaemon, humanEnv, pickOrchestrator, spawnReload, startDaemon, waitForDaemon } from './up.js';

const usage = () => `o8: control orchestr8. With no arguments, start the daemon if needed and open the app on this directory's orchestrator.

  o8 [up|app] [--new] [--title T] [--prompt P]        start daemon if needed; open the app on (or create) this directory's orchestrator
  o8 mux [--new] [--title T] [--prompt P]             the same, in the terminal multiplexer (also: o8-mux)
  o8 status | stop                                    show or stop the daemon (o8d runs it in the foreground); stop also means
                                                      the nodes are not resumed on the next start
  o8 reload                                           restart the daemon on the current code and resume the nodes that were live
  o8 autostart on|off|status                          a launchd agent that starts the daemon at login and after a crash
  o8 new <title> [--cwd P] [--model M] [--effort E] [--prompt T] [--role R] [--worktree]  start a Claude node and attach to it in the terminal
  o8 ps | list                                        show nodes
  o8 usage                                            show account-level Claude usage (5-hour and 7-day windows) as nodes last reported it
  o8 attach <id>                                      open the sidebar client on a node (Ctrl-\\ ? for keys)
  o8 select <id>                                      show a node in the app (opens the app if it is built)
  o8 resume <id>                                      relaunch an exited Claude node
  o8 prune                                            remove every exited node that has no live descendant
  o8 restart <id>                                     relaunch a node with a fresh session (clears its context; children are kept)
  o8 kill [--force] [--keep-branch|--discard] <id...> | close <id...>  close and delete nodes (an orchestrator needs --force);
                                                      a node's worktree must be clean and merged unless --keep-branch
                                                      (commit as WIP, keep the branch) or --discard (delete both)
  o8 merge <id> [--close]                             merge a worktree node's branch into its base (refused on conflict,
                                                      naming the paths); --close then closes the node
  o8 diff <id> [--stat]                               what a worktree node changed since it branched, committed or not
  o8 send <id> "text"
  o8 read <id> [summary|transcript|terminal] [--lines N]
  o8 spawn --kind claude|terminal --title T --cwd PATH [--prompt P] [--model M] [--effort low|medium|high|xhigh|max] [--permission-mode M] [--role orchestrator|worker|none] [--worktree] [--request-id ID]
  o8 prompts                                          show the role prompt files and any override for this directory
  o8 config [--cwd P]                                 show the effective config for a directory and which file each key came from
  o8 worktrees [--cwd P]                              list node worktrees, orphans and kept branches for this repo
  o8 worktrees clean [--force] [--cwd P]              remove orphans and kept branches that are clean and merged; --force removes all
  o8 help`;

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const home = homeDir();
const adminToken = () => readFileSync(join(home, ADMIN_TOKEN_FILE), 'utf8').trim();
const daemonPort = () => portFor(home);

async function call(tool: string, args: Record<string, unknown>, print = true, soft = false): Promise<{ text?: string; data?: any; error?: string }> {
  const env = process.env;
  const node = env.O8_NODE_ID && env.O8_TOKEN_FILE;
  let token: string;
  try { token = node ? readFileSync(env.O8_TOKEN_FILE!, 'utf8').trim() : adminToken(); }
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
    kind: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'permission-mode': { type: 'string' }, role: { type: 'string' }, new: { type: 'boolean' }, 'request-id': { type: 'string' }, force: { type: 'boolean' }, lines: { type: 'string' },
    worktree: { type: 'boolean' }, 'keep-branch': { type: 'boolean' }, discard: { type: 'boolean' }, detached: { type: 'boolean' }, close: { type: 'boolean' }, stat: { type: 'boolean' },
  },
});

const isolation = () => (f.worktree ? 'worktree' : undefined);

switch (cmd) {
  case 'list': await call('list_nodes', {}); break;
  case 'usage': console.log((await call('list_nodes', {}, false)).text?.split('\n')[0]); break; // list_nodes' first line
  case 'ps':
    for (const n of (await call('list_nodes', {}, false)).data ?? []) console.log([n.id, n.state, n.title, n.parentId ?? '-', n.age].join('\t'));
    break;
  case 'attach':
    if (!pos[0]) fail(usage());
    process.exit(await mux(pos[0], { port: daemonPort(), token: adminToken() }));
    break;
  case 'new': {
    if (!pos[0]) fail(usage());
    const { data } = await call('spawn', { kind: 'claude', title: pos.join(' '), cwd: resolve(f.cwd ?? process.cwd()), prompt: f.prompt, model: f.model, effort: f.effort, role: f.role, isolation: isolation() }, false);
    process.exit(await mux(data.nodeId, { port: daemonPort(), token: adminToken() }));
    break;
  }
  case 'prompts':
    for (const r of ['orchestrator', 'worker'] as const) {
      const { path, override } = promptPath(home, realpathSync(process.cwd()), r);
      console.log(`${r}: ${path}${override ? ' (repo override)' : ''}`);
    }
    break;
  case 'config': {
    const c = loadConfig(realpathSync(resolve(f.cwd ?? process.cwd())), home);
    const { orchestrator: o, worker: w } = c.roles;
    const values = {
      'roles.orchestrator.model': o.model, 'roles.orchestrator.effort': o.effort, 'roles.worker.model': w.model, 'roles.worker.effort': w.effort,
      closeWithoutConfirm: c.closeWithoutConfirm,
      'worktrees.isolation': c.worktrees.isolation, 'worktrees.branchPrefix': c.worktrees.branchPrefix, 'worktrees.include': c.worktrees.include?.join(', ') ?? '(.worktreeinclude)',
      'worktrees.merge': c.worktrees.merge, 'worktrees.mergeWithoutConfirm': c.worktrees.mergeWithoutConfirm,
      'worktrees.setup': JSON.stringify(c.worktrees.setup), 'worktrees.teardown': JSON.stringify(c.worktrees.teardown),
      resumeOnStart: c.resumeOnStart, resumeMaxAgeDays: c.resumeMaxAgeDays,
      ...Object.fromEntries(Object.entries(c.limits).map(([k, v]) => [`limits.${k}`, v])),
    };
    for (const [k, v] of Object.entries(values)) console.log(`${k}: ${v ?? '(claude default)'}  [${c.sources[k as keyof typeof values]}]`);
    break;
  }
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
    await call('spawn', { kind: f.kind, title: f.title, cwd: f.cwd ?? process.cwd(), prompt: f.prompt, model: f.model, effort: f.effort, permissionMode: f['permission-mode'], role: f.role, isolation: isolation(), requestId: f['request-id'] });
    break;
  case 'diff':
    if (!pos[0]) fail(usage());
    await call('diff', { nodeId: pos[0], stat: f.stat });
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
    if (f['keep-branch'] && f.discard) fail('--keep-branch and --discard exclude each other');
    await call('close', { nodeIds: pos, force: f.force, worktree: f['keep-branch'] ? 'keep' : f.discard ? 'discard' : undefined });
    break;
  case 'merge': {
    if (!pos[0]) fail(usage());
    const { data } = await call('merge', { nodeId: pos[0] });
    if (!data?.ok) process.exit(1); // conflicts: printed above
    if (f.close) await call('close', { nodeIds: [pos[0]] });
    break;
  }
  case 'worktrees':
    if (pos[0] && pos[0] !== 'clean') fail(usage());
    await call('worktrees', { cwd: realpathSync(resolve(f.cwd ?? process.cwd())), clean: pos[0] ? (f.force ? 'force' : 'safe') : undefined });
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
    if (cmd === 'mux') process.exit(await mux(target, { port, token: adminToken() }));
    if (existsSync(APP)) {
      openApp(port, target);
      await call('select', { nodeId: target }, false);
    } else {
      console.log('app not built: run npm run app:build');
      spawnSync('open', [`http://127.0.0.1:${port}/?k=${adminToken()}&node=${target}`]);
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
  case 'reload': {
    process.env = humanEnv(process.env); // run from a node's terminal, still restart as the human
    const port = daemonPort();
    if (!f.detached) {
      if (!(await findDaemon(port))) { await startDaemon(home, port).catch((e: Error) => fail(e.message)); console.log('no daemon was running; started it'); break; }
      console.log(`reloading daemon; the new one resumes the nodes that were live; log in ${spawnReload(home, port)}`);
      break;
    }
    // The detached helper: stdout is daemon.log. SIGTERM, unlike `o8 stop`, keeps the live set for the new daemon to resume.
    const say = (s: string) => console.log(`o8 reload: ${s}`);
    const old = await findDaemon(port);
    if (old) {
      say(`stopping daemon pid ${old.pid}`);
      process.kill(old.pid, 'SIGTERM');
      for (const end = Date.now() + 10_000; await findDaemon(port); await new Promise((r) => setTimeout(r, 200)))
        if (Date.now() > end) fail(`o8 reload: daemon pid ${old.pid} did not stop`);
    }
    const agent = agentStatus().loaded;
    if (agent) kickstart(); // keep the daemon under launchd when autostart is on
    const h = await (agent ? waitForDaemon(port, join(home, 'daemon.log')) : startDaemon(home, port)).catch((e: Error) => fail(`o8 reload: ${e.message}`));
    say(`started daemon pid ${h.pid}${agent ? ' through launchd' : ''}; it resumes the nodes that were live`);
    break;
  }
  case 'autostart': {
    const st = agentStatus();
    if (pos[0] === 'status') {
      console.log(`${LABEL}: ${st.installed ? `installed (${plistPath()})` : 'not installed'}, ${st.loaded ? `loaded${st.pid ? `, daemon pid ${st.pid}` : ', not running'}` : 'not loaded'}`);
    } else if (pos[0] === 'on') {
      if (st.loaded) { console.log(`autostart is already on; run o8 autostart off, then on, to rewrite ${plistPath()}`); break; }
      const running = await findDaemon(daemonPort());
      const env: Record<string, string> = { O8_HOME: home, PATH: await loginShellPath(), ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}) };
      if (process.env.O8_PORT) env.O8_PORT = process.env.O8_PORT;
      install({ label: LABEL, program: O8D, env, log: join(home, 'daemon.log') });
      console.log(`autostart on: ${plistPath()} loaded; the daemon starts at login and after a crash, not after o8 stop`);
      // The agent's first launch finds the port busy and exits 0, so the running daemon stays as it is.
      if (running) console.log(`daemon pid ${running.pid} keeps running outside launchd; o8 reload hands it to launchd`);
    } else if (pos[0] === 'off') {
      uninstall();
      console.log(`autostart off${st.pid ? `; stopped daemon pid ${st.pid} (its nodes resume on the next start)` : ''}`);
    } else fail(usage());
    break;
  }
  case 'help': console.log(usage()); break;
  default: fail(usage());
}
