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

// --- LIC2: the files a release carries --------------------------------------------------------------------------

const crypto = require('crypto');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HOLDER = COPYRIGHT.replace('// Copyright 2026 ', '');
/** SHA-256 of the Apache License 2.0 text at https://www.apache.org/licenses/LICENSE-2.0.txt (compared 2026-11-25). */
const APACHE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD']);

/** The lines of a markdown section, from its `## ` heading to the next one. */
function section(md, heading) {
  const lines = md.split(/\r?\n/);
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) return '';
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  return lines.slice(at, end < 0 ? lines.length : end).join('\n');
}

/** Runtime dependencies THIRD_PARTY_LICENSES does not name. */
function unnamedDeps(pkg, text) {
  return Object.keys(pkg.dependencies || {}).filter((d) => !text.includes(d));
}

/** package-lock.json entries whose licence is missing or not on the permissive list. */
function nonPermissive(lock) {
  return Object.entries(lock.packages || {})
    .filter(([k, v]) => k !== '' && !PERMISSIVE.has(v.license))
    .map(([k, v]) => `${k}: ${v.license}`);
}

it('LIC2: LICENSE is the Apache License 2.0 text, unmodified', () => {
  const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'LICENSE'))).digest('hex');
  assert.strictEqual(sum, APACHE_SHA256);
});

it('LIC2: NOTICE names the holder, stays short, and points at TRADEMARKS.md', () => {
  const notice = read('NOTICE');
  assert.ok(notice.includes(`Copyright 2026 ${HOLDER}`), notice);
  assert.ok(notice.includes('TRADEMARKS.md'), notice);
  assert.ok(notice.split(/\r?\n/).length <= 10, 'every redistributor carries NOTICE: keep it short');
});

it('LIC2: TRADEMARKS.md and THIRD_PARTY_LICENSES exist, name the holder, and ship in the package', () => {
  assert.ok(read('TRADEMARKS.md').includes(HOLDER));
  assert.ok(read('THIRD_PARTY_LICENSES').length > 0);
  const files = JSON.parse(read('package.json')).files;
  for (const f of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_LICENSES']) assert.ok(files.includes(f), `package.json files: ${f}`);
});

it("LIC2: the README's License section links TRADEMARKS.md and THIRD_PARTY_LICENSES and says the name is not licensed", () => {
  const s = section(read('README.md'), 'License');
  assert.ok(s, 'the README has a "## License" section');
  assert.ok(s.includes('(TRADEMARKS.md)') && s.includes('(THIRD_PARTY_LICENSES)'), s);
  assert.ok(s.replace(/\*/g, '').replace(/\s+/g, ' ').includes('no rights to the Orunmila name'), s);
});

it('LIC2: every runtime dependency is named in THIRD_PARTY_LICENSES, and every locked package is permissively licensed', () => {
  assert.deepStrictEqual(unnamedDeps(JSON.parse(read('package.json')), read('THIRD_PARTY_LICENSES')), []);
  const lock = JSON.parse(read('package-lock.json'));
  assert.ok(Object.keys(lock.packages).length > 50, 'the lockfile was read');
  assert.deepStrictEqual(nonPermissive(lock), []);
});

it('LIC2: the dependency checks refuse what they are meant to (planted in memory)', () => {
  assert.deepStrictEqual(unnamedDeps({ dependencies: { leftpad: '1' } }, 'none'), ['leftpad']);
  assert.deepStrictEqual(unnamedDeps({ dependencies: { leftpad: '1' } }, 'leftpad, MIT'), []);
  const lock = (license) => ({ packages: { '': {}, 'node_modules/x': { license } } });
  assert.deepStrictEqual(nonPermissive(lock('GPL-3.0-only')), ['node_modules/x: GPL-3.0-only']);
  assert.deepStrictEqual(nonPermissive(lock('AGPL-3.0')), ['node_modules/x: AGPL-3.0']);
  assert.deepStrictEqual(nonPermissive(lock(undefined)), ['node_modules/x: undefined']);
  assert.deepStrictEqual(nonPermissive(lock('MIT')), []);
  assert.strictEqual(section('# a\n## License\ntext\n## Next\n', 'License'), '## License\ntext');
});

runAll('license-files');
