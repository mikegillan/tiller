import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateHome } from './home.js';

describe('migrateHome', () => {
  let user: string;
  beforeEach(() => { user = mkdtempSync(join(tmpdir(), 'tl-home-')); mkdirSync(join(user, '.orchestr8')); writeFileSync(join(user, '.orchestr8', 'marker'), 'old'); });
  afterEach(() => rmSync(user, { recursive: true, force: true }));

  it('moves ~/.orchestr8 to a missing ~/.tiller', () => {
    migrateHome(join(user, '.tiller'), user);
    expect(readFileSync(join(user, '.tiller', 'marker'), 'utf8')).toBe('old');
    expect(existsSync(join(user, '.orchestr8'))).toBe(false);
  });

  it('leaves both alone when ~/.tiller exists', () => {
    mkdirSync(join(user, '.tiller'));
    migrateHome(join(user, '.tiller'), user);
    expect(existsSync(join(user, '.tiller', 'marker'))).toBe(false);
    expect(existsSync(join(user, '.orchestr8', 'marker'))).toBe(true);
  });

  it('leaves ~/.orchestr8 alone for another home (a TL_HOME)', () => {
    migrateHome(join(user, 'elsewhere'), user);
    expect(existsSync(join(user, 'elsewhere'))).toBe(false);
    expect(existsSync(join(user, '.orchestr8', 'marker'))).toBe(true);
  });
});
