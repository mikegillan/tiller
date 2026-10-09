// `o8 attach <id>`: turn this terminal into a live view of a node's PTY. Detach with Ctrl-\ then d.
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

const CHORD = '\x1c';

/** Incremental detach-chord scanner. A lone Ctrl-\ is held back until the next byte arrives. */
export function detachChord(held: boolean, input: string): { detach: boolean; passthrough: string; held: boolean } {
  let out = '';
  for (const ch of input) {
    if (held) {
      if (ch === 'd') return { detach: true, passthrough: out, held: false };
      held = false;
      out += CHORD;
    }
    if (ch === CHORD) held = true;
    else out += ch;
  }
  return { detach: false, passthrough: out, held };
}

export function attach(nodeId: string, { port, token }: { port: number; token: string }): Promise<number> {
  const { stdin, stdout } = process;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  let raw = false, held = false, finished = false, exitShown = false;

  return new Promise((done) => {
    const finish = (msg: string, code: number) => {
      if (finished) return;
      finished = true;
      if (raw) stdin.setRawMode(false);
      raw = false;
      stdin.pause();
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      stdout.write(`\x1b[?25h\r\n${msg}\r\n`);
      ws.removeAllListeners('close');
      ws.close();
      done(code);
    };
    const onInput = (buf: Buffer) => {
      const r = detachChord(held, buf.toString('utf8'));
      held = r.held;
      if (r.passthrough) send({ t: 'input', id: nodeId, data: r.passthrough });
      if (r.detach) finish('[detached]', 0);
    };
    const onResize = () => send({ t: 'resize', id: nodeId, ...size() });

    ws.on('open', () => send({ t: 'auth', token }));
    ws.on('error', (e) => finish(`cannot reach daemon: ${e.message}`, 1));
    ws.on('close', () => finish('[connection closed]', 1));
    ws.on('message', (raw_) => {
      const m = JSON.parse(raw_.toString()) as ServerMessage;
      if (m.t === 'snapshot') {
        const node = m.nodes.find((n) => n.id === nodeId);
        if (!node) return finish(`no such node: ${nodeId}`, 1);
        stdout.write(`\x1b[2J\x1b[H\x1b[7mattached to ${node.title}; press Ctrl-\\ then d to detach\x1b[0m\r\n`);
        send({ t: 'attach', id: nodeId, ...size() });
        stdin.setRawMode(true);
        raw = true;
        stdin.resume();
        stdin.on('data', onInput);
        stdout.on('resize', onResize);
      } else if (m.t === 'data' && m.id === nodeId) stdout.write(m.data);
      else if (m.t === 'node' && m.node.id === nodeId && m.node.status.exited && !exitShown) {
        exitShown = true;
        stdout.write('\r\n[node exited]\r\n');
      }
      else if (m.t === 'removed' && m.id === nodeId) finish('[node removed]', 0);
      else if (m.t === 'error' && m.id === nodeId) finish(m.message, 1);
    });
  });
}
