'use strict';

/**
 * turnstate.js — per-session turn counter (agent-agnostic).
 *
 * Most agents' hooks don't hand you a ready-made "turn id" — a turn is really
 * "one user message followed by however many tool calls followed by one stop".
 * We track it ourselves: the prompt phase bumps the counter, every other phase
 * just reads whatever the current value is. Keyed by session, stored under the
 * orunmila cache, so it works identically across Claude Code, Cursor, Codex, etc.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../store/eventlog');

function statePath(sessionId) {
  const dir = path.join(dataDir(), 'cache', sessionId || 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'turn.json');
}

function currentTurn(sessionId) {
  try {
    const raw = fs.readFileSync(statePath(sessionId), 'utf8');
    return JSON.parse(raw).turn || 1;
  } catch {
    return 1;
  }
}

function bumpTurn(sessionId) {
  const next = currentTurn(sessionId) + 1;
  fs.writeFileSync(statePath(sessionId), JSON.stringify({ turn: next }));
  return next;
}

function turnId(sessionId) {
  return `t${currentTurn(sessionId)}`;
}

module.exports = { currentTurn, bumpTurn, turnId };
