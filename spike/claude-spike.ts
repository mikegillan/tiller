// Phase 0 spike: verify the four assumptions PLAN.md §10 rests on.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
const { Terminal } = xterm;
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const t0 = Date.now();
const root = process.cwd();
const dev = path.join(root, '.orchestr8-dev');
fs.mkdirSync(dev, { recursive: true });
const nodeId = 'n-spike';
const token = randomBytes(24).toString('base64url');
const tokenFile = path.join(dev, 'token');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const sessionId = randomUUID();
const hookScript = path.join(root, 'src', 'daemon', 'hook.sh');

type HookEvent = { hook_event_name: string; session_id?: string; transcript_path?: string; [k: string]: unknown };
const events: HookEvent[] = [];
const waiters: Array<{ pred: (e: HookEvent) => boolean; resolve: (e: HookEvent) => void }> = [];
function waitFor(name: string, ms: number, after = 0): Promise<HookEvent | null> {
  const hit = events.slice(after).find(e => e.hook_event_name === name);
  if (hit) return Promise.resolve(hit);
  return new Promise(resolve => {
    const w = { pred: (e: HookEvent) => e.hook_event_name === name, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
  });
}
let mcpCalls = 0;

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization === `Bearer ${token}`;
  if (!auth) { res.writeHead(401).end(); return; }
  if (req.url === '/hook' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    try {
      const e = JSON.parse(body) as HookEvent;
      events.push(e);
      log(`hook ${e.hook_event_name}` + (e.notification_type ? ` type=${e.notification_type}` : '') + (e.tool_name ? ` tool=${e.tool_name}` : ''));
      for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    } catch { log('hook: bad json'); }
    res.writeHead(204).end();
    return;
  }
  if (req.url === '/mcp') {
    const mcp = new McpServer({ name: 'orchestr8', version: '0.0.0' });
    mcp.registerTool('ping', { description: 'Ping the orchestr8 daemon. Returns the caller node id.', inputSchema: {} },
      async () => { mcpCalls++; log('mcp: ping called'); return { content: [{ type: 'text', text: JSON.stringify({ pong: true, node: req.headers['x-o8-node'] ?? nodeId }) }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const endpoint = `http://127.0.0.1:${port}`;

const settingsFile = path.join(dev, 'settings.json');
const hookEntry = [{ hooks: [{ type: 'command', command: `sh '${hookScript}'` }] }];
fs.writeFileSync(settingsFile, JSON.stringify({
  hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'].map(n => [n, hookEntry])),
  permissions: { allow: ['mcp__orchestr8'] },
}, null, 2));
const mcpFile = path.join(dev, 'mcp.json');
fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { orchestr8: { type: 'http', url: `${endpoint}/mcp`, headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': nodeId } } } }), { mode: 0o600 });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TERM|TERMINFO|COLORTERM)/.test(k)) env[k] = v;
Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', O8_NODE_ID: nodeId, O8_ENDPOINT: endpoint, O8_TOKEN_FILE: tokenFile });
if (!env.LANG) env.LANG = 'en_US.UTF-8';

const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const args = ['--session-id', sessionId, '--name', 'spike', '--permission-mode', 'default',
  '--settings', settingsFile, '--mcp-config', mcpFile, '--strict-mcp-config',
  '--append-system-prompt', `You are orchestr8 node ${nodeId}. Keep replies to one line.`,
  'Call the ping tool on the orchestr8 MCP server, then reply with exactly: PING OK <the node field it returned>'];
log(`spawning claude --session-id ${sessionId} (port ${port})`);
const p = pty.spawn('claude', args, { name: 'xterm-256color', cols, rows, cwd: root, env });
let exited = false;
p.onData(d => term.write(d));
p.onExit(e => { exited = true; log(`claude exited code=${e.exitCode}`); });

function screen(n = 14): string {
  const b = term.buffer.active; const out: string[] = [];
  for (let y = Math.max(0, b.baseY + b.cursorY - n); y <= b.baseY + b.cursorY; y++) out.push('  | ' + (b.getLine(y)?.translateToString(true) ?? ''));
  return out.join('\n');
}
function bottom(n = 6): string {
  const b = term.buffer.active; const out: string[] = [];
  for (let y = b.baseY + rows - n; y < b.baseY + rows; y++) out.push('  | ' + (b.getLine(y)?.translateToString(true) ?? ''));
  return out.join('\n');
}
function log(s: string) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Record<string, string> = {};

async function waitForScreen(text: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end && !exited; await sleep(250)) {
    const b = term.buffer.active;
    for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).includes(text)) return true;
  }
  return false;
}

// Folder trust dialog: arrow-key menu that defaults to "No, exit". Wait for it to fully render, Down, Enter.
if (await waitForScreen('Quick safety check', 15_000) && await waitForScreen('Enter to confirm', 5_000)) {
  log('trust dialog before answering:\n' + screen(30));
  p.write('\x1b[B'); await sleep(300);
  p.write('\r'); await sleep(1500);
  log('screen after answering trust dialog:\n' + screen(30));
}

// A1: hooks from --settings fire.  A4: session id / transcript path.
const start = await waitFor('SessionStart', 40_000);
results['A1 hooks via --settings'] = start ? 'PASS' : 'FAIL (no SessionStart in 40s)';
if (start) {
  const expected = path.join(process.env.HOME!, '.claude', 'projects', root.replace(/[/.]/g, '-'), `${sessionId}.jsonl`);
  log(`SessionStart session_id=${start.session_id} transcript_path=${start.transcript_path}`);
  results['A4 session id + transcript path'] = start.session_id === sessionId && start.transcript_path === expected ? 'PASS' : `CHECK (expected ${expected})`;
}
await sleep(1500); log('screen after start:\n' + screen());

// A2: MCP tool call works without a prompt.
const stop1 = await waitFor('Stop', 150_000);
log('screen after first turn:\n' + screen());
const blocked = events.some(e => e.hook_event_name === 'PermissionRequest' || e.notification_type === 'permission_prompt');
results['A2 MCP tool call'] = mcpCalls > 0 && !blocked ? 'PASS' : `FAIL (mcpCalls=${mcpCalls}, permissionPrompt=${blocked}, stop=${!!stop1})`;
if (stop1) log(`Stop last_assistant_message=${JSON.stringify(stop1.last_assistant_message)}`);
if (start && start.transcript_path) results['A4b transcript exists'] = fs.existsSync(String(start.transcript_path)) ? 'PASS' : 'FAIL';

// A3: bracketed paste + Enter into an idle node submits and fires UserPromptSubmit.
if (stop1 && !exited) {
  await sleep(2500);
  await sleep(2500); log('idle viewport bottom:\n' + bottom());
  const mark = events.length;
  const nonce = randomBytes(6).toString('base64url');
  const body = `--- O8 MESSAGE ${nonce} ---\nfrom: tester (n-test)\nreply-to: n-test\nReply with exactly: PASTE OK\nSecond line of the body, to prove multi-line survives.\n--- END O8 MESSAGE ${nonce} ---`;
  p.write(`\x1b[200~${body}\x1b[201~`);
  await sleep(150);
  p.write('\r');
  const ups = await waitFor('UserPromptSubmit', 8_000, mark);
  log('screen after paste:\n' + screen());
  const stop2 = ups ? await waitFor('Stop', 120_000, mark) : null;
  results['A3 paste delivery'] = ups && stop2 ? `PASS (reply=${JSON.stringify(stop2.last_assistant_message)})` : `FAIL (UserPromptSubmit=${!!ups}, Stop=${!!stop2})`;
  if (ups) log(`UserPromptSubmit prompt=${JSON.stringify(ups.prompt).slice(0, 200)}`);
}

// A4c: /clear is reported by SessionStart with a new session id.
if (!exited) {
  const m = events.length; p.write('/clear'); await sleep(500); p.write('\r');
  const ss = await waitFor('SessionStart', 15_000, m);
  results['A4c /clear -> SessionStart'] = ss ? `PASS (source=${ss.source}, new session_id=${ss.session_id !== sessionId}, transcript=${ss.transcript_path})` : 'FAIL';
}
fs.writeFileSync(path.join(dev, 'events.json'), JSON.stringify(events, null, 1));
log('final screen:\n' + screen());
p.write('/exit\r'); await sleep(1500); if (!exited) p.kill();
server.close();
console.log('\nRESULTS'); for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`);
console.log(`  events seen: ${events.map(e => e.hook_event_name).join(', ')}`);
process.exit(0);
