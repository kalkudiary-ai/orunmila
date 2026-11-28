// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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
 * the counter moves on the next WRITE. That ordering matters: two Stop hooks
 * run (capture and the law gate), and a hook that read the counter after an
 * eager bump would be handed a brand-new empty turn and would silently judge
 * nothing. Closing instead of bumping keeps every reader in the Stop cascade
 * pointed at the turn that just ended. The host may run the two in either order
 * or at once, so the gate finds its turn with stopTurnId (NF62).
 *
 * A prompt no longer force-bumps either; it advances only if the turn is
 * closed. So a mid-turn message joins the turn already in flight rather than
 * splitting the claim away from the work that earned it.
 *
 * Set ORUNMILA_TURN_BOUNDARIES=legacy to restore the old behaviour.
 *
 * The state also counts user PROMPTS, separately from turns. A Stop that the
 * law gate blocked is followed by a re-fire with no prompt, and lazy advance
 * gives that re-fire a turn of its own, so the turn counter cannot tell "the
 * user spoke again" from "the agent answered again". The gate's block budget
 * needs exactly that distinction (laws/gate.js, the loop trap).
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../store/eventlog');

function legacy() {
  return String(process.env.ORUNMILA_TURN_BOUNDARIES || '').toLowerCase() === 'legacy';
}

function statePath(sessionId) {
  const dir = path.join(dataDir(), 'cache', sessionId || 'unknown');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'turn.json');
}

function readState(sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return { turn: raw.turn || 1, closed: raw.closed === true, prompt: raw.prompt || 0, stop: typeof raw.stop === 'string' ? raw.stop : null };
  } catch {
    return { turn: 1, closed: false, prompt: 0, stop: null };
  }
}

// Whole or not at all: the two Stop hooks can run at once (NF62), and a read
// during a plain write finds the file empty and falls back to turn 1 (NF63).
// So the state goes to a temp file first, then is renamed over turn.json.
function writeState(sessionId, state) {
  let tmp = null;
  try {
    const target = statePath(sessionId);
    tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    /* capture must never block the agent over its own bookkeeping */
    try {
      if (tmp) fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
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
 * 'p3' after the third user message of the session. Before the first one, 'p0'
 * if the session has a turn record at all, so a session whose first prompt was
 * written by the host, or that began before this count existed, shares one
 * budget rather than refilling it every turn. Null only with no turn record.
 */
function promptId(sessionId) {
  const n = readState(sessionId).prompt;
  if (n > 0) return `p${n}`;
  return fs.existsSync(statePath(sessionId)) ? 'p0' : null;
}

/**
 * The id a WRITER should use. If the previous turn was closed by a stop, this
 * is where the new turn actually begins — on first evidence, not on a prompt
 * that may never come.
 */
function advanceIfClosed(sessionId) {
  const state = readState(sessionId);
  if (!state.closed) return state.turn;
  return writeState(sessionId, { turn: state.turn + 1, closed: false, prompt: state.prompt }).turn;
}

function writeTurnId(sessionId) {
  if (legacy()) return turnId(sessionId);
  return `t${advanceIfClosed(sessionId)}`;
}

/**
 * Stop phase: the turn is over. Do NOT advance here — see the header. `stop` is
 * the closing Stop's stopKey, so the law gate can tell whether capture has run
 * for the Stop it is judging.
 */
function closeTurn(sessionId, { stop = null } = {}) {
  if (legacy()) return currentTurn(sessionId);
  const state = readState(sessionId);
  const next = { turn: state.turn, closed: true, prompt: state.prompt };
  if (stop) next.stop = stop;
  return writeState(sessionId, next).turn;
}

/**
 * A Stop's mark: a fingerprint of the final text its payload carries, or of
 * its absence. Both Stop hooks get the same payload, so both compute the same key.
 */
function stopKey(finalText) {
  const text = finalText === null || finalText === undefined ? '\u0000no final text' : String(finalText);
  return require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The id the LAW GATE should use, whichever Stop hook runs first (NF62). The
 * host may run them in parallel, and on a Stop with no prompt or tool call
 * before it the counter still points at the previous turn, closed, until
 * capture advances it. A turn in flight, or one this Stop already closed, is the
 * gate's turn; a turn an earlier Stop closed means the next one, where capture
 * puts this claim. When the gate runs first, two Stops in a row with
 * byte-identical text and nothing between them cannot be told apart, and it
 * then takes the earlier turn.
 */
function stopTurnId(sessionId, key) {
  if (legacy()) return turnId(sessionId);
  const state = readState(sessionId);
  if (!state.closed || state.stop === key) return `t${state.turn}`;
  return `t${state.turn + 1}`;
}

/**
 * Prompt phase. Under legacy this force-bumps. Under the fixed boundaries a
 * prompt only opens a new turn when the last one actually ended, so a message
 * sent mid-turn stays with the work it interrupted. Either way it is one more
 * prompt, unless the host wrote it (countPrompt false): a notification opens a
 * turn like any prompt but is not a message from the user (NF54).
 */
function bumpTurn(sessionId, { countPrompt = true } = {}) {
  const state = readState(sessionId);
  const turn = legacy() || state.closed ? state.turn + 1 : state.turn;
  return writeState(sessionId, { turn, closed: false, prompt: state.prompt + (countPrompt ? 1 : 0) }).turn;
}

/** CU1: whether the session's turn is not closed by a stop (true too before any turn record: tools alone write none). */
function isTurnOpen(sessionId) {
  return !readState(sessionId).closed;
}

module.exports = { currentTurn, bumpTurn, turnId, promptId, writeTurnId, closeTurn, advanceIfClosed, stopKey, stopTurnId, isTurnOpen };