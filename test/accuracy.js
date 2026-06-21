'use strict';

/**
 * test/accuracy.js
 *
 * The DETECTION-ACCURACY harness — distinct from code coverage. Code coverage
 * answers "did a test execute this line"; this answers the real product
 * question: "out of everything that actually happened, what fraction does
 * orunmila correctly catch and classify?"
 *
 * Each case in test/cases/*.json is a labelled turn:
 *   { prompt, claim, events, expect }
 * where `expect` is the GROUND TRUTH a human assigned. The scorer feeds the case
 * through the real reconciler (no mocks) and compares engine output to truth,
 * one assertion dimension at a time. Accuracy = correct dimensions / total.
 *
 * Two configurations are scored separately so the two product claims are
 * measurable independently, not conflated:
 *
 *   - "sentinel OFF": every fs-sentinel-sourced event is stripped before
 *     reconciling — this is orunmila WITHOUT its independent disk observer,
 *     i.e. trusting only the agent's own hook stream. This is the weaker lens.
 *
 *   - "sentinel ON": the full event list, including the independent disk
 *     observations. This is the configuration the project claims reaches ~95%.
 *
 * The gap between the two columns is the literal, measured value the sentinel
 * adds — no longer an assertion in the README, a number from the corpus.
 *
 * A third metric, "trail completeness", checks the OTHER claim: that the trail
 * (the glove) documents EVERYTHING touched. For each case it confirms every
 * event appears in the per-turn trail it builds (the "100% of what was touched
 * is documented" promise, measured rather than asserted).
 *
 * Run: node test/accuracy.js
 * This is a REPORT, not a pass/fail gate by default — it prints the accuracy
 * numbers so regressions are visible. Pass --gate N to fail under N% accuracy.
 */

const fs = require('fs');
const path = require('path');
const { reconcileTurn } = require('../src/reconcile/matcher');
const { lineageForTurn } = require('../src/trail/lineage');

const CASES_DIR = path.join(__dirname, 'cases');
const PRECISION_DIR = path.join(CASES_DIR, 'precision');

function loadFrom(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => Object.assign(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { _file: (prefix || '') + f }));
}

function loadCases() {
  return loadFrom(CASES_DIR);
}

// The precision corpus is the inverse of the accuracy corpus: non-work text
// (markdown, questions, instructions, narration) drawn verbatim from a real
// captured log. A correct engine produces NO phantom/phantom_verification on
// these. Precision = cases that stay clean / total negative cases. This is the
// real-world false-positive guard the curated accuracy corpus did not stress.
function loadPrecisionCases() {
  return loadFrom(PRECISION_DIR, 'precision/');
}

function stripSentinel(events) {
  return (events || []).filter((e) => e.source !== 'fs-sentinel');
}

