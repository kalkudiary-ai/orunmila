// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/acceptance.js — R3 (Phase 7; brief v4 lines 740, 763): output 1's acceptance tests, each mapped to the
 * suite cases that show it, run twice, the two runs compared. "Output 1 is done when every test passes, or is
 * Deferred or Won't do in the Done ledger with O's written approval, and every automated test passes twice in a row
 * with identical output." The map lives here, not in a document, so a renamed or failing case fails the run (LD364).
 *
 * Each test is one of:
 *   auto     cases: [[suite, title prefix], ...]; every prefix must match at least one case of its suite, and every
 *            case it matches must pass. `unshown` (optional) names a part of the brief's scenario no case shows yet:
 *            the test then reads "passes, part not shown" and counts as not done. `record` (optional) is a run on
 *            O's machine the cases cannot hold (raw recordings never leave it), quoted beside the case count.
 *   manual   done by real use, once (brief line 763: 26, 41, 49); `record` is where its result is written
 *   deferred `approval` is O's written approval in the ledger
 *   open     `why`, and whose it is
 *
 *   node scripts/acceptance.js [--once] [--out <file>]    exit 0 only when every test is done and both runs agree
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const A = (...cases) => ({ kind: 'auto', cases });
const C = (suite, prefix) => [suite, prefix];

