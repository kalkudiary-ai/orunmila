'use strict';

/**
 * Measures the law layer against every captured session in ~/.orunmila.
 *
 * A law earns its severity by precision on real data, never by how important the
 * rule sounds. That measurement was originally done with one-off scripts that
 * were thrown away, which left the severities in canon.json unre-checkable and
 * let a wrong causal note sit in the pack for a day. This script exists so the
 * numbers are a command rather than an afternoon.
 *
 * It reports, over all claimed turns:
 *   - the firing rate of each law (turns, not findings — the two differ a lot)
 *   - each law's share of total findings
 *   - for no-claim-without-receipt, what evidence the firing turns actually held
 *
 * That last table is the one that matters for the receipt law. A turn that fired
 * while holding no tool call and no command cannot be explained by any gap in
 * what capture records about tools — the cause is elsewhere.
 *
 * Run: node scripts/measure-laws.js [--root DIR] [--json]
 */

const path = require('path');
const { loadLaws, activeLaws } = require('../src/laws/load');
const { evaluateTurn } = require('../src/laws/evaluate');
const { readAll, groupByTurn, TYPES } = require('../src/store/eventlog');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Layer 5 is root-relative, so the numbers are only meaningful against the repo
// whose laws you mean to measure. Default to the caller's cwd, same as the CLI.
const root = path.resolve(flag('root', process.cwd()));
const { laws } = loadLaws({ root });
const active = activeLaws(laws);

const events = readAll().filter((e) => e.turn_id && e.session_id);
const bySession = new Map();
for (const e of events) {
  if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
  bySession.get(e.session_id).push(e);
}

const stats = {
  sessions: 0,
  claimed_turns: 0,
  flagged_turns: 0,
  blocking_turns: 0,
  findings: 0,
  by_law: {},          // law_id -> { turns, findings }
  receipt_law: { turns: 0, tool_call: 0, command_only: 0, neither: 0 },
};

function bump(lawId, firedTurn) {
  if (!stats.by_law[lawId]) stats.by_law[lawId] = { turns: 0, findings: 0 };
  stats.by_law[lawId].findings += 1;
  if (firedTurn) stats.by_law[lawId].turns += 1;
}

for (const [, sessionEvents] of bySession) {
  stats.sessions += 1;
  for (const [, turnEvents] of groupByTurn(sessionEvents)) {
    const claim = turnEvents.find((e) => e.type === TYPES.TURN_CLAIM);
    const prompt = turnEvents.find((e) => e.type === TYPES.USER_PROMPT);
    if (!claim || !claim.text || !String(claim.text).trim()) continue;
    stats.claimed_turns += 1;

    const res = evaluateTurn({
      claimText: String(claim.text),
      promptText: prompt && prompt.text ? String(prompt.text) : '',
      turnEvents,
      laws: active,
    });
    if (!res.findings.length) continue;
    stats.flagged_turns += 1;
    if (res.blocking.length) stats.blocking_turns += 1;
    stats.findings += res.findings.length;

    const seen = new Set();
    for (const f of res.findings) {
      bump(f.law_id, !seen.has(f.law_id));
      seen.add(f.law_id);
    }

    // What did a receipt-law turn actually have to go on? A tool call means the
    // agent queried something whose result is off-log; a command means the
    // evidence was captured and simply did not name the claim's target.
    if (seen.has('no-claim-without-receipt')) {
      const hasTool = turnEvents.some((e) => e.type === TYPES.TOOL_CALL);
      const hasCmd = turnEvents.some((e) => e.type === TYPES.COMMAND_RUN);
      stats.receipt_law.turns += 1;
      if (hasTool) stats.receipt_law.tool_call += 1;
      else if (hasCmd) stats.receipt_law.command_only += 1;
      else stats.receipt_law.neither += 1;
    }
  }
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  return;
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');

console.log(`Laws measured: ${active.length} in force, root ${root}`);
console.log(`Corpus: ${stats.sessions} session(s), ${stats.claimed_turns} claimed turn(s)\n`);
console.log(`${stats.flagged_turns} turn(s) raised a finding (${pct(stats.flagged_turns, stats.claimed_turns)}), ${stats.blocking_turns} would block.\n`);

console.log('law                                 turns   fire rate   findings   share');
const rows = Object.entries(stats.by_law).sort((a, b) => b[1].findings - a[1].findings);
for (const [id, v] of rows) {
  console.log(
    `  ${id.padEnd(34)}${String(v.turns).padStart(4)}   ${pct(v.turns, stats.claimed_turns).padStart(8)}   ${String(v.findings).padStart(7)}   ${pct(v.findings, stats.findings).padStart(6)}`
  );
}

const r = stats.receipt_law;
if (r.turns) {
  console.log('\nno-claim-without-receipt — what the firing turns actually held:');
  console.log(`  had an MCP/generic tool_call      ${String(r.tool_call).padStart(4)}   ${pct(r.tool_call, r.turns)}`);
  console.log(`  had only a command_run            ${String(r.command_only).padStart(4)}   ${pct(r.command_only, r.turns)}`);
  console.log(`  had neither                       ${String(r.neither).padStart(4)}   ${pct(r.neither, r.turns)}`);
  console.log('\nOnly the first row could be moved by capturing more about tool results.');
}