'use strict';

/**
 * eventlog.js
 *
 * The ground truth. Every capture adapter (Claude Code, Cursor, git-fallback, ...)
 * writes here. Every reconciler and renderer reads from here. Nothing else holds
 * state. This is deliberately a flat JSONL file, not SQLite — zero native deps,
 * human-readable, grep/jq-able, and a forensic trail in its own right.
 *
 * Event shape (every event has these):
 *   ts          ISO timestamp
 *   session_id  one per agent session (provided by the agent's hook payload)
 *   turn_id     one per user-message -> agent-response cycle
 *   agent       'claude-code' | 'cursor' | 'git-fallback' | ...
 *   type        see TYPES below
 *   ...type-specific fields
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TYPES = Object.freeze({
  USER_PROMPT: 'user_prompt',     // the instruction that opened this turn
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',       // includes diff
  COMMAND_RUN: 'command_run',     // shell command + exit code
  TOOL_CALL: 'tool_call',         // generic — covers MCP tools, search, etc.
  TOOL_RESULT: 'tool_result',     // paired with tool_call via call_id
  TURN_CLAIM: 'turn_claim',       // the agent's own text response for the turn
  TURN_END: 'turn_end',
  SESSION_END: 'session_end',
});

function dataDir() {
  const dir = process.env.STAINMAP_HOME || path.join(os.homedir(), '.stainmap');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logPath() {
  return path.join(dataDir(), 'events.jsonl');
}

/** Append one event. Fire-and-forget cheap — this must never slow the agent down. */
function append(event) {
  const record = Object.assign({ ts: new Date().toISOString() }, event);
  fs.appendFileSync(logPath(), JSON.stringify(record) + '\n');
  return record;
}

/** Read every event. Fine at hobby-project scale; swap for SQLite if a log ever gets huge. */
function readAll() {
  const p = logPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // tolerate a half-written line from a crashed process
      }
    })
    .filter(Boolean);
}

function readSession(sessionId) {
  return readAll().filter((e) => e.session_id === sessionId);
}

function readTurn(sessionId, turnId) {
  return readAll().filter((e) => e.session_id === sessionId && e.turn_id === turnId);
}

/** Group a session's flat event list into per-turn buckets, in order. */
function groupByTurn(events) {
  const turns = new Map();
  for (const e of events) {
    const key = e.turn_id || '_no_turn';
    if (!turns.has(key)) turns.set(key, []);
    turns.get(key).push(e);
  }
  return turns;
}

function latestSessionId() {
  const all = readAll();
  if (!all.length) return null;
  return all[all.length - 1].session_id;
}

module.exports = { TYPES, append, readAll, readSession, readTurn, groupByTurn, latestSessionId, logPath, dataDir };
