// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/license-files.js — the licence and trademark files a release carries, and the header every JavaScript file
 * carries (LIC1).
 *
 *   - every .js file in bin/, src/, scripts/, test/, examples/ and the repo root opens with the SPDX identifier and
 *     the copyright line, after a `#!` line when it has one. Lines are split on \r?\n, so a Windows checkout with
 *     CRLF endings reads the same.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');

const SPDX = '// SPDX-License-Identifier: Apache-2.0';
const COPYRIGHT = '// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED';
const DIRS = ['bin', 'src', 'scripts', 'test', 'examples'];
const SKIP = new Set(['node_modules', 'coverage', '.git']);

/** Every .js file the header rule covers, as repo-relative paths with `/`. */
function jsFiles() {
  const out = [];
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const child = path.posix.join(rel, ent.name);
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(child);
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) if (ent.isFile() && ent.name.endsWith('.js')) out.push(ent.name);
  return out.sort();
}

/** What is wrong with one file's header, or null. */
function headerProblem(text) {
  const lines = text.split(/\r?\n/);
  const at = lines[0].startsWith('#!') ? 1 : 0;
  if (lines[at] !== SPDX) return `line ${at + 1} is not "${SPDX}"`;
  if (lines[at + 1] !== COPYRIGHT) return `line ${at + 2} is not "${COPYRIGHT}"`;
  return null;
}

it('LIC1: every .js file opens with the SPDX identifier and the copyright line', () => {
  const files = jsFiles();
  assert.ok(files.length > 150, `the set was read: ${files.length} files`);
  const bad = files.map((f) => [f, headerProblem(fs.readFileSync(path.join(ROOT, f), 'utf8'))]).filter(([, p]) => p);
  assert.deepStrictEqual(bad.map(([f, p]) => `${f}: ${p}`), [], `${bad.length} of ${files.length} files`);
});

it('LIC1: the header check refuses each wrong shape it is meant to (planted in memory)', () => {
  const ok = `${SPDX}\n${COPYRIGHT}\n'use strict';\n`;
  assert.strictEqual(headerProblem(ok), null, 'the plain form');
  assert.strictEqual(headerProblem(`#!/usr/bin/env node\n${ok}`), null, 'after a #! line');
  assert.strictEqual(headerProblem(ok.replace(/\n/g, '\r\n')), null, 'CRLF endings');
  assert.ok(headerProblem("'use strict';\n"), 'no header');
  assert.ok(headerProblem(`'use strict';\n${ok}`), 'header below code');
  assert.ok(headerProblem(`${COPYRIGHT}\n${SPDX}\n`), 'lines swapped');
  assert.ok(headerProblem(`${SPDX}\n// Copyright 2026 someone else\n`), 'another owner');
  assert.ok(headerProblem(`${SPDX.replace('Apache-2.0', 'MIT')}\n${COPYRIGHT}\n`), 'another licence');
});

runAll('license-files');
