'use strict';

/**
 * gate.js — the law layer at RUN TIME.
 *
 * Everything else in src/laws/ reads history. This is the part that speaks
 * while the agent is still working, on the Stop hook, before a turn is allowed
 * to end. It is orunmila's first and only path that can refuse anything, and it
 * is deliberately built OUTSIDE src/capture/, which remains observe-only and
 * exits zero forever. Nothing here changes what the capture layer does.
 *
 * ── What it emits ──────────────────────────────────────────────────────────
 *
 * Claude Code's Stop hook reads JSON on stdout:
 *
 *   { decision: 'block', reason }                     refuse the turn; the agent
 *                                                     must keep working and fix it
 *   { hookSpecificOutput: { additionalContext } }     hand the agent a note it can
 *                                                     act on, without stopping it
 *
 * Almost everything here takes the SECOND form, and that is the central design
 * decision, made on measurement rather than taste. Only one law —
 * verification_without_command — has proved precise enough to be worth stopping
 * a turn over. The rest are useful as a nudge and unusable as a wall: a false
 * advisory costs the agent a sentence of attention, while a false block costs
 * the whole session, and the agent that learns the gate is usually wrong learns
 * to route around it.
 *
 * Re-measured 2026-10-28 with scripts/measure-laws.js from this repo's root,
 * over 111 sessions / 796 claimed turns (784 distinct; 12 exact-duplicate
 * rows): verification_without_command fires on 13 turns — 1.6% of claimed
 * turns — and of its 14 findings, 12 are genuine. The two that are not are
 * both bare-`tested` matches ("SIDE_NOT_MINE — tested first, wins any
 * overlap"), the false-positive family assert-extractor.js documents. Across
 * the whole canon the evidentiary laws touch 414 of 796 turns, which is why
 * only this one blocks.
 *
 * An earlier version of this note quoted "18% of claimed turns" and "8 firings
 * in 1,174 turns, every one genuine", measured over a different corpus (194
 * sessions, from the kalku root). Those figures are no longer quoted. The
 * corpora differ, so the new numbers do not refute the old ones directly — but
 * the old PRECISION claim cannot stand in any case, because until 2026-10-28
 * the receipt side of this very law was broken (P0-5): buildReceipts accepted
 * only `undefined` as "exit code not observed" while the capture layer writes
 * `null`, so 98.4% of every command ever captured was filed as a FAILURE. The
 * law was judging against a receipt set that was almost entirely wrong, and
 * its narrow recall (P0-3) was the only thing keeping the firing count low.
 *
 * ── The loop trap ──────────────────────────────────────────────────────────
 *
 * A blocking Stop hook can pin an agent: blocked, responds, blocked again.
 * Claude Code sends `stop_hook_active` in a Stop payload, but the gate does not
 * rely on it: the protection is orunmila's own. Every block is counted
 * against a budget per USER PROMPT; once spent, findings degrade to advice and
 * the exhaustion is RECORDED. A gate that gives up silently is worse than no
 * gate, because it looks like a pass.
 *
 * Per prompt, not per turn: each re-fire after a block opens a turn of its own
 * (capture/turnstate.js), so a per-turn budget restarted on every Stop and the
 * trap stayed open. Before a session's first counted message all blocks share
 * one budget ('p0'); only a session with no turn record falls back to the turn.
 *
 * ── Failure posture ────────────────────────────────────────────────────────
 *
 * This runs on every turn of every session. It must never hang, never throw and
 * never lose the user their work. Any error at all exits 0 silently: a broken
 * law engine is allowed to stop enforcing, and never allowed to stop the agent.
 * ORUNMILA_LAWS=off disables it outright.
 */

const fs = require('fs');
const path = require('path');
const { dataDir, readTurn, readBetween } = require('../store/eventlog');
const { loadLaws, activeLaws } = require('./load');
const { evaluateTurn } = require('./evaluate');
const { factsLine } = require('./facts');

const DEFAULT_BLOCK_BUDGET = 2;
const FACTS_HEAD = 'orunmila facts (from the records, not your prose): ';