const MAP = {
  1: A(C('settle', 'test 1 (rule 4)'), C('attribute', 'A1 test 1:')),
  2: A(C('group', 'test 2:')),
  3: A(C('net', 'N2 test 3:'), C('judge', 'test 3:')),
  4: A(C('conflicts', 'C3d1 test 4 (replay half)'), C('opon-live', 'K7 tests 4 and 73 live'), C('closeout', 'K7 tests 4 and 73 (LD216)')),
  '4b': A(C('conflicts', 'C3c test 4b: "tests pass" with no test run'), C('conflicts', 'C3c test 4b: "tests pass" after the tests ran and failed')),
  5: A(C('conflicts', 'C3d2 test 5:'), C('attribute', 'A1 test 5 (attribution half)'), C('judge', 'tests 5, 44, 71, 32, 37')),
  6: A(C('attribute', 'A1 tests 6 and 67')),
  7: A(C('settle', 'test 7 (rule 2)')),
  8: A(C('settle', 'test 8 (rule 8)')),
  9: A(C('attribute', 'A1 test 9:'), C('judge', 'tests 9 and 70')),
  10: A(C('tamper', 'test 10:'), C('judge', 'tests 10, 30, 42, 52')),
  11: A(C('verify', 'test 11:')),
  12: A(C('crash', 'CR1 test 12'), C('report', 'tests 12, 18, 21 and 84')),
  13: A(C('replay', 'tests 13 and 34'), C('odu', 'O1: the same raw log replayed twice')),
  14: A(C('paths', 'test 14:'), C('intake-router', 'test 14:')),
  15: { kind: 'manual', record: "done: O, 2026-11-28 (F5): the best fit in the 3-month event log, session 69beb441, the original Phase 0 session (Orunmila's own code, both witnesses, its transcript kept), its events through the intake's path to 215 marks and 125 odù records (1.72 marks per odù), every odù checked by hand against its transcript: 3 wrong (a cp's creation unexplained, the v0 log has no command start; two claim conflicts from Phase 0's stale claims, N10), and 16 of 26 prompts the old Stop backfill (LD377)" },
  16: A(C('no-network', 'NI1 (LD264)'), C('judge', 'the judge is plain code')),
  17: A(C('tamper-log', 'TE1, TE4: the raw log appended'), C('tamper-log', 'TE1, TE4: the raw log edited'), C('tamper-log', 'TE1, TE4: the raw log deleted by')),
  18: A(C('crash', 'CR1 test 18'), C('report', 'tests 12, 18, 21 and 84')),
  19: A(C('judge', 'test 19:'), C('report', 'test 19 in the report')),
  20: A(C('judge', 'tests 20 and 67')),
  21: A(C('judge', 'tests 21, 32'), C('report', 'tests 12, 18, 21 and 84')),
  22: A(C('judge', 'test 22, guarantee 3')),
  23: { kind: 'deferred', approval: 'LD261: O, 2026-11-24, Q36 (c): the explainer deferred to output 3, with tests 23 and 36' },
  24: A(C('verify', 'an untouched session: "Record intact"'), C('verify-verdict', 'BB7 test 24'), C('verify-fresh', 'V2 test 24')),
  25: A(C('verify-verdict', 'BB7 test 25')),
  26: { kind: 'manual', record: 'done: O, 2026-11-28, session f9298e75: "this has been done already" (O\'s word; no result sheet: who ran it, the date, the minutes and where they hesitated are not recorded here) (LD384)' },
  27: A(C('spec', 'SP2 test 27')),
  28: A(C('session-log', 'test 28:'), C('intake-router', 'test 28, LD124'), C('report', 'test 28:')),
  29: A(C('verify-odu', 'V1 test 29'), C('verify-verdict', "BB7 test 29's form")),
  30: A(C('tamper', 'test 30:'), C('judge', 'tests 10, 30, 42, 52')),
  31: A(C('tamper-log', 'TE1, TE4: the raw log moved')),
  32: { ...A(C('judge', 'tests 21, 32'), C('judge', 'tests 5, 44, 71, 32, 37'), C('closeout', 'K2 line 450'), C('intake-sentinel', 'test 32')), unshown: "on by default: the Sentinel drops and names a flood only with ORUNMILA_SENTINEL_MAX_PENDING set, no limit until O's word (LD374); a drop inside the operating system is never reported to it, and only the closeout's rescan finds that change" },
  33: A(C('redact-intake', 'test 33:')),
  34: A(C('replay', 'tests 13 and 34')),
  35: A(C('replay', 'test 35:')),
  36: { kind: 'deferred', approval: 'LD261: O, 2026-11-24, Q36 (c): the explainer deferred to output 3, with tests 23 and 36' },
  37: A(C('attribute-overlap', 'A2 test 37')),
  38: A(C('attribute-overlap', 'C3d1 test 38')),
  39: A(C('conflicts', 'C3c test 39')),
  40: A(C('laws', 'test 40: in the N10 race'), C('laws', 'test 40: with no final text')),
  41: { kind: 'manual', record: 'done: 243 real turns checked, 0 skipped, 3 unrecorded (O, 2026-11-19, LD44)' },
  42: A(C('tamper', 'test 42:'), C('judge', 'tests 10, 30, 42, 52')),
  43: A(C('adapter-events-v0', 'test 43:'), C('adapter-claude-code', 'test 43:')),
  44: A(C('confidence', 'C1 test 44'), C('conflicts', 'C3a test 44')),
  45: A(C('retention', 'retire removes the whole session folder'), C('retention', 'retire leaves every other session intact')),
  46: A(C('report', 'test 46:')),
  47: A(C('compat-shapes', 'EU1 test 47'), C('trail-marks', 'test 47:')),
  48: A(C('intake-router', 'NF30:'), C('intake-sentinel', 'B4 (N2):')),
  49: { kind: 'manual', record: "real Cursor sessions with O (brief line 816): not yet run; until then Cursor is experimental in the support table" },
  50: { ...A(C('strip', 'relevance at the mark level'), C('strip', "F26: an exact-capture read's read_range"), C('relevance', 'R50 test 50'), C('relevance', 'R50: a planted difference')), record: "on O's machine, 2026-11-28, scripts/relevance.js: the one stripped fixture (c5426624, test/cases/compat/0.2.4) against its raw recording, rebuilt exactly: 149 odù records, 20 conflicts, 149 verdicts and 1 session verdict each, the same kinds; stated limit F29 (LD375)" },
  51: A(C('judge', 'test 51:'), C('report', 'line 692, test 51')),
  52: A(C('tamper', 'test 52:'), C('judge', 'tests 10, 30, 42, 52')),
  53: A(C('intake-engine', 'test 53: a session idle'), C('intake-engine', 'test 53: a busy session')),
  54: A(C('redact-intake', 'test 54:'), C('intake-router', 'test 54, mark side')),
  55: A(C('adapter-claude-code', 'test 55:'), C('intake-router', 'test 55:')),
  56: { ...A(C('adapter-claude-code', 'test 55:'), C('gate-from-marks', 'B9: commands from marks'), C('grading-compare', 'R56 test 56'), C('grading-compare', 'R56: the same evidence')), record: "on O's machine, 2026-11-28, scripts/grading-compare.js: 49 session logs, 360 claimed turns, each matched to its event-log turn: no-grep-as-basis the same both ways on all 360; it fired on none (56 claims name a path), so no recorded turn shows a grading difference, which the hand-built cases show (LD376)" },
  57: A(C('adapter-claude-code', 'test 57:')),
  58: A(C('redact-intake', 'test 58:')),
  59: A(C('adapter-claude-code', 'test 59, mark side'), C('trail', 'a sub-agent touch carries its attribution')),
  60: { ...A(C('adapter-events-v0', 'test 60, mark side'), C('adapter-claude-code', 'test 60:'), C('intake-router', 'test 60 at the router')), unshown: "on by default: the live path writes detail.vcs only with ORUNMILA_VCS_MARKS=1, off until O's word (LD372)" },
  61: A(C('adapter-law-gate', 'test 61:'), C('gate-marks', 'test 61:')),
  62: A(C('session-log', 'test 62, kept-whole half'), C('intake-router', 'test 62, mark side')),
  63: A(C('intake-router', 'test 63:')),
  64: A(C('trail-marks', 'test 64:')),
  65: A(C('verify', 'test 65:')),
  66: { ...A(C('laws', 'NF63:'), C('gate-from-marks', 'test 66:'), C('gate-from-marks', 'T66:')), unshown: "on by default: the gate sees a call still being written only in the intake's marks, with ORUNMILA_GATE_FROM_MARKS=1, off until O's word (LD373); the event log has no record of a command before it ends" },
  67: A(C('attribute', 'A1 tests 6 and 67'), C('confidence', 'C1 test 67'), C('judge', 'tests 20 and 67'), C('report', 'tests 67 and 74')),
  68: A(C('group', 'test 68:'), C('confidence', 'C1 test 68')),
  69: A(C('group', 'test 67 (group half)'), C('conflicts', 'C3a test 69')),
  70: A(C('group', 'test 70:'), C('judge', 'tests 9 and 70')),
  71: A(C('conflicts', 'C3b test 71'), C('judge', 'tests 5, 44, 71, 32, 37')),
  72: A(C('judge', 'test 72, line 679')),
  73: A(C('closeout', 'K7 tests 4 and 73 (LD216)'), C('judge', 'tests 38 and 73')),
  74: A(C('report', 'tests 67 and 74')),
  75: A(C('intake-router', 'test 63:'), C('prompts', 'test 75:'), C('gate-from-marks', 'test 75 (gate half)')),
  76: A(C('intake-router', 'test 76:'), C('prompts', 'test 76:')),
  77: A(C('prompts', 'test 77:')),
  78: A(C('receipts', 'test 78:'), C('gate-from-marks', 'test 78 (NF26)')),
  79: A(C('receipts', 'test 79:'), C('gate-from-marks', 'test 79 (NF69)')),
  80: A(C('receipts', 'test 80:'), C('gate-from-marks', 'test 80:')),
  81: A(C('receipts', 'test 81:'), C('gate-from-marks', 'test 81:')),
  82: A(C('intake-engine', 'test 82:'), C('intake-server', 'test 82 (over HTTP)')),
  83: A(C('intake-server', 'test 83 (socket form)'), C('intake-server', 'test 83 (TCP form)')),
  84: A(C('intake-engine', 'test 84:'), C('intake-router', 'test 84 at the router'), C('report', 'tests 12, 18, 21 and 84')),
  85: A(C('intake-send', 'test 85: with no intake running'), C('intake-send', 'test 85: a listener that never takes the line')),
};

