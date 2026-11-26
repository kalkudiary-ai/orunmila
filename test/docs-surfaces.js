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

runAll('docs-surfaces');
