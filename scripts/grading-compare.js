// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/grading-compare.js — R56 (Phase 7; brief v4 line 823, test 56): `no-grep-as-basis` takes its receipts from
 * the intake's marks (ORUNMILA_GATE_FROM_MARKS=1, slice B9); on recorded sessions its results may differ from today's
 * (the event log's) only where open question 3's approved grading says so: a failed read is no receipt (NF26), a failed
 * edit is none (NF69), a folder listing is weak (LD121), a ranged read is graded by its own extent (LD94), and a search
 * targets the folder it searched, not its pattern text. Any other difference is named unexplained.
 *
 *   node scripts/grading-compare.js [--home <dir>]      every claimed turn of every session log under <home>/sessions,
 *       matched to the event log's turn of the same session with the same claim text; prints counts only (no claim,
 *       path or value), exit 0 when every difference is explained
 *   compareTurn({ claimText, promptText?, events, marks }) -> { same, today, marks, reasons, explained }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateTurn, buildReceipts, receiptStrength } = require('../src/laws/evaluate');
const { loadLaws } = require('../src/laws/load');
const { buildReceiptsFromMarks } = require('../src/opon/gate/receipts');
const { promptsOf } = require('../src/opon/gate/prompts');

const LAW = 'no-grep-as-basis';
const law = () => loadLaws({ root: os.tmpdir() }).laws.filter((l) => l.id === LAW);

/** The turn's commands from its marks, as the gate reads them (src/laws/gate.js, B9). */
const commandsOf = (marks) =>
  marks
    .filter((m) => m.source === 'hook' && m.says === 'exited' && m.target && m.target.kind === 'command')
    .map((m) => ({ type: 'command_run', command: String(m.target.text || ''), exit_code: Number.isInteger(m.detail && m.detail.exit_code) ? m.detail.exit_code : null, failed: (m.detail || {}).exit_status === 'fail', stdout_excerpt: String((m.detail || {}).output_excerpt || '') }));

const keyOf = (fs_) => fs_.map((f) => JSON.stringify([f.evidence.text, (f.evidence.pattern_matched_targets || []).slice().sort()])).sort();

/**
 * Why a target's receipt differs, `today` (the event log's grade) against `fromMarks`, read in that direction from what
 * the marks hold for it: the approved grading's reason, or null when the grading does not explain it (a read one side
 * has and the other lacks is a capture difference, not a grading one).
 */
function reasonFor(target, marks, today, fromMarks) {
  const name = String(target.raw || target.value || '').replace(/^\.\//, '');
  const about = marks.filter((m) => m.source === 'hook' && m.target && typeof m.target.path === 'string' && (m.target.path === name || m.target.path.endsWith('/' + name) || name.startsWith(m.target.path.replace(/\/$/, '') + '/') || m.target.path === '.'));
  const tool = (m) => String((m.detail && m.detail.tool) || '');
  const kind = (k) => about.some((m) => m.says === 'read' && m.detail && m.detail.read_kind === k);
  const failed = (re) => about.some((m) => m.says === 'ended' && m.target.kind === 'file' && re.test(tool(m)));
  const READS = /^(read|read_file|view_file|open_file|fsRead|readFile)$/i;
  if (today === 'full') {
    // The full receipt is gone in the marks (to none, or to the weak one another read leaves).
    if (failed(READS)) return 'NF26: a failed read is no receipt';
    if (failed(/^(?!(read|read_file|view_file|open_file|fsRead|readFile)$)/i)) return 'NF69: a failed edit is no receipt';
    if (fromMarks === 'none') return null;
    if (kind('listing')) return 'LD121: a folder listing is a weak receipt';
    if (kind('range')) return 'LD94: a ranged read is graded by its own extent';
    return null;
  }
  if (today !== 'full' && fromMarks !== 'full' && kind('pattern')) return 'open question 3: a search targets the folder it searched';
  return null;
}

function compareTurn({ claimText, promptText = '', events, marks }) {
  const laws = law();
  const today = evaluateTurn({ claimText, promptText, turnEvents: events, laws }).findings;
  const fromMarks = evaluateTurn({ claimText, promptText, turnEvents: commandsOf(marks), laws, receipts: buildReceiptsFromMarks(marks) }).findings;
  const same = keyOf(today).join('\n') === keyOf(fromMarks).join('\n');
  if (same) return { same, today: today.length, marks: fromMarks.length, reasons: [], explained: true };
  const rToday = buildReceipts(events);
  const rMarks = buildReceiptsFromMarks(marks);
  const { extractAssertions } = require('../src/laws/assert-extractor');
  const targets = extractAssertions(claimText).flatMap((a) => a.targets).filter((t) => t.kind === 'path');
  const reasons = new Set();
  let unexplained = 0;
  for (const t of targets) {
    const a = receiptStrength(t, rToday);
    const b = receiptStrength(t, rMarks);
    if (a === b) continue;
    const why = reasonFor(t, marks, a, b);
    if (why) reasons.add(why);
    else unexplained++;
  }
  if (!reasons.size && !unexplained) unexplained++; // the findings differ, yet no target's receipt does: not the grading
  return { same, today: today.length, marks: fromMarks.length, reasons: [...reasons].sort(), explained: unexplained === 0 };
}

function readJsonl(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a cut line is not a record */
    }
  }
  return out;
}

