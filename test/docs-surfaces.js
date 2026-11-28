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

// DOC6 (Phase 7; brief v4 lines 719-733): the docs for a reader who has never heard of Orunmila.
it("DOC6: docs/START.md has each part the brief asks for, the README's first table sends a new user there, and the vocabulary names the brief's terms", () => {
  const start = read('docs/START.md');
  for (const h of ['## What it is', '## Install, and your first session', '## Reading a session report', '## The words Orunmila uses', '## What it defends against, and what it does not', '## What it stores, where, and for how long', '## Which agents are supported']) assert.ok(start.includes(h + '\n'), h);
  for (const term of ['| Orunmila |', '| Glove |', '| Sentinel |', '| Mark (àmì) |', '| Ọpọ́n |', '| Odù |', '| Babaláwo |', '| Law gate |', '| Ọ̀pẹ̀lẹ̀ |']) assert.ok(start.includes(term), term);
  for (const part of ['Output 2 (Ọ̀pẹ̀lẹ̀)', 'Output 3', 'administrator rights', 'Whether a record is complete', '`orunmila leak-check`', '`orunmila retention --keep-days N --yes`']) assert.ok(start.includes(part), part);
  assert.ok(read('README.md').includes('| [docs/START.md](docs/START.md) |'), 'the README sends a new user to it');
});

it("DOC6 (lines 727-732): the support table is the same in START.md, the README and the guide, and says what src/capture/support.js says", () => {
  const { supportOf } = require('../src/capture/support');
  const rows = (text) => text.split('\n').filter((l) => /^\| (Claude Code|Cursor|Gemini CLI, Codex, Continue, Antigravity, Generic|Aider|Windsurf) \| [A-Z]/.test(l));
  const start = rows(read('docs/START.md'));
  assert.strictEqual(start.length, 5);
  assert.deepStrictEqual(rows(read('README.md')), start);
  assert.ok(start.every((r) => read('docs/GUIDE.md').includes(r)));
  assert.strictEqual(supportOf('claude-code').status, 'supported');
  // CU2: Cursor's row from test 49's result, the same limits the report's source states; CG1 (LD394): its gate.
  for (const w of ['tested on real sessions', "Cursor's command-line agent", 'test 49', 'the Closeout Gate, whose block arrives as an automatic follow-up message', 'not yet run there']) assert.ok(start[1].includes(w) && supportOf('cursor').words.includes(w), `Cursor row: ${w}`);
  assert.ok(start[3].includes('sentinel only') && start[4].includes('No adapter exists'));
});

it("SW4 (the close-out's sweep): the help names both agents the Closeout Gate runs for", () => {
  const help = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'help'], { encoding: 'utf8' }).stdout;
  assert.ok(help.includes('claude-code and cursor. 2 of its 6 laws block'), help);
  assert.ok(!help.includes('claude-code only. 2 of'), 'the old words are gone');
});

it("SW1 (Phase 7's sweep): the help sends a new user to docs/START.md, and says when html goes (no sooner than 2.0.0)", () => {
  const help = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'help'], { encoding: 'utf8' }).stdout;
  assert.ok(help.includes('docs/START.md (new to Orunmila)'), help);
  assert.ok(help.includes('report --verdicts --html replaces it; removed no sooner than 2.0.0'), help);
});

it('DOC5 (LD358): the help sends a reader to the guide as well as the README', () => {
  const { spawnSync } = require('child_process');
  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js')], { encoding: 'utf8' }).stdout;
  const docs = help.split('\n').find((l) => l.startsWith('Docs:'));
  assert.ok(docs && docs.includes('docs/GUIDE.md'), docs);
});

runAll('docs-surfaces');
