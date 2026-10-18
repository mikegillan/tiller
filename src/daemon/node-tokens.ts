import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeEqual } from './util.js';

/** The daemon's persistent secret and the per-node credentials derived from it. */
export class NodeTokens {
  private readonly secret: Buffer;

  constructor(home: string) {
    const file = join(home, 'secret');
    try {
      this.secret = readFileSync(file);
    } catch {
      const fresh = randomBytes(32);
      try {
        writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
        this.secret = fresh;
      } catch {
        this.secret = readFileSync(file); // another process created it first
      }
    }
  }

  tokenFor(nodeId: string, generation?: string): string {
    return createHmac('sha256', this.secret).update(generation ? `${nodeId}\0${generation}` : nodeId).digest('hex');
  }

  verify(nodeId: string, token: string, generation?: string): boolean {
    return safeEqual(token, this.tokenFor(nodeId, generation));
  }

  /** The node directory already exists. Returns the token for the launch configuration. */
  writeFiles(dir: string, nodeId: string, generation?: string): string {
    const token = this.tokenFor(nodeId, generation);
    writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
    writeFileSync(join(dir, 'hook-headers'), `Authorization: Bearer ${token}\nX-TL-Node: ${nodeId}\n`, { mode: 0o600 }); // read by hook.sh via curl -H @file
    return token;
  }
}