if (require.main === module) {
  const i = process.argv.indexOf('--home');
  const home = i > 0 ? process.argv[i + 1] : path.join(os.homedir(), '.orunmila');
  const bySession = new Map();
  for (const e of readJsonl(path.join(home, 'events.jsonl'))) {
    if (!e || typeof e.session_id !== 'string') continue;
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id).push(e);
  }
  const counts = { sessions: 0, claimed: 0, unmatched: 0, same: 0, differ: 0, explained: 0, unexplained: 0, firedToday: 0, firedMarks: 0, claimsWithPaths: 0 };
  const reasons = new Map();
  const sessions = path.join(home, 'sessions');
  for (const name of fs.existsSync(sessions) ? fs.readdirSync(sessions).sort() : []) {
    const recs = readJsonl(path.join(sessions, name, 'raw.jsonl'));
    const header = recs[0];
    if (!header || header.record !== 'session_header') continue;
    counts.sessions++;
    const events = bySession.get(header.session_id) || [];
    const glove = recs.slice(1).filter((m) => (m.source === 'hook' || m.source === 'agent_claim') && typeof m.turn === 'string');
    for (const turn of [...new Set(glove.map((m) => m.turn))]) {
      const own = glove.filter((m) => m.turn === turn);
      const claim = own.filter((m) => m.says === 'claimed').pop();
      if (!claim || !claim.detail || typeof claim.detail.text !== 'string' || !claim.detail.text.trim()) continue;
      counts.claimed++;
      const match = events.filter((e) => e.type === 'turn_claim' && e.text === claim.detail.text).pop();
      if (!match) {
        counts.unmatched++;
        continue;
      }
      const turnEvents = events.filter((e) => e.turn_id === match.turn_id);
      const prompt = promptsOf(own, turn).prompts.map((p) => p.text).join('\n');
      const r = compareTurn({ claimText: claim.detail.text, promptText: prompt, events: turnEvents, marks: own });
      if (r.today) counts.firedToday++;
      if (r.marks) counts.firedMarks++;
      if (require('../src/laws/assert-extractor').extractAssertions(claim.detail.text).some((a) => a.targets.some((t) => t.kind === 'path' && /[\\/]/.test(String(t.raw || ''))))) counts.claimsWithPaths++;
      if (r.same) counts.same++;
      else {
        counts.differ++;
        counts[r.explained ? 'explained' : 'unexplained']++;
        for (const why of r.reasons) reasons.set(why, (reasons.get(why) || 0) + 1);
      }
    }
  }
  console.log(`${counts.sessions} session logs; ${counts.claimed} claimed turns, ${counts.unmatched} with no event-log turn of the same claim`);
  console.log(`${counts.claimsWithPaths} claims name a path the law reads; it fired on ${counts.firedToday} turns from the event log and ${counts.firedMarks} from the marks`);
  console.log(`${LAW}: ${counts.same} the same, ${counts.differ} different (${counts.explained} explained by the approved grading, ${counts.unexplained} not)`);
  for (const [why, n] of [...reasons].sort()) console.log(`  ${n} ${why}`);
  process.exit(counts.unexplained ? 1 : 0);
}

module.exports = { compareTurn, reasonFor };