// The brief's own numbering: 1 to 85, and 4b.
const IDS = ['1', '2', '3', '4', '4b', ...Array.from({ length: 81 }, (_, i) => String(i + 5))];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'); // a suite's colour codes
/** A suite's output as { title: 'PASS' | 'FAIL' } (a title seen twice keeps FAIL if either failed). */
function parse(out) {
  const res = {};
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(ANSI, '');
    const m = /^(PASS|FAIL) {2}(.*)$/.exec(l);
    if (m) res[m[2]] = res[m[2]] === 'FAIL' ? 'FAIL' : m[1];
  }
  return res;
}

/** One line per test, in the brief's order: { id, status, detail }. `outputs` is { suite: parsed results }. */
function judge(map, outputs) {
  return IDS.map((id) => {
    const t = map[id];
    if (!t) return { id, status: 'missing from the map', detail: '' };
    if (t.kind === 'deferred') return { id, status: 'deferred', detail: t.approval };
    if (t.kind === 'manual') return { id, status: t.record.startsWith('done') ? 'done (real use)' : 'not run (real use)', detail: t.record };
    if (t.kind === 'open') return { id, status: 'open', detail: t.why };
    const bad = [];
    let n = 0;
    for (const [suite, prefix] of t.cases) {
      const got = Object.entries(outputs[suite] || {}).filter(([title]) => title.startsWith(prefix));
      n += got.length;
      if (!got.length) bad.push(`no case of ${suite} starts "${prefix}"`);
      for (const [title, s] of got) if (s !== 'PASS') bad.push(`${suite}: FAIL ${title}`);
    }
    if (bad.length) return { id, status: 'FAIL', detail: bad.join('; ') };
    return t.unshown ? { id, status: 'passes, part not shown', detail: `${n} cases pass; not shown: ${t.unshown}` } : { id, status: 'passes', detail: `${n} cases${t.record ? `; ${t.record}` : ''}` };
  });
}