/** Where the per-turn block counter lives. Orunmila's own state — see the loop-trap note. */
function statePath(sessionId, turnId) {
  const dir = path.join(dataDir(), 'laws-state', String(sessionId || 'unknown'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${turnId || 't0'}.json`);
}

function readState(sessionId, turnId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId, turnId), 'utf8'));
  } catch {
    return { blocks: 0, law_ids: [] };
  }
}

function writeState(sessionId, turnId, state) {
  try {
    fs.writeFileSync(statePath(sessionId, turnId), JSON.stringify(state));
  } catch {
    /* the counter is best-effort; losing it must never break the turn */
  }
}

/**
 * A short, stable fingerprint of a turn's claim text, kept in the turn's record
 * as the mark that the gate judged that turn (liveGateCounts counts it).
 *
 * It once also drove the P0-4 repeat skip: a claim byte-identical to the
 * previous turn's was not judged, because with the claim read from the
 * transcript that meant the transcript had not caught up. The claim now comes
 * from the Stop payload (N10), so a repeat is a real restatement and is judged
 * like any claim; the block budget is what stops a loop (O, 2026-11-13).
 */
function claimFingerprint(text) {
  return require('crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * What the live gate did in one session, read from its own per-turn records:
 * turns it judged, turns it declined to judge, and turns it blocked. `laws
 * --check` replays the laws over the log and cannot see a skip; this is the
 * record of what actually ran, so skips are counted rather than silent.
 * `recorded` is false when the gate left no record for the session at all.
 */
function liveGateCounts(sessionId) {
  const counts = { recorded: false, checked: 0, skipped: 0, skipped_unconfirmed: 0, skipped_repeat: 0, blocked: 0, unreadable: 0 };
  const dir = path.join(dataDir(), 'laws-state', String(sessionId || 'unknown'));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return counts;
  }
  counts.recorded = true;
  // Turn records only: tN.json. The pN.json files are the per-prompt budget.
  for (const name of names.filter((n) => /^t\d+\.json$/.test(n))) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      counts.unreadable++;
      continue;
    }
    if (s.skipped_unconfirmed_claim || s.skipped_stale_claim) {
      counts.skipped++;
      if (s.skipped_unconfirmed_claim) counts.skipped_unconfirmed++;
      else counts.skipped_repeat++;
    } else if (s.claim_fp) {
      counts.checked++;
      if (s.blocks > 0) counts.blocked++;
    }
  }
  return counts;
}

function blockBudget() {
  const raw = parseInt(process.env.ORUNMILA_LAW_BLOCK_BUDGET || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_BLOCK_BUDGET;
}

/**
 * The facts line is opt-in: ORUNMILA_FACTS_LINE=1 and nothing else. Off, the
 * gate prints exactly what it printed before the facts line existed.
 */
function factsLineEnabled() {
  return process.env.ORUNMILA_FACTS_LINE === '1';
}

/**
 * The Sentinel's writes since the turn's first Glove event, for the facts
 * line. The Sentinel knows no sessions or turns, so a write belongs to the turn
 * by time, as in the reconciler; its window here runs to now, because the gate
 * runs at the turn's end. Null when the turn has no Glove event to start the
 * window from, or the read fails: the line then says the Sentinel was not
 * read, rather than that it saw nothing.
 */
function sentinelWritesSince(turnEvents) {
  try {
    const stamps = turnEvents.map((e) => e.ts).filter(Boolean).sort();
    if (!stamps.length) return null;
    return readBetween(stamps[0], null).filter((e) => e.source === 'fs-sentinel' && e.type === 'file_write');
  } catch {
    return null;
  }
}

/** Render findings as the text the agent actually reads. Terse: it costs context. */
function renderFindings(findings, { blocking }) {
  const lines = [];
  lines.push(
    blocking
      ? 'orunmila — a law you are held to was broken by this turn:'
      : 'orunmila — law findings on this turn (advisory; heuristic, they read your prose, not the facts):'
  );
  for (const f of findings) {
    lines.push('');
    lines.push(`• [${f.law_id}] ${f.message}`);
    if (f.evidence && f.evidence.text) {
      lines.push(`  the sentence: "${String(f.evidence.text).replace(/\s+/g, ' ').slice(0, 220)}"`);
    }
    const ev = f.evidence || {};
    if (ev.pattern_matched_targets && ev.pattern_matched_targets.length) {
      lines.push(`  only pattern-matched, never read: ${ev.pattern_matched_targets.join(', ')}`);
    }
    if (ev.unreceipted_targets && ev.unreceipted_targets.length) {
      lines.push(`  no receipt in this turn for: ${ev.unreceipted_targets.join(', ')}`);
    }
    if (ev.exit_code_laundered_by_pipe && ev.exit_code_laundered_by_pipe.length) {
      lines.push(`  exit code laundered by a pipe (reports the LAST stage only): ${ev.exit_code_laundered_by_pipe[0]}`);
      lines.push('  re-run it without the pipe, or with `set -o pipefail`, so the exit code means something.');
    }
    if (ev.failed_commands && ev.failed_commands.length) {
      lines.push(`  commands that did not exit zero: ${ev.failed_commands.slice(0, 3).join(' | ')}`);
    }
    if (f.remedy) lines.push(`  → ${f.remedy}`);
  }
  if (blocking) {
    lines.push('');
    lines.push('Do the work the law asks for, then answer again. Do not restate the claim unchanged.');
  }
  return lines.join('\n');
}

/**
 * Decide what the Stop hook should emit for one turn.
 *
 * Pure apart from the block counter, so it can be tested without a hook. Returns
 * null when there is nothing to say — the overwhelmingly common case, and the
 * one that must cost nothing.
 */
function decideForTurn({ sessionId, turnId, promptId, claimText, promptText, turnEvents, sentinelWrites = [], root }) {
  // With the switch on, the facts line comes first, ahead of any finding, and
  // stands alone on a turn with none. Everything after it is unchanged, and a
  // fault in the facts line drops the line, never a finding.
  let facts = null;
  try {
    if (factsLineEnabled()) facts = FACTS_HEAD + factsLine(turnEvents, { root, sentinelWrites });
  } catch {
    facts = null;
  }
  const withFacts = (text) => (facts ? `${facts}\n\n${text}` : text);
  const factsOnly = facts ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: facts } } : null;

  const { laws } = loadLaws({ root });
  const active = activeLaws(laws);
  if (!active.length) return factsOnly;

  const res = evaluateTurn({ claimText, promptText, turnEvents, laws: active });
  if (!res.findings.length) return factsOnly;

  const state = readState(sessionId, turnId);
  const budget = blockBudget();
  // The budget is spent per prompt (see the loop-trap note); the turn's own
  // file still records the blocks made in that turn.
  const spent = promptId ? readState(sessionId, promptId).blocks : state.blocks;

  if (res.blocking.length && spent < budget) {
    writeState(sessionId, turnId, Object.assign({}, state, {
      blocks: state.blocks + 1,
      law_ids: (state.law_ids || []).concat(res.blocking.map((f) => f.law_id)),
    }));
    if (promptId) writeState(sessionId, promptId, { blocks: spent + 1 });
    return {
      decision: 'block',
      reason: withFacts(renderFindings(res.blocking, { blocking: true })),
    };
  }

  // Either nothing blocking, or the budget is spent. If it IS spent, say so out
  // loud in the advisory rather than letting a silenced law read as a pass.
  const exhausted = res.blocking.length > 0 && spent >= budget;
  let text = renderFindings(res.findings, { blocking: false });
  if (exhausted) {
    text =
      `orunmila — the law gate has already stopped this turn ${spent} time(s) and is standing down to avoid trapping you. ` +
      `The finding below is UNRESOLVED, not forgiven; it will be visible at close-out.\n\n` +
      text;
  }
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: withFacts(text) } };
}

/**
 * The Stop-hook entry point. Reads a payload, writes at most one JSON object to
 * stdout, and always exits 0 — a non-zero exit from THIS script would itself
 * block the agent, which is the one thing it must never do by accident.
 */
function runGate(payload, adapter, { root } = {}) {
  try {
    if (String(process.env.ORUNMILA_LAWS || '').toLowerCase() === 'off') return null;

    const sessionId = adapter.fields.sessionId(payload);
    const { turnId, promptId } = require('../capture/turnstate');
    const turn = turnId(sessionId);

    // N10: the transcript is never read here. When Stop fires it can still end
    // on an earlier block of this turn, so its text cannot be confirmed as the
    // turn's own. With no string value in any of the payload's final-text
    // fields the gate judges nothing and records the skip (an empty final
    // message is not judged either, and not recorded): a missed check is
    // visible, a wrong block is harmful.
    const claimText = adapter.fields.finalText(payload);
    if (claimText === null) {
      writeState(sessionId, turn, Object.assign({}, readState(sessionId, turn), { skipped_unconfirmed_claim: true }));
      return null;
    }
    if (!claimText.trim()) return null;

    writeState(sessionId, turn, Object.assign({}, readState(sessionId, turn), { claim_fp: claimFingerprint(claimText) }));

    const turnEvents = readTurn(sessionId, turn);
    const promptEvent = turnEvents.find((e) => e.type === 'user_prompt');

    return decideForTurn({
      sessionId,
      turnId: turn,
      promptId: promptId(sessionId),
      claimText: String(claimText),
      promptText: promptEvent ? String(promptEvent.text || '') : '',
      turnEvents,
      sentinelWrites: factsLineEnabled() ? sentinelWritesSince(turnEvents) : [],
      root: root || process.cwd(),
    });
  } catch {
    // A broken law engine may stop enforcing. It may never stop the agent.
    return null;
  }
}

module.exports = { runGate, decideForTurn, renderFindings, statePath, liveGateCounts, blockBudget, factsLineEnabled, DEFAULT_BLOCK_BUDGET };