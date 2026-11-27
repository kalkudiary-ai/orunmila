// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/upgrade-notes.js — EU3 (Phase 7; brief v4 lines 747, 751): a kept command a later version replaces says what
 * replaces it and when, and the changelog's upgrade notes say what changes, what to do and what still works, naming
 * every command existing users may depend on (review/phase0-rerun.md, "Commands and formats", S4.9: 19 commands and
 * one alias). A throwaway ORUNMILA_HOME; nothing recorded is read.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { spawnSync } = require('child_process');

const BIN = path.join(ROOT, 'bin', 'orunmila.js');
const S49 = ['install', 'agents', 'lenses', 'status', 'trail', 'glove', 'report', 'html', 'json', 'feedback', 'feedback-import', 'laws', 'stats', 'prune', 'rescore', 'archives', 'demo', 'watch', 'watch-fs', 'debug-transcript'];
const cli = (args) => {
  const home = tmpDir();
  try {
    return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: home, env: { ...process.env, ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0' } });
  } finally {
    rmrf(home);
  }
};

it('EU3: orunmila html names what replaces it and when: report --verdicts --html, and no sooner than 2.0.0', () => {
  const out = cli(['html']).stdout;
  assert.ok(out.includes('orunmila report --verdicts --session ID --html FILE'), out);
  assert.ok(out.includes('no sooner than 2.0.0'), out);
});

it('EU3: orunmila prune names what replaces it for the intake\'s logs (retention) and says it stays for the old event log', () => {
  const out = cli(['prune']).stdout;
  assert.ok(out.includes('`orunmila retention`') && out.includes('~/.orunmila/events.jsonl'), out);
});

it("EU3: the changelog's Unreleased section has upgrade notes (what changes, what to do, what still works) naming every S4.9 command", () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const unreleased = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [', text.indexOf('## [Unreleased]') + 5));
  const notes = unreleased.slice(unreleased.indexOf('### Upgrading from 0.2.x'));
  assert.ok(unreleased.includes('### Upgrading from 0.2.x'), 'the section');
  for (const part of ['**What changes**', '**What to do**', '**What still works**']) assert.ok(notes.includes(part), part);
  const still = notes.slice(notes.indexOf('**What still works**'));
  const missing = S49.filter((c) => !still.includes('`' + c + '`'));
  assert.deepStrictEqual(missing, [], 'every command users may depend on is named');
});

runAll('upgrade-notes');
