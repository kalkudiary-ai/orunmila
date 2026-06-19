#!/usr/bin/env node
'use strict';

/**
 * user-prompt-submit.js
 *
 * Fires before Claude sees the user's message. Two jobs:
 *   1. Bump the turn counter (everything that happens until the next Stop
 *      belongs to this turn).
 *   2. Log the raw prompt text as a USER_PROMPT event - this is what the
 *      task-extractor later splits into subtasks, so we can check the diff
 *      against what was actually asked, not just against what the agent
 *      claims it did (forensic gap #3: agents rarely lie about a dropped
 *      requirement, they just stop mentioning it).
 */

const fs = require('fs');
const { append, TYPES } = require('../../store/eventlog');
const { bumpTurn, turnId } = require('./turnstate');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id || 'unknown';
  bumpTurn(sessionId);

  append({
    session_id: sessionId,
    turn_id: turnId(sessionId),
    agent: 'claude-code',
    type: TYPES.USER_PROMPT,
    text: payload.prompt || payload.user_prompt || '',
  });

  process.exit(0);
}

main();
