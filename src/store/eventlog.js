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
 *   agent       'claude-code' | 'cursor' | 'git-fallback' | 'fs-sentinel' | ...
 *   source      'hook' | 'fs-sentinel'  -- WHO observed this. A file_write from
 *               'hook' means the agent told us via its tool API; from
 *               'fs-sentinel' means we independently saw it land on disk. A
 *               sentinel write with no hook write for the same path in the same
 *               turn window is the untracked_write case (PRD 6.4).
 *   type        see TYPES below
 *   ...type-specific fields
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { redactEvent } = require('./secrets');

const TYPES = Object.freeze({
  USER_PROMPT: 'user_prompt',     // the instruction that opened this turn
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',       // includes diff
  COMMAND_RUN: 'command_run',     // shell command + exit code
  NETWORK_CALL: 'network_call',   // external contact (WebFetch/WebSearch/navigate/fetching MCP) — glove makes this first-class
  TOOL_CALL: 'tool_call',         // generic — covers MCP tools, search, etc.
  TOOL_RESULT: 'tool_result',     // paired with tool_call via call_id
  TURN_CLAIM: 'turn_claim',       // the agent's own text response for the turn
  TURN_END: 'turn_end',
  SESSION_END: 'session_end',
  // VCS / CI evidence — derived from gh/git command output at capture time so
  // merge and check state become first-class receipts, not lossy transcript
  // prose. These never go stale the way a code snapshot does: a PR_STATE with
  // state:'merged' is a durable fact about the world at the moment it was seen.
  GIT_STATE: 'git_state',         // { head_sha, branch } — repo position at capture
  PR_STATE: 'pr_state',           // { pr_number, pr_state: merged|open|closed, merged_sha }
  CI_STATE: 'ci_state',           // { ref, checks: [{ name, conclusion }] }
});

/**
 * Optional fields the glove capture upgrade may attach (all backwards-compatible —
 * events are an open shape, so older events simply lack them):
 *   hash         sha256 of a file's content at read/write time (provenance source id)
 *   bytes        byte size of that content
 *   channel      'network' tags an event as external contact (see NETWORK_CALL)
 *   host         the host an event reached out to (for network_call)
 *   output_path  sidecar file holding full (untruncated) command output
 */

// Owner-only access (0.2.2). The log, sidecars, before-snapshots and reports
// hold prompts, diffs and command output, so no other account on the machine
// may read them. The data dir is locked to 0700, which covers everything
// beneath it, and the top-level files are 0600 as a second layer. A custom
// ORUNMILA_HOME may be a folder the user shares with other things, so it is
// only chmodded when it is the default dir or one we just created; the files
// we own inside it are locked either way. Done once per process: hooks are
// short-lived, so this costs a couple of syscalls per hook run.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNED_FILES = ['events.jsonl', 'last-turn-report.txt', 'log-state.json', 'laws.json'];
const OWNED_DIRS = ['cache', 'output', 'reports', 'laws-state', 'archive', 'warned'];
const secured = new Set();

function secureDataDir(dir, created) {
  if (secured.has(dir)) return;
  secured.add(dir);
  const isDefault = !process.env.ORUNMILA_HOME;
  const targets = [];
  if (isDefault || created) targets.push([dir, DIR_MODE]);
  for (const f of OWNED_FILES) targets.push([path.join(dir, f), FILE_MODE]);
  for (const d of OWNED_DIRS) targets.push([path.join(dir, d), DIR_MODE]);
  for (const [p, mode] of targets) {
    try {
      fs.chmodSync(p, mode);
    } catch {
      /* absent (ENOENT) is the normal case; a chmod failure must never stop capture */
    }
  }
}

function dataDir() {
  const dir = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const created = fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE }) !== undefined;
  secureDataDir(dir, created);
  return dir;
}

function logPath() {
  return path.join(dataDir(), 'events.jsonl');
}

/** Append one event. Fire-and-forget cheap — this must never slow the agent down. */
function append(event) {
  const record = redactEvent(Object.assign({ ts: new Date().toISOString() }, event));
  fs.appendFileSync(logPath(), JSON.stringify(record) + '\n', { mode: FILE_MODE });
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

/**
 * Events whose ts falls in [fromTs, toTs], regardless of session/turn. Used to
 * correlate sentinel-sourced writes (which have no turn_id) into the turn whose
 * time window contains them. fromTs/toTs are ISO strings; toTs null = open end.
 */
function readBetween(fromTs, toTs) {
  return readAll().filter((e) => {
    if (!e.ts) return false;
    if (fromTs && e.ts < fromTs) return false;
    if (toTs && e.ts > toTs) return false;
    return true;
  });
}

/**
 * All sentinel-observed file writes across the whole log, read ONCE. Callers
 * that correlate sentinel writes into many turns (the trail / reconcile
 * renderers) should load this once and filter in-memory by time window rather
 * than calling readBetween() per turn — that turns an O(turns) render into
 * O(turns²) full-file parses on a long session.
 */
function readSentinelWrites() {
  return readAll().filter((e) => e.source === 'fs-sentinel' && e.type === TYPES.FILE_WRITE);
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
  // Return the most-recent event that actually belongs to a session. The
  // filesystem sentinel appends disk-write events with session_id === null
  // (it observes the disk, not any agent turn); when the sentinel runs
  // continuously those null-session events routinely sit at the tail of the
  // log, so taking the literal last line would report "no session" even
  // though real sessions exist. Skip null-session events — same rule
  // sessionsByRecency() already applies.
  const all = readAll();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].session_id) return all[i].session_id;
  }
  return null;
}

/** Sessions ordered by when each was last active (oldest first, newest last). */
function sessionsByRecency() {
  const lastSeen = new Map(); // session_id -> index of its last event
  readAll().forEach((e, i) => {
    if (e.session_id) lastSeen.set(e.session_id, i);
  });
  return [...lastSeen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/**
 * Cap the log by keeping only the `keep` most-recently-active sessions and
 * rewriting events.jsonl in place. A flat JSONL log grows forever otherwise;
 * this is the deliberate, EXPLICIT rotation — never automatic (the tool must
 * never silently discard a user's forensic trail), only on `orunmila prune`.
 * Writes to a temp file then renames so a crash mid-write can't truncate the
 * log. Returns { before, after, removedSessions, keptSessions }.
 */
function pruneToRecentSessions(keep) {
  const all = readAll();
  const order = sessionsByRecency();
  if (order.length <= keep) {
    return { before: all.length, after: all.length, removedSessions: [], keptSessions: order };
  }
  const kept = new Set(order.slice(-keep));
  const survivors = all.filter((e) => kept.has(e.session_id));
  const p = logPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, survivors.map((e) => JSON.stringify(e)).join('\n') + (survivors.length ? '\n' : ''), { mode: FILE_MODE });
  fs.renameSync(tmp, p);
  return {
    before: all.length,
    after: survivors.length,
    removedSessions: order.slice(0, order.length - keep),
    keptSessions: [...kept],
  };
}

module.exports = { TYPES, append, readAll, readSession, readTurn, readBetween, readSentinelWrites, groupByTurn, latestSessionId, sessionsByRecency, pruneToRecentSessions, logPath, dataDir };
