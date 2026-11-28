// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/release-workflow.js — R2 (Phase 7, LD361, LD363; brief v4 line 741): the npm release runs from GitHub
 * Actions, started by hand by O, with npm trusted publishing, so the package carries provenance (a signed link to
 * the exact source it was built from) and no npm token is stored anywhere. The workflow is read as text, a line at a
 * time, by its YAML structure (key at an indent), never by a search of its words.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');

const FILE = path.join(ROOT, '.github', 'workflows', 'release.yml');
const text = () => fs.readFileSync(FILE, 'utf8');
const lines = () => text().split('\n');
const indentOf = (l) => l.length - l.trimStart().length;

/** The block under a top-level or nested key: every following line indented deeper than the key, as text lines. */
function block(key, at = 0, from = lines()) {
  const i = from.findIndex((l) => indentOf(l) === at && l.trim() === `${key}:`);
  if (i < 0) return null;
  const out = [];
  for (const l of from.slice(i + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (indentOf(l) <= at) break;
    out.push(l);
  }
  return out;
}
const keysAt = (b, at) => b.filter((l) => indentOf(l) === at && !l.trim().startsWith('-')).map((l) => l.trim().split(':')[0]);
/** Every `run:` command in the file, multi-line blocks joined, as the shell would get them. */
function runs() {
  const ls = lines();
  const out = [];
  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].trim().replace(/^- /, '');
    if (!t.startsWith('run:')) continue;
    const rest = t.slice(4).trim();
    if (rest !== '|') {
      out.push(rest);
      continue;
    }
    const at = indentOf(ls[i]);
    const body = [];
    for (let j = i + 1; j < ls.length && (ls[j].trim() === '' || indentOf(ls[j]) > at); j++) body.push(ls[j].trim());
    out.push(body.join('\n'));
  }
  return out;
}

it('R2: the release workflow exists and is started only by hand (workflow_dispatch), never by a push, a tag or a schedule', () => {
  assert.ok(fs.existsSync(FILE), '.github/workflows/release.yml');
  const on = block('on');
  assert.ok(on, 'an on: block');
  assert.deepStrictEqual(keysAt(on, 2), ['workflow_dispatch']);
});

it('R2: O types the version to release, and the workflow refuses one that is not package.json\'s', () => {
  const inputs = block('inputs', 4, block('on'));
  assert.ok(inputs && keysAt(inputs, 6).includes('version'), 'a version input');
  // The typed text reaches the shell only through the environment, never pasted into a script (script injection).
  assert.ok(lines().some((l) => l.trim() === 'TYPED: ${{ inputs.version }}'), 'TYPED from inputs.version, as an env value');
  assert.ok(runs().every((r) => !r.includes('${{')), 'no run step interpolates an expression into its script');
  const guard = runs().find((r) => r.includes('"$TYPED"') && r.includes('package.json'));
  assert.ok(guard && guard.includes('exit 1'), 'a step comparing the typed version with package.json and exiting 1');
});

it('R2: it publishes only from main, and refuses a version npm already has', () => {
  const all = runs();
  assert.ok(all.some((r) => r.includes('refs/heads/main') && r.includes('GITHUB_REF') && r.includes('exit 1')), 'a main-only guard');
  // npm 11 exits 1 for a missing version and for a network failure alike, so only npm naming the version refuses.
  assert.ok(all.some((r) => r.includes('npm view') && r.includes('= "$PKG"') && r.includes('exit 1')), 'a guard against a version already published');
});

it('R2: the workflow may only read the code; the OIDC token (id-token: write) is the publish job\'s alone', () => {
  assert.deepStrictEqual(block('permissions').map((l) => l.trim()), ['contents: read']);
  const publish = block('publish', 2, block('jobs'));
  assert.deepStrictEqual(block('permissions', 4, publish).map((l) => l.trim()).sort(), ['contents: read', 'id-token: write']);
  assert.strictEqual(block('permissions', 4, block('test', 2, block('jobs'))), null, 'the test job asks for no permissions of its own');
});

it('R2: the publish job runs in the environment "npm", the one O registers on npmjs.com, after the tests pass on every OS', () => {
  const jobs = block('jobs');
  const names = keysAt(jobs, 2);
  assert.deepStrictEqual(names.sort(), ['publish', 'test']);
  const publish = block('publish', 2, jobs);
  assert.ok(publish.some((l) => l.trim() === 'environment: npm'), 'environment: npm');
  assert.ok(publish.some((l) => l.trim() === 'needs: test'), 'needs: test');
  const test = block('test', 2, jobs).map((l) => l.trim());
  assert.ok(test.includes('os: [ubuntu-latest, macos-latest, windows-latest]'), 'all three OS');
  assert.ok(test.includes('node: [18, 20, 22]'), 'every supported Node');
});

it('R2: npm is new enough for trusted publishing (11.5.1 or later), pinned exactly, and no token is read anywhere', () => {
  const pin = runs().find((r) => /npm install -g npm@\d+\.\d+\.\d+/.test(r));
  assert.ok(pin, 'npm pinned to an exact version');
  const [maj, min, pat] = pin.match(/npm@(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  assert.ok(maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1))), `npm ${maj}.${min}.${pat}`);
  const t = text();
  for (const forbidden of ['secrets.', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', '_authToken']) assert.ok(!t.includes(forbidden), forbidden);
  assert.ok(runs().some((r) => r.split('\n').some((l) => l.startsWith('npm publish'))), 'an npm publish step');
});

it('R2: the publish job runs the gates first, and package.json asks npm for provenance', () => {
  const steps = runs();
  for (const gate of ['npm ci', 'npm test', 'npm run lint', 'npm run accuracy:gate', 'npm run coverage']) assert.ok(steps.some((r) => r.split('\n').includes(gate)), gate);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.publishConfig, { provenance: true, access: 'public' });
});

runAll('release-workflow');
