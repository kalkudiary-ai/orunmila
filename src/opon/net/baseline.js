'use strict';

/**
 * src/opon/net/baseline.js — the baseline snapshot, station 4 (brief v4 lines
 * 385, 387, 390, 250; Phase 3 slice N1a, LD169): a fingerprint of every file in
 * the workspace at session start.
 *
 *   snapshot(root, { exclusions, key, caseInsensitive?, chunkBytes? })
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
 * { path, kind: 'other' }. Nothing seen is left out. Paths are relative to the
 * root with `/`, lower-cased on a case-insensitive file system, as intake
 * normalises a mark's path (line 345), so a baseline entry and a mark for one
 * file name it the same way.
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
const { onRedactionList } = require('../intake/redact');
const { isCaseInsensitive } = require('../intake/paths');

const CHUNK = 1024 * 1024;

function hashFile(abs, rel, key, chunkBytes) {
  let h;
  if (onRedactionList(rel)) {
    if (!key || !key.length) throw new Error(`a file on the redaction list needs the install key to be fingerprinted: ${rel}`);
    h = { hash: crypto.createHmac('sha256', key), prefix: 'hmac-sha256:' };
  } else h = { hash: crypto.createHash('sha256'), prefix: 'sha256:' };
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(chunkBytes);
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      h.hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, fingerprint: h.prefix + h.hash.digest('hex') };
}

function snapshot(root, { exclusions = [], key = null, caseInsensitive, chunkBytes = CHUNK } = {}) {
  const top = fs.realpathSync(root);
  const ci = caseInsensitive === undefined ? isCaseInsensitive(top) : caseInsensitive;
  const entries = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(top, abs).split(path.sep).join('/');
      if (isIgnored(e.isDirectory() ? rel + '/' : rel, exclusions)) continue;
      const name = ci ? rel.toLowerCase() : rel;
      if (e.isSymbolicLink()) entries.push({ path: name, kind: 'link' });
      else if (e.isDirectory()) walk(abs);
      else if (e.isFile()) entries.push({ path: name, ...hashFile(abs, rel, key, chunkBytes) });
      else entries.push({ path: name, kind: 'other' });
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

module.exports = { snapshot };