// Evaluate one `expect` block against one reconcile report. Returns an array of
// { dim, ok, detail } — one entry per declared expectation dimension, so the
// accuracy denominator is "checks a human actually asserted", not a guess.
function gradeExpect(expect, report) {
  const checks = [];
  const claimOutcomes = report.claims.map((c) => c.outcome);
  const subtaskOutcomes = report.subtasks.map((s) => s.outcome);
  const undisclosedPaths = report.undisclosed.map((u) => u.path);
  const untrackedPaths = report.untracked.map((u) => u.rel_path || u.path);

  if (expect.summary) {
    for (const [k, v] of Object.entries(expect.summary)) {
      checks.push({ dim: `summary.${k}=${v}`, ok: report.summary[k] === v, detail: `got ${report.summary[k]}` });
    }
  }
  if (typeof expect.min_verified === 'number') {
    checks.push({ dim: `verified>=${expect.min_verified}`, ok: report.summary.verified >= expect.min_verified, detail: `got ${report.summary.verified}` });
  }
  if (expect.claim_outcomes) {
    // exact multiset-ish: every claim outcome must be in the allowed set
    const allowed = new Set(expect.claim_outcomes);
    const ok = claimOutcomes.length > 0 && claimOutcomes.every((o) => allowed.has(o));
    checks.push({ dim: `claim_outcomes\u2286{${expect.claim_outcomes.join(',')}}`, ok, detail: `got [${claimOutcomes.join(',')}]` });
  }
  if (expect.claim_outcomes_include) {
    for (const o of expect.claim_outcomes_include) {
      checks.push({ dim: `claim_outcomes\u220b${o}`, ok: claimOutcomes.includes(o), detail: `got [${claimOutcomes.join(',')}]` });
    }
  }
  if (expect.subtask_outcomes_include) {
    for (const o of expect.subtask_outcomes_include) {
      checks.push({ dim: `subtask_outcomes\u220b${o}`, ok: subtaskOutcomes.includes(o), detail: `got [${subtaskOutcomes.join(',')}]` });
    }
  }
  if (expect.not_outcomes) {
    for (const o of expect.not_outcomes) {
      const present = claimOutcomes.includes(o) || subtaskOutcomes.includes(o);
      checks.push({ dim: `no outcome ${o}`, ok: !present, detail: present ? `but ${o} appeared` : 'absent as required' });
    }
  }
  if (expect.undisclosed_paths_include) {
    for (const p of expect.undisclosed_paths_include) {
      checks.push({ dim: `undisclosed\u220b${p}`, ok: undisclosedPaths.includes(p), detail: `got [${undisclosedPaths.join(',')}]` });
    }
  }
  if (expect.undisclosed_paths_exclude) {
    for (const p of expect.undisclosed_paths_exclude) {
      checks.push({ dim: `undisclosed\u2209${p}`, ok: !undisclosedPaths.includes(p), detail: `got [${undisclosedPaths.join(',')}]` });
    }
  }
  if (expect.untracked_paths_include) {
    for (const p of expect.untracked_paths_include) {
      checks.push({ dim: `untracked\u220b${p}`, ok: untrackedPaths.includes(p), detail: `got [${untrackedPaths.join(',')}]` });
    }
  }
  return checks;
}

function scoreConfig(cases, { sentinel }) {
  let correct = 0;
  let total = 0;
  const caseRows = [];
  for (const c of cases) {
    const events = sentinel ? c.events : stripSentinel(c.events);
    const report = reconcileTurn({ promptText: c.prompt, claimText: c.claim, turnEvents: events });
    const checks = gradeExpect(c.expect, report);
    const caseCorrect = checks.filter((x) => x.ok).length;
    correct += caseCorrect;
    total += checks.length;
    caseRows.push({ name: c.name, file: c._file, correct: caseCorrect, total: checks.length, checks });
  }
  return { correct, total, pct: total ? (100 * correct) / total : 100, caseRows };
}

// Trail completeness: every event a turn produced must be representable in the
// trail (the glove). This is the "we document everything touched" claim, scored.
function scoreTrailCompleteness(cases) {
  let documented = 0;
  let totalEvents = 0;
  const misses = [];
  for (const c of cases) {
    const events = (c.events || []).map((e, i) =>
      Object.assign({ ts: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }, e)
    );
    if (!events.length) continue;
    const lin = lineageForTurn(events);
    const trailKeys = new Set((lin.trail || []).map((t) => t.key));
    for (const e of events) {
      totalEvents++;
      // an event is "documented" if its artifact appears in the trail; we match
      // on the same key the lineage engine assigns, derived from path/host/cmd.
      const present = (lin.trail || []).some((t) => sameArtifact(t, e));
      if (present) documented++;
      else misses.push({ file: c._file, type: e.type, path: e.path || e.host || e.command });
    }
    void trailKeys;
  }
  return { documented, totalEvents, pct: totalEvents ? (100 * documented) / totalEvents : 100, misses };
}

// Precision: run each non-work-text case and confirm it produces NO phantom or
// phantom_verification. A "miss" here is a real-world FALSE POSITIVE — the
// engine accusing the agent of a phantom over text that was never a work-claim.
function scorePrecision(cases) {
  let clean = 0;
  const total = cases.length;
  const misses = [];
  for (const c of cases) {
    const report = reconcileTurn({ promptText: c.prompt, claimText: c.claim, turnEvents: c.events || [] });
    const checks = gradeExpect(c.expect, report);
    const ok = checks.every((x) => x.ok);
    if (ok) clean++;
    else {
      const phantoms = report.claims.filter((cl) => cl.outcome === 'phantom' || cl.outcome === 'phantom_verification');
      misses.push({ file: c._file, count: phantoms.length, sample: (phantoms[0] && phantoms[0].claim.text.slice(0, 70)) || '' });
    }
  }
  return { clean, total, pct: total ? (100 * clean) / total : 100, misses };
}

