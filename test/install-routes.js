// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/install-routes.js — PM1 (LD335; Phase 5 plan section 6): scripts/install-routes.js installs this repository by
 * every npm route (npm i -g, npx, npm i -D) into a throwaway machine, and for each: every hook names the starter in
 * Orunmila's home, the prompt hook runs as written and is recorded, and it still is once the route's copy is removed
 * (a global folder, npx's cache, node_modules). The pnpm routes need pnpm (corepack fetches it, which needs the
 * network), so they run in CI and by hand: `node scripts/install-routes.js --only pnpm`.
 */

const { assert, run, it, runAll } = require('./helpers');

it('PM1 (LD335): every npm route writes hooks that name the starter, and they run and record before and after the route\'s copy is removed', () => {
  const r = run('scripts/install-routes.js', { args: ['--only', 'npm'] });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const routes = lines.filter((l) => l.route);
  assert.deepStrictEqual(routes.map((x) => x.route), ['npm-global', 'npx', 'npm-dev'], r.stdout + r.stderr);
  for (const x of routes) assert.deepStrictEqual([x.route, x.hooks, x.ran, x.gone, x.cleared], [x.route, true, true, true, true], JSON.stringify(x));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

// DOC5 (LD358): every route's line moved from the README to the guide (docs/GUIDE.md, "Quickstart: every route"),
// which the README links to; the README keeps one route and the link.
it('PM4 (LD337, DOC5): the guide gives the install line of every route the script checks, and what every route leaves behind', () => {
  const { fs, path, ROOT } = require('./helpers');
  const { ROUTES } = require('../scripts/install-routes');
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'GUIDE.md'), 'utf8');
  const missing = Object.entries(ROUTES).filter(([, r]) => !guide.includes(r.readme)).map(([n, r]) => `${n}: ${r.readme}`);
  assert.deepStrictEqual(missing, []);
  assert.ok(guide.includes('~/.orunmila/bin/orunmila-start.js'), 'it says what every route leaves behind: hooks that run the starter');
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('](docs/GUIDE.md#quickstart-every-route)'), 'the README links to every route');
});

runAll('install-routes');
