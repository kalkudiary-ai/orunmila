#!/usr/bin/env node
'use strict';

/**
 * stop.js
 *
 * Fires when Claude Code finishes responding for a turn. This is where the
 * "claim" actually exists for the first time, so it's where reconciliation
 * happens: pull the turn's events (writes/commands/tool calls already
 * captured by pre/post-tool-use.js), pull the agent's own response text from
 * the transcript, run the matcher, persist the report, and drop a rendered
 * copy where `stainmap watch` can pick it up.
 */

const fs = require('fs');
const path = require('path');
const { append, readTurn, TYPES, dataDir } = require('../../store/eventlog');
const { turnId } = require('./turnstate');
const { lastAssistantText, lastUserText } = require('./transcript');
const { reconcileAndPersist } = require('../../reconcile');
const { renderTurn } = require('../../render/terminal');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function lastTurnReportPath() {
  return path.join(dataDir(), 'last-turn-report.txt');
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
  const turn = turnId(sessionId);
  const transcriptPath = payload.transcript_path;

  const claimText = lastAssistantText(transcriptPath);

  append({
    session_id: sessionId,
    turn_id: turn,
    agent: 'claude-code',
    type: TYPES.TURN_CLAIM,
    text: claimText,
  });

  const existingPrompt = readTurn(sessionId, turn).find((e) => e.type === TYPES.USER_PROMPT);
  if (!existingPrompt) {
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      type: TYPES.USER_PROMPT,
      text: lastUserText(transcriptPath),
    });
  }

  append({ session_id: sessionId, turn_id: turn, agent: 'claude-code', type: TYPES.TURN_END });

  const report = reconcileAndPersist(sessionId, turn);
  const rendered = renderTurn(report);

  try {
    fs.writeFileSync(lastTurnReportPath(), rendered + '\n');
  } catch {
    /* best effort */
  }

  process.stdout.write(rendered + '\n');
  process.exit(0);
}

main();
