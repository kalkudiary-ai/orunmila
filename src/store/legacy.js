'use strict';

/**
 * legacy.js
 *
 * Logs written before 0.2.2 are unredacted. 0.2.2 cannot scrub them silently
 * (it would rewrite a user's forensic record without asking) and hooks cannot
 * ask questions, so it records once whether such a log existed when 0.2.2 first
 * ran, warns until the user acts, and gives them two explicit commands:
 *
 *   orunmila log redact          scrub every stored file in place
 *   orunmila log delete --yes    remove the stored session data
 *
 * State lives in <dataDir>/log-state.json:
 *   { schema_version: 1, first_seen_at, legacy_unredacted, redacted_at?, deleted_at? }
 *
 * This module takes the data dir as an argument and never requires eventlog.js
 * (eventlog calls detect() while securing the dir, before its first append).
 */

const fs = require('fs');
const path = require('path');
const { redactString, redactEvent } = require('./secrets');

const FILE_MODE = 0o600;

const WARNING =
  'Orunmila: your event log was written before 0.2.2 and may contain unredacted secrets; ' +
  'run `orunmila log redact` to scrub it, or `orunmila log delete --yes` to remove it.';

// Everything that can hold captured content. laws.json (user config) and
// log-state.json are never touched.
const CONTENT_DIRS = ['output', 'cache', 'reports', 'archive', 'laws-state'];
const CONTENT_FILES = ['events.jsonl', 'last-turn-report.txt'];

function statePath(dir) {
  return path.join(dir, 'log-state.json');
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(dir, state) {
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\n', { mode: FILE_MODE });
}

/**
 * Called once per process, before anything is appended. The first time 0.2.2
 * sees a data dir, a non-empty events.jsonl can only have come from an older
 * version, so it is recorded as legacy.
 */
function detect(dir) {
  if (readState(dir)) return;
  let size = 0;
  try {
    size = fs.statSync(path.join(dir, 'events.jsonl')).size;
  } catch {
    /* no log yet: a fresh install */
  }
  try {
    writeState(dir, { schema_version: 1, first_seen_at: new Date().toISOString(), legacy_unredacted: size > 0 });
  } catch {
    /* unwritable state must never stop capture */
  }
}

function isLegacy(dir) {
  const s = readState(dir);
  return !!(s && s.legacy_unredacted);
}

/** True the first time it is called for a session, so the warning shows once per session. */
function firstWarningForSession(dir, sessionId) {
  const wdir = path.join(dir, 'warned');
  const marker = path.join(wdir, encodeURIComponent(String(sessionId || 'unknown')));
  try {
    fs.mkdirSync(wdir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '', { flag: 'wx', mode: FILE_MODE });
    return true;
  } catch {
    return false; // already warned (EEXIST), or unwritable: never nag on every prompt
  }
}

// --- redact ------------------------------------------------------------------

function redactLine(line) {
  try {
    return JSON.stringify(redactEvent(JSON.parse(line)));
  } catch {
    return redactString(line).text; // a half-written line still gets scrubbed
  }
}

function rewrite(file, transform) {
  const before = fs.readFileSync(file, 'utf8');
  const out = transform(before);
  if (out === before) return false;
  const tmp = file + '.redact-tmp';
  fs.writeFileSync(tmp, out, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Rewrite events.jsonl line by line through the capture redactor. A hook may
 * append while this runs, so after writing the temp file the original is
 * re-read and any tail that arrived meanwhile is scrubbed and carried over
 * before the rename. Best run with no agent session active; the docs say so.
 */
function redactLog(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  let changed = 0;
  const out = lines.map((l) => {
    if (!l) return l;
    const r = redactLine(l);
    if (r !== l) changed++;
    return r;
  });
  const tmp = file + '.redact-tmp';
  fs.writeFileSync(tmp, out.join('\n'), { mode: FILE_MODE });
  const now = fs.readFileSync(file, 'utf8');
  if (now.length > raw.length) {
    const tail = now.slice(raw.length).split('\n').map((l) => (l ? redactLine(l) : l));
    fs.appendFileSync(tmp, tail.join('\n'));
  }
  fs.renameSync(tmp, file);
  return { lines: lines.filter(Boolean).length, changed };
}

function walkFiles(root, fn) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(p, fn);
    else if (e.isFile()) fn(p);
  }
}

/** Scrub every stored file. Returns counts for the CLI to print. */
function redactAll(dir) {
  const res = { log: null, files_scanned: 0, files_changed: 0 };
  const log = path.join(dir, 'events.jsonl');
  if (fs.existsSync(log)) res.log = redactLog(log);
  const scrub = (p) => {
    res.files_scanned++;
    const isJson = p.endsWith('.json');
    const changed = rewrite(p, (text) => {
      if (isJson) {
        try {
          return JSON.stringify(redactEvent(JSON.parse(text)), null, 2) + '\n';
        } catch {
          /* fall through to plain-text scrub */
        }
      }
      return redactString(text).text;
    });
    if (changed) res.files_changed++;
  };
  const lastTurn = path.join(dir, 'last-turn-report.txt');
  if (fs.existsSync(lastTurn)) scrub(lastTurn);
  for (const d of CONTENT_DIRS) walkFiles(path.join(dir, d), scrub);
  const state = readState(dir) || { schema_version: 1, first_seen_at: new Date().toISOString() };
  writeState(dir, Object.assign(state, { legacy_unredacted: false, redacted_at: new Date().toISOString() }));
  return res;
}

// --- delete ------------------------------------------------------------------

/** What `log delete` would remove, for the dry-run listing. */
function deletionTargets(dir) {
  return [...CONTENT_FILES, ...CONTENT_DIRS].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

function deleteAll(dir) {
  const removed = deletionTargets(dir);
  for (const p of removed) fs.rmSync(p, { recursive: true, force: true });
  const state = readState(dir) || { schema_version: 1, first_seen_at: new Date().toISOString() };
  writeState(dir, Object.assign(state, { legacy_unredacted: false, deleted_at: new Date().toISOString() }));
  return removed;
}

module.exports = { WARNING, detect, isLegacy, firstWarningForSession, redactAll, deleteAll, deletionTargets, readState };
