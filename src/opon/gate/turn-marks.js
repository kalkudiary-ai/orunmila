// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/gate/turn-marks.js — the turn the law gate judges, from the
 * intake's raw log of the session (slice B9, LD148), for src/laws/gate.js
 * with ORUNMILA_GATE_FROM_MARKS=1.
 *
 *   readSessionMarks(home, sessionId) -> the marks (the header left out), or
 *                       null when the session has no log here (no intake ran)
 *   turnFromMarks(marks) -> { turn, marks, promptText, continuation } for the
 *                       turn of the session's latest Glove mark: that turn's
 *                       Glove marks, and its prompt text from its own prompt
 *                       marks only (open question 2, src/opon/gate/prompts.js);
 *                       null when no Glove mark names a turn
 *   confirmedTurn(marks, claimText) -> that turn, only when the log shows it is
 *                       this Stop's turn and whole (slice B9b, LD163): not yet
 *                       ended, or its last claim is this Stop's final message
 *                       (the intake's Stop hook may land first, NF8); and no
 *                       gap that can lose Glove marks (any but a Sentinel watch
 *                       gap, as the engine reads them) since the previous
 *                       turn's end. Else { turn: null, reason }: the gate then
 *                       judges from the event log, as with the flag off.
 *
 * The gate runs at the Stop, while the intake may still be writing the turn:
 * what it reads is what had arrived, as with today's event log. A line that
 * does not parse is left out here; `orunmila verify` is what judges the log.
 */

const fs = require('fs');
const path = require('path');
const { promptsOf } = require('./prompts');
const { sessionFolderName } = require('../intake/paths');

const TURN = /^t[1-9][0-9]*$/;

function readSessionMarks(home, sessionId) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'sessions', sessionFolderName(sessionId), 'raw.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.record !== 'session_header' && r.record !== 'continuation') out.push(r);
    } catch {
      /* a cut last line: left out */
    }
  }
  return out;
}

function turnFromMarks(marks) {
  const glove = marks.filter((m) => m && (m.source === 'hook' || m.source === 'agent_claim') && typeof m.turn === 'string' && TURN.test(m.turn));
  if (!glove.length) return null;
  const turn = glove[glove.length - 1].turn;
  const own = glove.filter((m) => m.turn === turn);
  const p = promptsOf(own, turn);
  return { turn, marks: own, promptText: p.prompts.map((x) => x.text).join('\n'), continuation: p.continuation };
}

const endsTurn = (m) => m.source === 'hook' && m.says === 'ended' && m.target && m.target.kind === 'turn';
/** A gap that can lose Glove marks: any but a Sentinel watch gap (`detail.root`), as src/opon/settle/engine.js reads them. */
const losesGlove = (m) => m.says === 'gap' && !(m.detail && typeof m.detail === 'object' && m.detail.root);

function confirmedTurn(marks, claimText) {
  const t = turnFromMarks(marks);
  if (!t) return { turn: null, reason: 'no Glove mark names a turn' };
  let from = 0;
  marks.forEach((m, i) => {
    if (m && endsTurn(m) && m.target.id !== t.turn) from = i + 1;
  });
  if (marks.slice(from).some((m) => m && losesGlove(m))) return { turn: null, reason: "a capture gap since the previous turn ended may have lost this turn's marks" };
  if (t.marks.some((m) => endsTurn(m) && m.target.id === t.turn)) {
    const claims = t.marks.filter((m) => m.source === 'agent_claim' && m.says === 'claimed');
    const last = claims[claims.length - 1];
    if (!last || !last.detail || last.detail.text !== claimText) return { turn: null, reason: "the log's latest turn ended with another claim, so it is not this Stop's turn" };
  }
  return t;
}

module.exports = { readSessionMarks, turnFromMarks, confirmedTurn };
