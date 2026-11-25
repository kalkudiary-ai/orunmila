// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/net/baseline.js — the baseline snapshot, station 4 (brief v4 lines
 * 385, 387, 390, 250; Phase 3 slice N1a, LD169): a fingerprint of every file in
 * the workspace at session start.
 *
 *   snapshot(root, { exclusions, key, envValues?, caseInsensitive?, chunkBytes? })
 *     -> { entries, text, fingerprint, files, bytes }
 *
 * Every entry under `root` is walked, sorted by path, except what the header's
 * exclusions name (src/capture/fs-sentinel/ignore.js isIgnored: the exclusion
 * itself is recorded in the header, line 385). A regular file is
 * { path, size, fingerprint }, hashed by streaming in chunks, never loaded
 * whole (line 390); a file on the redaction list is fingerprinted with the
 * install key (HMAC-SHA-256, line 250), as the marks do, so the two compare. A
 * symbolic link is { path, kind: 'link' }, never followed: its target may be
 * outside the project. Anything else that is not a folder is
 * { path, kind: 'other' }. A file or folder the walk cannot read (no
 * permission, gone mid-walk) is { path, kind: 'unreadable', error: <code> }
 * and the walk goes on (slice N1c, LD172): one unreadable entry never stops a
 * session being recorded. Nothing seen is left out. Paths are relative to the
 * root with `/`, lower-cased on a case-insensitive file system, as intake
 * normalises a mark's path (line 345), then redacted as every string of a mark
 * is (`envValues`, the project's `.env` values, held in memory only; slice N1b,
 * LD170), so a baseline entry and a mark for one file name it the same way and
 * no secret in a file's name reaches the file; a redacted entry notes the kinds
 * in `redactions`.
 *
 * `text` is the snapshot file: one canonical JSON line (RFC 8785) per entry;
 * `fingerprint` is the plain SHA-256 of its bytes, for the session header
 * (line 387). Plain code: the same tree gives the same text.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalize } = require('../../verify/canonical');
const { isIgnored } = require('../../capture/fs-sentinel/ignore');
const { onRedactionList, redactText } = require('../intake/redact');
const { isCaseInsensitive } = require('../intake/paths');

const CHUNK = 1024 * 1024;
let nowBuf = null; // fingerprintNow's read buffer, made on its first call (LR2c, LD253)

/** `buf`: the read buffer, one per snapshot (LR2c, LD253): only the bytes read into it are hashed, so it is never cleared. */
function hashFile(abs, rel, key, buf) {
  let h;
  if (onRedactionList(rel)) {
    if (!key || !key.length) throw new Error(`a file on the redaction list needs the install key to be fingerprinted: ${rel}`);
    h = { hash: crypto.createHmac('sha256', key), prefix: 'hmac-sha256:' };
  } else h = { hash: crypto.createHash('sha256'), prefix: 'sha256:' };
  const fd = fs.openSync(abs, 'r');
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, fingerprint: h.prefix + h.hash.digest('hex') };
}

function snapshot(root, { exclusions = [], key = null, envValues = [], caseInsensitive, chunkBytes = CHUNK } = {}) {
  const top = fs.realpathSync(root);
  const ci = caseInsensitive === undefined ? isCaseInsensitive(top) : caseInsensitive;
  const buf = Buffer.allocUnsafe(chunkBytes); // LR2c (LD253): one read buffer for the whole walk, not one per file
  const entries = [];
  const push = (rel, fields) => {
    const r = redactText(ci ? rel.toLowerCase() : rel, envValues);
    entries.push({ path: r.text, ...fields, ...(r.kinds.length ? { redactions: r.kinds } : {}) });
  };
  // A system error (it has a code) is the entry's fact; anything else (no install key) is the caller's to see.
  const attempt = (rel, fn) => {
    try {
      return fn();
    } catch (err) {
      if (!err || typeof err.code !== 'string') throw err;
      push(rel, { kind: 'unreadable', error: err.code });
      return null;
    }
  };
  const walk = (dir) => {
    const rel0 = path.relative(top, dir).split(path.sep).join('/');
    const list = attempt(rel0 || '.', () => fs.readdirSync(dir, { withFileTypes: true }));
    for (const e of list || []) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(top, abs).split(path.sep).join('/');
      if (isIgnored(e.isDirectory() ? rel + '/' : rel, exclusions)) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        walk(abs);
        continue;
      }
      const name = ci ? rel.toLowerCase() : rel;
      const r = redactText(name, envValues);
      const noted = r.kinds.length ? { redactions: r.kinds } : {};
      if (e.isSymbolicLink()) entries.push({ path: r.text, kind: 'link', ...noted });
      else if (e.isFile()) {
        const h = attempt(rel, () => hashFile(abs, rel, key, buf));
        if (h) entries.push({ path: r.text, ...h, ...noted });
      }
      else entries.push({ path: r.text, kind: 'other', ...noted });
    }
  };
  walk(top);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = entries.map((e) => canonicalize(e) + '\n').join('');
  const regular = entries.filter((e) => typeof e.size === 'number');
  return {
    entries,
    text,
    fingerprint: 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    files: regular.length,
    bytes: regular.reduce((n, e) => n + e.size, 0),
  };
}

/** A baseline snapshot's text as path -> fingerprint (null for a link, other or unreadable entry): replay's and the live intake's one reading (L1c). */
function baselineMap(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    map.set(e.path, typeof e.fingerprint === 'string' ? e.fingerprint : null);
  }
  return map;
}

/**
 * A file's state now, for its `fingerprinted` mark at settle time (L1c, LD200 (3); line 386): no
 * entry `{ exists: false }`; a regular file streamed, as the snapshot hashes one; anything else, or a
 * read that fails, `{ exists: true, size: null, fingerprint: null }` (unknown, never guessed).
 */
function fingerprintNow(abs, rel, key) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    return { exists: true, size: null, fingerprint: null };
  }
  if (!st.isFile()) return { exists: true, size: null, fingerprint: null };
  try {
    if (!nowBuf) nowBuf = Buffer.allocUnsafe(CHUNK); // LR2c (LD253): one buffer for every call (synchronous, never re-entered)
    return { exists: true, ...hashFile(abs, rel, key, nowBuf) };
  } catch {
    return { exists: true, size: null, fingerprint: null };
  }
}

module.exports = { snapshot, baselineMap, fingerprintNow };
