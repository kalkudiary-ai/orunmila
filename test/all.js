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

const SUITES = ['run.js', 'trail.js', 'trail-json.js', 'sentinel.js', 'unit.js', 'hooks.js', 'transcript.js', 'agents.js', 'redact.js', 'demo.js', 'stats.js', 'feedback.js', 'vcs-evidence.js', 'laws.js', 'turn-boundaries.js', 'secure.js', 'claim-corpus.js', 'leopard-check.js', 'spec.js', 'canonical.js', 'chain.js', 'session-log.js', 'verify.js', 'redact-intake.js', 'paths.js', 'adapter-events-v0.js', 'adapter-claude-code.js', 'adapter-law-gate.js', 'header.js', 'strip.js', 'mono.js', 'mutation-gate.js', 'intake-engine.js', 'intake-router.js', 'intake-server.js', 'intake-send.js', 'overlap.js', 'retention.js', 'receipts.js', 'prompts.js', 'test-command.js', 'leak-check.js', 'turbo.js', 'launch-agent.js', 'intake-sentinel.js', 'gate-marks.js', 'tamper.js', 'gate-from-marks.js', 'trail-marks.js', 'replay.js', 'settle.js', 'group.js', 'odu.js', 'baseline.js'];

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
