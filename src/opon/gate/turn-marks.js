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

module.exports = { readSessionMarks, turnFromMarks };
