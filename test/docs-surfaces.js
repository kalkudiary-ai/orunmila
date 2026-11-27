// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/docs-surfaces.js — DOC3 (LD340; CLAUDE.md close-out items 5 and 6: every surface brought up to date at each
 * phase's end). The skill a user's agent reads first (SKILL.md) names what Orunmila does now: the three lenses and how
 * each is installed, the session report, the trailer, the claims block, `orunmila update`, what an install leaves in
 * Orunmila's home, and the trail page's 3D Map; and no longer says the lenses are two. A lag guard, not a review: the
 * close-out still reads each surface whole.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');

it('DOC3 (LD340): SKILL.md names every lens, command and page a user can reach now', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const want = ['The Babaláwo', 'install --with-judge', 'report --verdicts', 'orunmila trailer', 'orunmila-claims', 'ORUNMILA_CLAIMS_BLOCK', 'orunmila update', '~/.orunmila/bin/orunmila-start.js', '3D Map'];
  assert.deepStrictEqual(want.filter((w) => !skill.includes(w)), []);
  assert.ok(!skill.includes('It has two lenses'), 'three lenses now');
});

it("DOC4 (LD348): the help names every intake subcommand the intake's own usage lists, and says report --verdicts replaces html", () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(ROOT, 'bin', 'orunmila.js');
  const help = spawnSync(process.execPath, [cli], { encoding: 'utf8' }).stdout;
  const usage = spawnSync(process.execPath, [cli, 'intake'], { encoding: 'utf8' });
  const subs = (usage.stdout + usage.stderr).split('orunmila intake ')[1].trim().split('|');
  assert.ok(subs.length >= 6, subs.join(' '));
  const intakeLines = help.split('\n').filter((l) => l.trim().startsWith('orunmila intake '));
  const named = new Set(intakeLines.flatMap((l) => l.trim().split(/\s+/)[2].split('|')));
  assert.deepStrictEqual(subs.filter((s) => !named.has(s)), []);
  const html = help.split('\n').find((l) => l.trim().startsWith('orunmila html '));
  assert.ok(html && html.includes('report --verdicts'), html);
});

it('DOC4 (LD348): the README no longer says hooks name the package path, and SECURITY.md names the intake on Windows', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!readme.includes('node "<path to the installed package>/src/capture/claude-code/<hook>.js"'), 'hooks run the starter since PM2b');
  const sec = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.ok(sec.includes('named pipe') && sec.includes('intake/address'), 'the Windows pipe and its address file');
});

// DOC5 (the in-house dev, LD344 §1.2: "The README is too much at once. No clear way in for a contributor; it reads as
// written for agents"): the README is a short way in, the whole reference is docs/GUIDE.md, and CONTRIBUTING.md
// carries a map of the system.
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/** Every inline markdown link target in a file, with the file it is relative to. */
function linksOf(f) {
  const t = read(f);
  const out = [];
  let i = 0;
  while ((i = t.indexOf('](', i)) >= 0) {
    const j = t.indexOf(')', i + 2);
    if (j < 0) break;
    out.push(t.slice(i + 2, j).split(' ')[0]);
    i = j;
  }
  return out;
}

it('DOC5 (LD358): the README is a short way in: under 260 lines, a "Start here" table, and the guide one link away', () => {
  const readme = read('README.md');
  const lines = readme.split('\n').length;
  assert.ok(lines < 260, `the README is ${lines} lines`);
  assert.ok(readme.includes('## Start here'), 'a way in, first');
  assert.ok(readme.includes('](docs/GUIDE.md)'), 'the guide is linked');
  assert.ok(readme.includes('](CONTRIBUTING.md)'), 'and the contributor guide');
});

it('DOC5 (LD358): the README names three lenses, as the help and SKILL.md do, never two', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('The two lenses') && !readme.includes('two different jobs'), 'two lenses is stale');
  for (const lens of ['The Stain Map', 'The Closeout Gate', 'The Babaláwo']) assert.ok(readme.includes(lens), lens);
});

it('DOC5 (LD358): every table row the README shows is the guide\'s too, word for word, so the two cannot drift', () => {
  const guide = read('docs/GUIDE.md');
  // Every table row, by the section it sits in; the "Start here" table points elsewhere, so it is the README's own.
  let section = '';
  const rows = [];
  for (const l of read('README.md').split('\n')) {
    if (l.startsWith('## ')) section = l;
    else if (l.startsWith('| ') && section !== '## Start here') rows.push(l);
  }
  assert.ok(rows.length >= 10, `${rows.length} rows`);
  assert.deepStrictEqual(rows.filter((r) => !guide.includes(r)), []);
});

it('DOC5 (LD358): every relative link in the README, the guide and CONTRIBUTING.md reaches a file that exists', () => {
  const bad = [];
  for (const f of ['README.md', 'docs/GUIDE.md', 'CONTRIBUTING.md']) {
    for (const target of linksOf(f)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = path.join(ROOT, path.dirname(f), decodeURI(target.split('#')[0]));
      if (!fs.existsSync(file)) bad.push(`${f} -> ${target}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

it("DOC5 (LD358): CONTRIBUTING.md maps the system: every folder in src/ is named, and the update check is the tool's one network call", () => {
  const c = read('CONTRIBUTING.md');
  assert.ok(c.includes('## A map of the system'), 'the map');
  const dirs = fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepStrictEqual(dirs.filter((d) => !c.includes(`src/${d}/`)), []);
  assert.ok(!c.includes('"phone-home" version checks'), 'stale: the daily update check exists since UD1');
  assert.ok(c.includes('orunmila update'), 'the one network call, named');
});

it('DOC5 (LD358): the help sends a reader to the guide as well as the README', () => {
  const { spawnSync } = require('child_process');
  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js')], { encoding: 'utf8' }).stdout;
  const docs = help.split('\n').find((l) => l.startsWith('Docs:'));
  assert.ok(docs && docs.includes('docs/GUIDE.md'), docs);
});

runAll('docs-surfaces');
