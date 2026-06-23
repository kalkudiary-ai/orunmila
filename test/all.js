'use strict';

/**
 * test/all.js
 *
 * Runs every suite, each in its own child process (each suite calls
 * process.exit, so they can't share one). Aggregates pass/fail and exits
 * non-zero if any suite failed. This is the single entry `npm test` uses, and
 * the one `npm run coverage` wraps with c8.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const SUITES = ['run.js', 'trail.js', 'sentinel.js', 'unit.js', 'hooks.js', 'transcript.js', 'agents.js', 'redact.js', 'demo.js', 'stats.js'];

let failed = 0;
for (const suite of SUITES) {
  try {
    const out = execFileSync('node', [path.join(__dirname, suite)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    failed++;
  }
}

console.log(`\n=== ${SUITES.length - failed}/${SUITES.length} suites passed ===`);
process.exit(failed ? 1 : 0);