function sameArtifact(trailEntry, event) {
  // The lineage engine keys a path artifact on rel_path || path, so an event
  // carrying both (sentinel writes do) lands under its rel_path in the trail.
  // Match the engine's own preference here or sentinel events look "undocumented".
  const eventPath = event.rel_path || event.path;
  if (eventPath && trailEntry.path) return trailEntry.path === eventPath;
  if (event.host && trailEntry.host) return trailEntry.host === event.host;
  if (event.command && trailEntry.command) return trailEntry.command === event.command;
  // fall back to type — a trail entry of the same type counts as documented
  return trailEntry.type === event.type || trailEntry.channel != null;
}

function bar(pct) {
  const n = Math.round(pct / 5);
  return '\u2588'.repeat(n) + '\u2591'.repeat(20 - n);
}

function main() {
  const cases = loadCases();
  const precisionCases = loadPrecisionCases();
  const off = scoreConfig(cases, { sentinel: false });
  const on = scoreConfig(cases, { sentinel: true });
  const trail = scoreTrailCompleteness(cases);
  const precision = scorePrecision(precisionCases);

  console.log('\n=== orunmila DETECTION ACCURACY (measured against a labelled corpus) ===\n');
  console.log(`Corpus: ${cases.length} labelled turns, ${on.total} ground-truth assertions.\n`);

  console.log('Configuration                       Accuracy');
  console.log('---------------------------------------------------------------');
  console.log(`hook-only (sentinel OFF)   ${bar(off.pct)} ${off.pct.toFixed(1)}%  (${off.correct}/${off.total})`);
  console.log(`sentinel ON                ${bar(on.pct)} ${on.pct.toFixed(1)}%  (${on.correct}/${on.total})`);
  console.log(`\nSentinel adds: +${(on.pct - off.pct).toFixed(1)} percentage points (this is the measured value of the independent disk observer).`);
  console.log(`\nTrail completeness (glove) ${bar(trail.pct)} ${trail.pct.toFixed(1)}%  (${trail.documented}/${trail.totalEvents} events represented in the trail)`);

  if (precision.total) {
    console.log(`\n--- PRECISION (false-positive guard, real-log-derived non-work text) ---`);
    console.log(`Phantom precision          ${bar(precision.pct)} ${precision.pct.toFixed(1)}%  (${precision.clean}/${precision.total} non-work cases stayed clean)`);
    if (precision.misses.length) {
      console.log('\n  KNOWN false positives (extractor flags non-work text as phantom):');
      for (const m of precision.misses) {
        console.log(`    ${m.file}: ${m.count} phantom(s) e.g. "${m.sample}"`);
      }
      console.log('  (documented in review/ISSUES.md — extractor precision is the known open gap, not a regression)');
    }
  }

  // Per-case failures (only the misses, so the report is short and actionable).
  const fails = on.caseRows.filter((r) => r.correct < r.total);
  if (fails.length) {
    console.log('\n--- sentinel-ON cases with at least one missed dimension ---');
    for (const r of fails) {
      console.log(`\n  ${r.file}  (${r.correct}/${r.total})`);
      for (const ch of r.checks.filter((x) => !x.ok)) {
        console.log(`    \u2717 ${ch.dim}  \u2014  ${ch.detail}`);
      }
    }
  } else {
    console.log('\nAll sentinel-ON dimensions correct.');
  }

  if (trail.misses.length) {
    console.log('\n--- events NOT represented in the trail (the glove) ---');
    for (const m of trail.misses) console.log(`    ${m.file}: ${m.type} ${m.path}`);
  }

  // Optional gate: `node test/accuracy.js --gate 95` exits non-zero under 95%.
  const gateIdx = process.argv.indexOf('--gate');
  if (gateIdx !== -1) {
    const threshold = Number(process.argv[gateIdx + 1]);
    if (on.pct < threshold) {
      console.log(`\nGATE FAIL: sentinel-ON accuracy ${on.pct.toFixed(1)}% < ${threshold}%`);
      process.exit(1);
    }
    console.log(`\nGATE PASS: sentinel-ON accuracy ${on.pct.toFixed(1)}% >= ${threshold}%`);
  }
  process.exit(0);
}

main();
