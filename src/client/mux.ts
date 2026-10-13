// `o8` / `o8 attach <id>`: a tmux-style client. A persistent sidebar shows the whole tree; the main region shows the selected node's
// live screen (a headless terminal here, painted by row diff) and routes input to it. Clicking a node swaps it in.
import { writeSync } from 'node:fs';
import { basename } from 'node:path';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../shared/protocol.js';
import { initial, step, type Action, type Target } from './chords.js';
import { encode, isLeftPress, isWheel, parseInput, type Mouse } from './mouse.js';
import { NodeScreen, placeholder } from './screen.js';
import { pruneIds } from '../shared/prune.js';
import { layoutSidebar, needsYou, revealScroll, tree, type SideLayout } from './sidebar.js';

const ON = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J';
const OFF = '\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l';
const HELP_LINES = ['orchestr8 keys (Ctrl-\\ then):', ' d detach   b back   j/k next/prev   ! next needing you   1-9 jump to nth node',
  ' n new child   r resume   x kill   R restart orchestrator   e rename   o new orchestrator here   s sidebar   ? help', ' Ctrl-\\ twice sends a literal Ctrl-\; click a node or an action in the sidebar', ' (any key closes this)'];

export function mux(startId: string, { port, token }: { port: number; token: string }): Promise<number> {
  const { stdin, stdout } = process;
  const nodes = new Map<string, NodeView>();
  const bells = new Map<string, number>();
  let ws: WebSocket, cur = startId, prev: string | null = null, cs = initial;
  let appUp = false, hidden = false, scroll = 0, connected = false, started = false, finished = false, overlay = false, awaiting = false;
  let prompt: { label: string; text: string; confirm: boolean; done: (v: string) => void } | undefined;
  let notice: string | undefined, noticeTimer: NodeJS.Timeout | undefined;
  let scr: NodeScreen, side: SideLayout | undefined, prevSide: string[] = [];
  let frameTimer: NodeJS.Timeout | undefined, sideTimer: NodeJS.Timeout | undefined;

  const dims = () => {
    const cols = stdout.columns || 80, rows = stdout.rows || 24;
    const W = hidden || cols < 90 ? 0 : cols >= 110 ? 30 : 24;
    const x0 = W ? W + 2 : 1;
    return { cols, rows, W, x0, mc: cols - x0 + 1 };
  };
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const place = () => (prompt ? '' : scr.cursor(dims().x0));
  const out = (s: string) => s && stdout.write(`\x1b[?25l${s}${place()}`);

  const setNotice = (s: string) => { notice = s; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = undefined; drawSide(); }, 4000); drawSide(); };
  const list = () => tree(nodes).map((t) => t.n);

  function drawSide(force = false) {
    const { W, rows } = dims();
    if (!W) return side = undefined;
    const i = list().findIndex((n) => n.id === cur), model = () => ({ nodes, cur, scroll, now: Date.now(), port, connected, prompt: prompt && prompt.label + prompt.text, notice });
    if (i >= 0) scroll = revealScroll(model(), W, rows, i);
    side = layoutSidebar(model(), W, rows);
    if (force) prevSide = [];
    out(side.lines.map((l, y) => (l === prevSide[y] ? '' : `\x1b[${y + 1};1H${l}`)).join(''));
    prevSide = side.lines;
  }
  const throttleSide = () => { sideTimer ??= setTimeout(() => { sideTimer = undefined; drawSide(); }, 100); };
  const scheduleFrame = () => {
    frameTimer ??= setTimeout(async () => {
      frameTimer = undefined;
      const s = scr;
      await s.settle();
      if (s === scr && !finished && s.dirty) out(s.frame(dims().x0));
    }, 16);
  };
  /** Clear everything and repaint both regions; the node is told the new main size. */
  function relayout() {
    const { rows, mc } = dims();
    stdout.write('\x1b[2J');
    scr.resize(mc, rows);
    scr.dirty = true;
    paintExited();
    send({ t: 'resize', id: cur, cols: mc, rows });
    drawSide(true);
    scheduleFrame();
  }
  /** An exited node has no process and no screen to attach to; fill its region with the notice instead. */
  const paintExited = () => { const n = nodes.get(cur); if (n?.status.exited) scr.write(placeholder(n.title, scr.cols, scr.rows)); };
  const show = (id: string) => {
    const { mc, rows } = dims();
    cur = id;
    scr?.dispose();
    scr = new NodeScreen(mc, rows);
    paintExited();
    send({ t: 'select', id });
    send({ t: 'attach', id, cols: mc, rows });
    drawSide();
    setTimeout(() => { scr.dirty = true; scheduleFrame(); }, 200); // an empty screen sends no snapshot
  };
  const switchTo = (id: string) => {
    send({ t: 'detach', id: cur });
    if (id !== cur) prev = cur;
    show(id);
  };
  const pick = (t: Target) => {
    const l = list(), i = l.findIndex((n) => n.id === cur);
    let n: NodeView | undefined;
    if (t === 'cur') n = nodes.get(cur);
    else if (t === 'back') n = prev ? nodes.get(prev) : undefined;
    else if (typeof t === 'number') n = l[t];
    else if (t === 'needs') n = [...l.slice(i + 1), ...l.slice(0, i)].find(needsYou);
    else n = l[(i + (t === 'next' ? 1 : l.length - 1)) % l.length];
    if (n) switchTo(n.id);
    else setNotice(t === 'needs' ? 'no node needs you' : 'no such node');
  };

  const ask = (label: string, text: string, confirm: boolean, done: (v: string) => void) => { prompt = { label, text, confirm, done }; stdout.write('\x1b[?25l'); drawSide(); };
  const answer = (v: string | null) => { const p = prompt!; prompt = undefined; drawSide(); stdout.write(place()); if (v !== null) p.done(v); };
  const promptKey = (ch: string) => {
    const p = prompt!;
    if (ch === '\x1b' || ch === '\x03') answer(null);
    else if (p.confirm) answer(ch === 'y' ? 'y' : null);
    else if (ch === '\r') answer(p.text.trim() || null);
    else if (ch === '\x7f') { p.text = p.text.slice(0, -1); drawSide(); }
    else if (ch >= ' ') { p.text += ch; drawSide(); }
  };

  function act(key: string) {
    const n = nodes.get(cur);
    if (key === 'sidebar') { hidden = !hidden; relayout(); }
    else if (key === 'help') {
      const { mc } = dims();
      overlay = true;
      out(HELP_LINES.map((l, y) => `\x1b[${y + 1};${dims().x0}H\x1b[7m${l.slice(0, mc).padEnd(mc)}\x1b[0m`).join(''));
    } else if (key === 'orch') { awaiting = true; send({ t: 'spawn', kind: 'claude', title: basename(process.cwd()), cwd: process.cwd(), parentId: null }); }
    else if (!n) return;
    else if (key === 'new') ask('new child: ', '', false, (title) => { awaiting = true; send({ t: 'spawn', kind: 'claude', title, cwd: n.cwd, parentId: n.id }); });
    else if (key === 'rename') ask('rename: ', n.title, false, (title) => send({ t: 'rename', id: n.id, title }));
    else if (key === 'kill' && n.parentId === null) setNotice("orchestrators can't be killed; use R to restart");
    else if (key === 'restart') ask(`restart ${n.title}? context is cleared, children kept. y/n`, '', true, () => send({ t: 'restart', id: n.id }));
    else if (key === 'kill') { if (n.status.exited) send({ t: 'close', id: n.id }); else ask(`kill ${n.title}? y/n`, '', true, () => send({ t: 'close', id: n.id })); }
    else if (key === 'clear') {
      const c = pruneIds([...nodes.values()]).length;
      if (c) ask(`clear ${c} exited? y/n`, '', true, () => send({ t: 'prune' })); else setNotice('no exited nodes to clear');
    }
    else if (key === 'resume') { if (n.status.exited) send({ t: 'resume', id: n.id }); else setNotice('not exited'); }
  }
  const run = (a: Action) => {
    if (a.type === 'passthrough') send({ t: 'input', id: cur, data: a.data });
    else if (a.type === 'detach') finish('', 0);
    else if (a.type === 'switch') pick(a.target);
    else if (a.type === 'act') act(a.key);
    else if (a.type === 'help') act('help');
    else if (a.type === 'picker') setNotice('jump to: ');
    else if (a.type === 'echo') setNotice((notice ?? '') + a.data);
  };

  const onMouse = (m: Mouse) => {
    const { W } = dims();
    if (prompt) return;
    if (W && m.x <= W) {
      if (isWheel(m)) { scroll = Math.max(0, Math.min(list().length - 1, scroll + (m.b & 1 ? 1 : -1))); drawSide(); return; }
      if (!isLeftPress(m) || !side) return;
      const a = side.acts.find((x) => x.row === m.y - 1 && m.x >= x.x0 && m.x <= x.x1);
      const id = side.nodeAt[m.y - 1];
      if (a) act(a.act);
      else if (id && nodes.has(id)) switchTo(id);
    } else if (!W || m.x > W + 1) { if (scr.mouse) send({ t: 'input', id: cur, data: encode(m, dims().x0 - 1) }); }
  };
  const onInput = (buf: Buffer) => {
    if (overlay) { overlay = false; scr.invalidate(); scr.dirty = true; scheduleFrame(); }
    let pass = '';
    const flush = () => { if (pass) send({ t: 'input', id: cur, data: pass }); pass = ''; };
    for (const p of parseInput(buf.toString('utf8'))) {
      if ('mouse' in p) { flush(); onMouse(p.mouse); continue; }
      for (const ch of p.text) {
        if (prompt) { promptKey(ch); continue; }
        const r = step(cs, ch);
        cs = r.state;
        for (const a of r.actions) { if (a.type === 'passthrough') pass += a.data; else { flush(); run(a); } }
      }
    }
    flush();
  };
  let resizeTimer: NodeJS.Timeout | undefined;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 50); };

  const restore = () => { if (started) { started = false; try { stdin.setRawMode(false); } catch { /* not a tty */ } writeSync(1, OFF); } };
  const onSignal = () => finish('', 130);
  const onCrash = (e: unknown) => { restore(); console.error(e); process.exit(1); };
  let done: (code: number) => void;
  function finish(msg: string, code: number) {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    restore();
    if (msg) console.log(msg);
    stdin.pause();
    stdin.off('data', onInput);
    stdout.off('resize', onResize);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(s, onSignal);
    process.off('exit', restore);
    process.off('uncaughtException', onCrash);
    ws.removeAllListeners('close');
    ws.close();
    done(code);
  }

  function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => { send({ t: 'auth', token, client: 'mux' }); send({ t: 'visibility', focused: true }); }); // attached means in front
    ws.on('error', (e) => { if (!started) finish(`cannot reach daemon: ${e.message}`, 1); });
    ws.on('close', () => { if (finished) return; connected = false; drawSide(); setTimeout(connect, 1000); });
    ws.on('message', (raw) => onMessage(JSON.parse(raw.toString()) as ServerMessage));
  }
  function onMessage(m: ServerMessage) {
    if (m.t === 'snapshot') {
      nodes.clear();
      for (const n of m.nodes) nodes.set(n.id, n);
      connected = true;
      appUp = m.appConnected;
      if (!started) {
        if (!nodes.has(cur)) return finish(`no such node: ${cur}`, 1);
        started = true;
        stdin.setRawMode(true);
        stdin.resume();
        stdout.write(ON);
        stdin.on('data', onInput);
        stdout.on('resize', onResize);
        show(cur);
      } else show(nodes.has(cur) ? cur : list()[0]!.id); // reconnected
    } else if (m.t === 'data') { if (m.id === cur && started) { scr.write(m.data); scheduleFrame(); } }
    else if (m.t === 'node') {
      const was = nodes.get(m.node.id);
      nodes.set(m.node.id, m.node);
      const now = Date.now();
      if (!was && awaiting) { awaiting = false; switchTo(m.node.id); }
      else if (m.node.id === cur && !!was?.status.exited !== !!m.node.status.exited) show(cur); // resumed, or its process ended
      else throttleSide();
      if (!appUp && m.node.id !== cur && needsYou(m.node) && !(was && needsYou(was)) && now - (bells.get(m.node.id) ?? 0) >= 5000) {
        bells.set(m.node.id, now);
        stdout.write('\x07');
      }
    } else if (m.t === 'removed') {
      nodes.delete(m.id);
      if (prev === m.id) prev = null;
      if (m.id !== cur) return throttleSide();
      const next = list()[0];
      if (next) { cs = initial; show(next.id); } else finish('[node removed]', 0);
    } else if (m.t === 'clients') appUp = m.app;
    else if (m.t === 'focus') { if (m.from === cur && nodes.has(m.id)) switchTo(m.id); }
    else if (m.t === 'error') { if (m.id === cur && !nodes.has(cur)) finish(m.message, 1); else setNotice(m.message.slice(0, 60)); }
  }

  const tick = setInterval(() => started && drawSide(), 5000); // ages
  process.on('exit', restore);
  process.on('uncaughtException', onCrash);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, onSignal);
  return new Promise((res) => { done = res; connect(); });
}
