'use strict';

/**
 * Rescores every turn in ~/.orunmila/reports/ with the current (post-fix)
 * reconciler and compares the new summary against the persisted (old) one.
 * Prints aggregate before/after totals and per-session deltas for the noisiest
 * sessions, so the effect of the precision changes on real captured data is
 * measurable, not just claimed.
 *
 * Run: node scripts/rescore-all-sessions.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { reconcileTurn } = require('../src/reconcile/matcher');
const { extractSubtasks } = require('../src/reconcile/task-extractor');
const { readTurn, readBetween, TYPES } = require('../src/store/eventlog');

const REPORTS_DIR = path.join(os.homedir(), '.orunmila', 'reports');
const KEYS = [
  'verified',
  'partial',
  'phantom',
  'phantom_verification',
  'unverifiable',
  'silently_dropped',
  'unverifiable_ask',
  'undisclosed_changes',
  'untracked_writes',
];

function sentinelWritesForTurn(hookEvents) {
  const stamps = hookEvents.map((e) => e.ts).filter(Boolean).sort();
  if (!stamps.length) return [];
  const fromTs = stamps[0];
  const toTs = stamps[stamps.length - 1];
  return readBetween(fromTs, toTs).filter(
    (e) => e.source === 'fs-sentinel' && e.type === TYPES.FILE_WRITE
  );
}

function priorSessionTargets(sessionId, currentTurnId) {
  const targets = [];
  let i = 1;
  while (true) {
    const tid = `t${i}`;
    if (tid === currentTurnId) break;
    const events = readTurn(sessionId, tid);
    if (!events.length) break;
    const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
    if (promptEvent && promptEvent.text) {
      for (const s of extractSubtasks(promptEvent.text)) {
        for (const t of s.targets || []) targets.push(t);
      }
    }
    i++;
    if (i > 1000) break;
  }
  return targets;
}

function rescoreTurn(sessionId, turnId) {
  const events = readTurn(sessionId, turnId);
  if (!events.length) return null;
  const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
  const claimEvent = events.find((e) => e.type === TYPES.TURN_CLAIM);
  const sentinelEvents = sentinelWritesForTurn(events);
  return reconcileTurn({
    promptText: promptEvent ? promptEvent.text : '',
    claimText: claimEvent ? claimEvent.text : '',
    turnEvents: events.concat(sentinelEvents),
    sessionTargets: priorSessionTargets(sessionId, turnId),
  });
}

function loadPersisted(sessionId) {
  const dir = path.join(REPORTS_DIR, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ turnId: f.replace(/\.json$/, ''), report: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

function zero() {
  const o = {};
  for (const k of KEYS) o[k] = 0;
  return o;
}

function addInto(acc, summary) {
  for (const k of KEYS) acc[k] += summary[k] || 0;
}

function noiseScore(summary) {
  return (
    (summary.phantom || 0) +
    (summary.phantom_verification || 0) +
    (summary.silently_dropped || 0) +
    (summary.undisclosed_changes || 0)
  );
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function lpad(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function main() {
  const sessions = fs.readdirSync(REPORTS_DIR).sort();
  const before = zero();
  const after = zero();
  let turnsScored = 0;
  let turnsSkipped = 0;
  const perSession = [];

  for (const sessionId of sessions) {
    const persisted = loadPersisted(sessionId);
    const beforeS = zero();
    const afterS = zero();
    let turns = 0;

    for (const { turnId, report } of persisted) {
      const newReport = rescoreTurn(sessionId, turnId);
      if (!newReport) {
        turnsSkipped++;
        continue;
      }
      addInto(beforeS, report.summary || {});
      addInto(afterS, newReport.summary);
      turns++;
    }

    if (!turns) continue;
    addInto(before, beforeS);
    addInto(after, afterS);
    turnsScored += turns;
    perSession.push({ sessionId, turns, before: beforeS, after: afterS });
  }

  console.log('\n=== orunmila precision changes vs. on-disk persisted reports ===\n');
  console.log(`Sessions scanned: ${perSession.length}`);
  console.log(`Turns rescored:   ${turnsScored}`);
  if (turnsSkipped) console.log(`Turns skipped (no events in log): ${turnsSkipped}`);
  console.log();

  console.log('Aggregate totals across every turn:\n');
  console.log(`  ${pad('outcome', 24)} ${lpad('before', 8)}  ${lpad('after', 8)}  ${lpad('delta', 8)}`);
  console.log(`  ${'-'.repeat(24)} ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}`);
  for (const k of KEYS) {
    const b = before[k];
    const a = after[k];
    const d = a - b;
    const dStr = d > 0 ? `+${d}` : `${d}`;
    console.log(`  ${pad(k, 24)} ${lpad(b, 8)}  ${lpad(a, 8)}  ${lpad(dStr, 8)}`);
  }

  const noiseBefore = noiseScore(before);
  const noiseAfter = noiseScore(after);
  const noiseDelta = noiseAfter - noiseBefore;
  const pct = noiseBefore ? (100 * noiseDelta) / noiseBefore : 0;
  console.log();
  console.log(`  Noise total (phantom + phv + silently_dropped + undisclosed):`);
  console.log(`    before: ${noiseBefore}`);
  console.log(`    after:  ${noiseAfter}`);
  console.log(`    delta:  ${noiseDelta} (${pct.toFixed(1)}%)`);

  // Top 10 sessions by absolute noise reduction
  const ranked = perSession
    .map((s) => ({ ...s, drop: noiseScore(s.before) - noiseScore(s.after) }))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 10);

  console.log('\nTop 10 sessions by noise reduction:\n');
  console.log(`  ${pad('session', 10)} ${lpad('turns', 6)}  ${lpad('phantom', 18)}  ${lpad('phv', 14)}  ${lpad('silent_drop', 16)}  ${lpad('undisclosed', 16)}`);
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(6)}  ${'-'.repeat(18)}  ${'-'.repeat(14)}  ${'-'.repeat(16)}  ${'-'.repeat(16)}`);
  for (const s of ranked) {
    if (s.drop === 0) continue;
    const fmt = (k) => `${s.before[k]} → ${s.after[k]}`;
    console.log(
      `  ${pad(s.sessionId.slice(0, 8), 10)} ${lpad(s.turns, 6)}  ${lpad(fmt('phantom'), 18)}  ${lpad(fmt('phantom_verification'), 14)}  ${lpad(fmt('silently_dropped'), 16)}  ${lpad(fmt('undisclosed_changes'), 16)}`
    );
  }

  // Sessions where the new engine surfaces NEW findings the old missed (rare but
  // worth flagging — these are real signals, not regressions). We only flag
  // increases in phantom/phantom_verification; new undisclosed/silently_dropped
  // are usually from the session-stable target index catching previously-missed
  // creep, which is good, but we want to know either way.
  const increases = perSession
    .filter((s) => noiseScore(s.after) > noiseScore(s.before))
    .map((s) => ({ ...s, gain: noiseScore(s.after) - noiseScore(s.before) }))
    .sort((a, b) => b.gain - a.gain);
  if (increases.length) {
    console.log('\nSessions where new engine found MORE issues than the old (potential real signal):\n');
    for (const s of increases.slice(0, 10)) {
      console.log(
        `  ${s.sessionId.slice(0, 8)}  +${s.gain}  ` +
          KEYS.filter((k) => (s.after[k] || 0) > (s.before[k] || 0))
            .map((k) => `${k}: ${s.before[k]}→${s.after[k]}`)
            .join('  ')
      );
    }
  }
}

main();
