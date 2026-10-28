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
 * A blocking Stop hook can pin an agent: blocked, responds, blocked again. The
 * host does NOT tell a hook that it is re-firing because of its own previous
 * block, so the protection has to be orunmila's own. Every block is counted
 * against a per-turn budget; once spent, findings degrade to advice and the
 * exhaustion is RECORDED. A gate that gives up silently is worse than no gate,
 * because it looks like a pass.
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
const { dataDir, readTurn } = require('../store/eventlog');
const { loadLaws, activeLaws } = require('./load');
const { evaluateTurn } = require('./evaluate');

const DEFAULT_BLOCK_BUDGET = 2;

/** Where the per-turn block counter lives. Orunmila's own state — see the loop-trap note. */
function statePath(sessionId, turnId) {
  const dir = path.join(dataDir(), 'laws-state', String(sessionId || 'unknown'));
  fs.mkdirSync(dir, { recursive: true });
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
 * A short, stable fingerprint of a turn's claim text.
 *
 * Why this exists (P0-4). runGate takes its claim from
 * lastAssistantText(transcript_path). When Stop fires before the host has
 * flushed THIS turn's final assistant message, that call returns the PREVIOUS
 * turn's message, and the gate then judges text the agent did not write in the
 * turn being judged. Measured in a real session: two consecutive turns captured
 * byte-identical claim text, and the gate re-flagged a sentence the agent had
 * already retracted.
 *
 * That lands on the blocking path, which is the worst place for it: an agent
 * that withdraws an unbacked claim gets blocked again on the stale text, the
 * per-turn block budget is spent on a phantom, and the gate then stands down
 * for the rest of the turn — so a stale finding can silence a real one.
 */
function claimFingerprint(text) {
  return require('crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** 't11' -> 't10'. Null for the first turn, or an id we don't recognise. */
function previousTurnId(turnId) {
  const m = /^t(\d+)$/.exec(String(turnId || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 1 ? `t${n - 1}` : null;
}

function blockBudget() {
  const raw = parseInt(process.env.ORUNMILA_LAW_BLOCK_BUDGET || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_BLOCK_BUDGET;
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
function decideForTurn({ sessionId, turnId, claimText, promptText, turnEvents, root }) {
  const { laws } = loadLaws({ root });
  const active = activeLaws(laws);
  if (!active.length) return null;

  const res = evaluateTurn({ claimText, promptText, turnEvents, laws: active });
  if (!res.findings.length) return null;

  const state = readState(sessionId, turnId);
  const budget = blockBudget();

  if (res.blocking.length && state.blocks < budget) {
    writeState(sessionId, turnId, Object.assign({}, state, {
      blocks: state.blocks + 1,
      law_ids: (state.law_ids || []).concat(res.blocking.map((f) => f.law_id)),
    }));
    return {
      decision: 'block',
      reason: renderFindings(res.blocking, { blocking: true }),
    };
  }

  // Either nothing blocking, or the budget is spent. If it IS spent, say so out
  // loud in the advisory rather than letting a silenced law read as a pass.
  const exhausted = res.blocking.length > 0 && state.blocks >= budget;
  let text = renderFindings(res.findings, { blocking: false });
  if (exhausted) {
    text =
      `orunmila — the law gate has already stopped this turn ${state.blocks} time(s) and is standing down to avoid trapping you. ` +
      `The finding below is UNRESOLVED, not forgiven; it will be visible at close-out.\n\n` +
      text;
  }
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } };
}

/**
 * The Stop-hook entry point. Reads a payload, writes at most one JSON object to
 * stdout, and always exits 0 — a non-zero exit from THIS script would itself
 * block the agent, which is the one thing it must never do by accident.
 */
function runGate(payload, adapter, { root, transcript } = {}) {
  try {
    if (String(process.env.ORUNMILA_LAWS || '').toLowerCase() === 'off') return null;

    const sessionId = adapter.fields.sessionId(payload);
    const { turnId } = require('../capture/turnstate');
    const turn = turnId(sessionId);

    const reader = transcript || adapter.transcript || require('../capture/transcript');
    const claimText =
      payload.claim || payload.response || reader.lastAssistantText(adapter.fields.transcriptPath(payload)) || '';
    if (!String(claimText).trim()) return null;

    // P0-4: refuse to judge a claim we have already judged under the previous
    // turn. Byte-identical consecutive claims mean the transcript had not yet
    // caught up when Stop fired — the agent has not said anything new, so there
    // is nothing honest to judge. Judging it anyway re-flags findings that were
    // already acted on.
    //
    // This declines to act on absent data; it does not silence a finding. The
    // skip is recorded in the turn's state so `laws --check` and any firing-rate
    // measurement can see it rather than counting the same claim twice.
    const fingerprint = claimFingerprint(claimText);
    const prevTurn = previousTurnId(turn);
    if (prevTurn) {
      const prevState = readState(sessionId, prevTurn);
      if (prevState && prevState.claim_fp && prevState.claim_fp === fingerprint) {
        const own = readState(sessionId, turn);
        writeState(sessionId, turn, Object.assign({}, own, {
          claim_fp: fingerprint,
          skipped_stale_claim: true,
        }));
        return null;
      }
    }
    writeState(sessionId, turn, Object.assign({}, readState(sessionId, turn), { claim_fp: fingerprint }));

    const turnEvents = readTurn(sessionId, turn);
    const promptEvent = turnEvents.find((e) => e.type === 'user_prompt');

    return decideForTurn({
      sessionId,
      turnId: turn,
      claimText: String(claimText),
      promptText: promptEvent ? String(promptEvent.text || '') : '',
      turnEvents,
      root: root || process.cwd(),
    });
  } catch {
    // A broken law engine may stop enforcing. It may never stop the agent.
    return null;
  }
}

module.exports = { runGate, decideForTurn, renderFindings, statePath, blockBudget, DEFAULT_BLOCK_BUDGET };