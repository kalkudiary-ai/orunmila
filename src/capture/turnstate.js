'use strict';

/**
 * turnstate.js — per-session turn counter (agent-agnostic).
 *
 * Most agents' hooks don't hand you a ready-made "turn id" — a turn is really
 * "one user message followed by however many tool calls followed by one stop".
 * We track it ourselves, keyed by session, stored under the orunmila cache, so
 * it works identically across Claude Code, Cursor, Codex, etc.
 *
 * THE BOUNDARY BUG THIS FIXES (measured 2026-08-10, 195 sessions / 1183 turns).
 * The counter used to advance ONLY in the prompt phase, and Stop never touched
 * it. Two failures followed, and both corrupt the ground truth the whole tool
 * rests on:
 *
 *   1. A Stop with no prompt before it — a user message arriving mid-turn, an
 *      auto-continuation — folded the next response into the SAME turn_id.
 *      39.1% of claimed turns carried more than one claim. The evaluator reads
 *      the FIRST claim in a turn, so the later response was judged against the
 *      earlier one's evidence and its own text was never judged at all.
 *   2. A prompt arriving between the work and the text describing it advanced
 *      the counter mid-flight, stranding the claim in a turn holding none of
 *      its evidence. 16.0% of claimed turns held a claim with zero evidence
 *      events, and a receipt is structurally impossible in those.
 *
 * The fix is LAZY ADVANCE, not a bump on Stop. Stop marks the turn CLOSED;
 * the counter moves on the next WRITE. That ordering matters: several Stop
 * hooks run in sequence (capture, then the law gate), and a hook that read the
 * counter after an eager bump would be handed a brand-new empty turn and would
 * silently judge nothing. Closing instead of bumping keeps every reader in the
 * Stop cascade pointed at the turn that just ended.
 *
 * A prompt no longer force-bumps either; it advances only if the turn is
 * closed. So a mid-turn message joins the turn already in flight rather than
 * splitting the claim away from the work that earned it.
 *
 * Set ORUNMILA_TURN_BOUNDARIES=legacy to restore the old behaviour.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../store/eventlog');

function legacy() {
  return String(process.env.ORUNMILA_TURN_BOUNDARIES || '').toLowerCase() === 'legacy';
}

function statePath(sessionId) {
  const dir = path.join(dataDir(), 'cache', sessionId || 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'turn.json');
}

function readState(sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return { turn: raw.turn || 1, closed: raw.closed === true };
  } catch {
    return { turn: 1, closed: false };
  }
}

function writeState(sessionId, state) {
  try {
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    /* capture must never block the agent over its own bookkeeping */
  }
  return state;
}

function currentTurn(sessionId) {
  return readState(sessionId).turn;
}

/** The id a READER should use: the turn in flight, or the one that just closed. */
function turnId(sessionId) {
  return `t${currentTurn(sessionId)}`;
}

/**
 * The id a WRITER should use. If the previous turn was closed by a stop, this
 * is where the new turn actually begins — on first evidence, not on a prompt
 * that may never come.
 */
function advanceIfClosed(sessionId) {
  const state = readState(sessionId);
  if (!state.closed) return state.turn;
  return writeState(sessionId, { turn: state.turn + 1, closed: false }).turn;
}

function writeTurnId(sessionId) {
  if (legacy()) return turnId(sessionId);
  return `t${advanceIfClosed(sessionId)}`;
}

/** Stop phase: the turn is over. Do NOT advance here — see the header. */
function closeTurn(sessionId) {
  if (legacy()) return currentTurn(sessionId);
  const state = readState(sessionId);
  return writeState(sessionId, { turn: state.turn, closed: true }).turn;
}

/**
 * Prompt phase. Under legacy this force-bumps. Under the fixed boundaries a
 * prompt only opens a new turn when the last one actually ended, so a message
 * sent mid-turn stays with the work it interrupted.
 */
function bumpTurn(sessionId) {
  if (legacy()) {
    const next = currentTurn(sessionId) + 1;
    return writeState(sessionId, { turn: next, closed: false }).turn;
  }
  return advanceIfClosed(sessionId);
}

module.exports = { currentTurn, bumpTurn, turnId, writeTurnId, closeTurn, advanceIfClosed };