const DONE = new Set(['passes', 'deferred', 'done (real use)']);
const table = (rows) => ['| Test | Result | Detail |', '|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`)].join('\n');

function suitesOf(map) {
  return [...new Set(Object.values(map).flatMap((t) => (t.kind === 'auto' ? t.cases.map(([s]) => s) : [])))].sort();
}

function runOnce(map) {
  const outputs = {};
  for (const s of suitesOf(map)) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'test', `${s}.js`)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ORUNMILA_INTAKE_PORT: '0' } });
    outputs[s] = parse(r.stdout);
  }
  return judge(map, outputs);
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  const outAt = process.argv.indexOf('--out');
  const first = runOnce(MAP);
  const second = once ? first : runOnce(MAP);
  const same = table(first) === table(second);
  const done = first.filter((r) => DONE.has(r.status)).length;
  const lines = [
    `# Acceptance tests: ${done} of ${IDS.length} done${once ? ' (one run)' : `, two runs ${same ? 'identical' : 'DIFFERENT'}`}`,
    '',
    `Run ${new Date().toISOString()} on ${process.platform} with Node ${process.version}, by scripts/acceptance.js.`,
    '',
    table(first),
    '',
  ];
  if (!same) lines.push('## The second run', '', table(second), '');
  const text = lines.join('\n');
  if (outAt > 0) fs.writeFileSync(process.argv[outAt + 1], text);
  console.log(text);
  process.exit(done === IDS.length && same ? 0 : 1);
}

module.exports = { MAP, IDS, parse, judge, suitesOf, DONE };
