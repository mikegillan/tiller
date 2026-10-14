// Creates the demo's sample repo: a tiny Node CLI with one test, a tiller config that keeps workers cheap, and
// project permissions so agents can edit, test and commit without prompts. Usage: node make-sample-repo.mjs <dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FILES = {
  'package.json': JSON.stringify({
    name: 'greet', version: '1.0.0', type: 'module', bin: { greet: './src/cli.js' },
    scripts: { test: 'node --test' },
  }, null, 2) + '\n',
  'src/cli.js': `#!/usr/bin/env node
// greet: prints a greeting.
import { parseArgs } from 'node:util';

export function greeting(name = 'world') {
  return \`Hello, \${name}!\`;
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const { values } = parseArgs({ options: { name: { type: 'string' } } });
  console.log(greeting(values.name));
}
`,
  'test/cli.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { greeting } from '../src/cli.js';

test('greeting defaults to world', () => {
  assert.equal(greeting(), 'Hello, world!');
});

test('--name sets the name', () => {
  const out = execFileSync(process.execPath, ['src/cli.js', '--name', 'Ada'], { encoding: 'utf8' });
  assert.equal(out, 'Hello, Ada!\\n');
});
`,
  'README.md': `# greet

A tiny command-line tool that prints a greeting.

## Usage

    node src/cli.js              # Hello, world!
    node src/cli.js --name Ada   # Hello, Ada!

## Tests

    npm test
`,
  '.gitignore': 'node_modules/\n.claude/worktrees/\n',
  '.tiller/config.json': JSON.stringify({
    roles: { worker: { model: 'haiku' }, orchestrator: { model: 'sonnet' } },
    approvals: { close: 'done', merge: true },
    worktrees: { isolation: 'worktree' },
  }, null, 2) + '\n',
  // Committed, so every worktree has it too. Edits stay inside the checkout ("/" is relative to this file's project);
  // Bash is limited to running the CLI and tests and to read-and-commit git commands.
  '.claude/settings.json': JSON.stringify({
    permissions: {
      allow: [
        'Edit(/**)', // Edit rules cover Write too
        'Bash(node src/cli.js:*)', 'Bash(node --test:*)', 'Bash(npm test:*)',
        'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)',
      ],
      deny: ['Bash(git push:*)', 'Bash(rm -rf:*)'],
    },
  }, null, 2) + '\n',
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com',
};

/** Recreates `dir` as the sample repo with one commit on main. Returns its absolute path. */
export function makeSampleRepo(dir) {
  const repo = resolve(dir);
  rmSync(repo, { recursive: true, force: true });
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Demo');
  git('config', 'user.email', 'demo@example.com');
  git('add', '-A');
  git('commit', '-q', '-m', 'greet: a CLI that prints a greeting');
  return repo;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('usage: node make-sample-repo.mjs <dir>'); process.exit(1); }
  console.log(makeSampleRepo(process.argv[2]));
}
