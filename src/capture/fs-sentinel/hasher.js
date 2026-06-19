'use strict';

/**
 * hasher.js
 *
 * The thing that turns "the OS told us this path changed" into "the BYTES
 * actually changed." Editors and build tools fire fs events on touch/rename/
 * atomic-swap that don't alter content; without a content compare the sentinel
 * would cry wolf on every save-without-change. (PRD 6.4: ignore touch-without-
 * modify.)
 *
 * It also holds last-known CONTENT, not just the hash, so the emitted event can
 * carry a real unifiedDiff(before, after) — identical in shape to what the hook
 * layer produces, which is what lets the reconciler treat both streams the same.
 *
 * Memory honesty (PRD: "documented, not silent"): keeping full last-content for
 * every file is fine at hobby scale but unbounded on a giant tree. Files larger
 * than MAX_CONTENT_BYTES are tracked by hash ONLY — we still detect THAT they
 * changed, we just can't show a line diff for them (diffFromEmpty=false marks
 * this). Binary files are flagged so the renderer doesn't print garbage.
 */

const fs = require('fs');
const crypto = require('crypto');

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB: above this we keep hash only.

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Heuristic: a NUL byte in the first 8k means "treat as binary" — same trick
// git uses. Good enough to avoid emitting a meaningless text diff for images.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * A store mapping absolute path -> { hash, content|null, binary, size }.
 * `content` is null when the file is too large or binary (hash-only tracking).
 */
function createStore() {
  const map = new Map();

  /** Record the current on-disk state as the baseline, WITHOUT emitting. */
  function seed(absPath) {
    const snap = snapshot(absPath);
    if (snap) map.set(absPath, snap);
    return snap;
  }

  function get(absPath) {
    return map.get(absPath) || null;
  }

  /**
   * Compare current disk state to last-known. Returns null if unchanged (or the
   * file vanished and we never had it), otherwise a change descriptor with the
   * before/after content needed for a diff. Updates the store as a side effect.
   */
  function diffAndUpdate(absPath) {
    const prev = map.get(absPath) || null;
    const next = snapshot(absPath);

    if (!next) {
      // File gone. If we had it, that's a deletion (content -> empty).
      if (!prev) return null;
      map.delete(absPath);
      return {
        kind: 'delete',
        hash_before: prev.hash,
        hash_after: null,
        before: prev.content || '',
        after: '',
        binary: prev.binary,
      };
    }

    if (prev && prev.hash === next.hash) {
      return null; // touch without modify — the noise we exist to suppress.
    }

    map.set(absPath, next);
    return {
      kind: prev ? 'modify' : 'create',
      hash_before: prev ? prev.hash : null,
      hash_after: next.hash,
      before: prev ? prev.content || '' : '',
      after: next.content || '',
      binary: next.binary || (prev && prev.binary),
    };
  }

  function size() {
    return map.size;
  }

  return { seed, get, diffAndUpdate, size };
}

/** Read a file and produce a { hash, content|null, binary, size } snapshot. */
function snapshot(absPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null; // unreadable / gone / is a directory
  }
  const binary = looksBinary(buf);
  const tooBig = buf.length > MAX_CONTENT_BYTES;
  return {
    hash: sha256(buf),
    content: binary || tooBig ? null : buf.toString('utf8'),
    binary,
    size: buf.length,
  };
}

module.exports = { createStore, sha256, looksBinary, MAX_CONTENT_BYTES };
