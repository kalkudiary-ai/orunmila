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

runAll('docs-surfaces');
