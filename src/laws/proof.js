// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * proof.js — does a turn's record PROVE that its tests passed?
 *
 * The green law (no-green-without-command) takes any command that did not fail
 * as the receipt for "tests pass" (NF40): `ls`, `npm test || true`, or a failed
 * run followed by `echo ok` all clear it. This module is the stricter reading,
 * built to be wired in behind a switch (plan slice 4) and measured first.
 *
 * A turn's tests are proven when its last test run that settles anything is a
 * proof, and no failed run comes after it. A command line proves a pass when:
 *
 *   - one of its steps is a test runner (facts.js RUNNERS, the same list the
 *     facts line uses);
 *   - the record holds a pass for the line, after the adapter's translation
 *     (Claude Code reports a passing command with no code; for any other agent
 *     a missing code is unknown, and unknown proves nothing);
 *   - nothing after the runner decides the line's status: a later `;`, `||`
 *     or new line does, `&&` does not (it runs only after a pass);
 *   - the runner was certain to run: a `||` before it means it may not have;
 *   - its status is not laundered by a pipe after it, unless `set -o pipefail`
 *     (or `set -…o pipefail`, or zsh's `setopt pipefail`) is an earlier step on
 *     the same line. The word anywhere else, a comment or a PIPESTATUS echo,
 *     proves nothing (NF52).
 *
 * `echo`, `ls` and `cat` are not runners, so they never prove anything. A run
 * in another folder (`cd ../other && npm test`) still proves; recognising the
 * project's own test command is later work (plan item 10).
 */

const { isRunnerStep, status, unquoted } = require('./facts');

const OPERATOR = /(\|\||&&|\|&|;|\||\n)/;
const PIPEFAIL_STEP = /^(?:set\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*o\s+pipefail|setopt\s+pipefail)\b/;

/** One line as steps, each with the operator before and after it. */
function steps(command) {
  const parts = unquoted(command).split(OPERATOR);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({ text: parts[i].trim(), before: i ? parts[i - 1] : null, after: i + 1 < parts.length ? parts[i + 1] : null });
  }
  return out;
}

/**
 * The verdict on one test-run line: 'proof', 'failed', 'unknown', 'masked'
 * (a later step decides the status), 'guarded' (a `||` before the runner) or
 * 'piped' (a pipe after it, with no pipefail set first).
 */
function verdict(e) {
  const s = status(e);
  if (s.startsWith('fail')) return 'failed';
  if (s !== 'pass') return 'unknown';
  const list = steps(e.command);
  const last = list.map((st) => isRunnerStep(st.text)).lastIndexOf(true);
  const runner = list[last];
  if (runner.before === '||') return 'guarded';
  const pipefail = list.slice(0, last).some((st) => PIPEFAIL_STEP.test(st.text));
  for (let i = last; i < list.length; i++) {
    const st = list[i];
    // A trailing `;` or new line with nothing after it decides nothing.
    const more = list.slice(i + 1).some((next) => next.text);
    if ((st.after === ';' || st.after === '||' || st.after === '\n') && more) return 'masked';
    if ((st.after === '|' || st.after === '|&') && !pipefail) return 'piped';
  }
  return 'proof';
}

/**
 * Read a turn's events in order. Returns { proven, by, runs }: `by` is the
 * command that proves the pass, and `runs` lists every test run with its
 * verdict, so a finding can say why a run did not count.
 */
function proofOfPass(turnEvents) {
  const runs = [];
  for (const e of turnEvents || []) {
    if (!e || e.type !== 'command_run' || typeof e.command !== 'string') continue;
    if (!unquoted(e.command).split(OPERATOR).some(isRunnerStep)) continue;
    runs.push({ command: e.command, verdict: verdict(e) });
  }
  let by = null;
  for (const r of runs) {
    if (r.verdict === 'proof') by = r.command;
    else if (r.verdict === 'failed') by = null;
  }
  return { proven: by !== null, by, runs };
}

/**
 * The switch: ORUNMILA_STRICT_PROOF=1 and nothing else. On, the gate's green
 * law and the Stain Map take only a proof of pass. Off, both judge as before.
 */
function strictProofEnabled() {
  return process.env.ORUNMILA_STRICT_PROOF === '1';
}

module.exports = { proofOfPass, verdict, strictProofEnabled, PIPEFAIL_STEP };
