// Framing for the PTY holder socket. Every frame is a u32 big-endian length (of everything after it), a u8 kind and a
// body. A control frame's body is UTF-8 JSON; a data frame's body is a u16 id length, the id, then raw PTY bytes.
import type { Socket } from 'node:net';

export const PROTOCOL = 1;
const CONTROL = 0, DATA = 1;

export type Frame = { kind: 'control'; msg: Record<string, unknown> & { t: string } } | { kind: 'data'; id: string; bytes: Buffer };

export function control(msg: { t: string } & Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = CONTROL;
  return Buffer.concat([head, body]);
}

export function data(id: string, bytes: Buffer): Buffer {
  const idb = Buffer.from(id);
  const head = Buffer.alloc(7);
  head.writeUInt32BE(1 + 2 + idb.length + bytes.length);
  head[4] = DATA;
  head.writeUInt16BE(idb.length, 5);
  return Buffer.concat([head, idb, bytes]);
}

/** Calls onFrame for each complete frame read from the socket. */
export function readFrames(sock: Socket, onFrame: (f: Frame) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const kind = buf[4], body = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
      if (kind === CONTROL) onFrame({ kind: 'control', msg: JSON.parse(body.toString()) });
      else {
        const n = body.readUInt16BE(0);
        onFrame({ kind: 'data', id: body.subarray(2, 2 + n).toString(), bytes: Buffer.from(body.subarray(2 + n)) });
      }
    }
  });
}
