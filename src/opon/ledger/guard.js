// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/ledger/guard.js — a log Orunmila writes, watched for any change it did not make (Phase 6 slice TE1, LD279;
 * guarantee 9 as O amended it, LD257, Q31: "Let the log log tamper and edits ... if an agent deletes and rewrites, it
 * should log the delete, what was deleted and what was rewritten"). Nothing is made impossible: the log stays under the
 * user's own account, which the agent shares; every change is recorded and the log put back.
 *
 *   createGuard(file, copy)   starts from the file as it stands (verified by its writer); `copy` is Orunmila's own copy
 *     .wrote(text)            after each of Orunmila's own appends: the copy and its running fingerprint follow
 *     .check() -> null | { change, removed, added, fingerprint_before, fingerprint, restored }
 *                             null when the file is as Orunmila wrote it (its identity, size and times unchanged, or,
 *                             when those moved, its bytes the same). Otherwise what changed, against the copy:
 *                             appended (bytes after the end), cut (the end gone), edited (any other difference,
 *                             a delete then a rewrite included), deleted (no file: deleted or moved away); the text
 *                             removed and added, each cut to 2,000 characters; and the log put back from the copy,
 *                             whole, in one rename. When the copy no longer matches its running fingerprint (it was
 *                             changed too), nothing is put back: `restored: false`.
 *
 * Stated limit: a change made between one of Orunmila's own writes and its next stat of the file is seen as its own.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXCERPT = 2000;
const sha = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
const cut = (buf) => [...buf.toString('utf8')].slice(0, EXCERPT).join('');

function stamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return null;
  }
}

function read(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function createGuard(file, copy) {
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
  const start = fs.readFileSync(file);
  fs.writeFileSync(copy, start, { mode: 0o600 });
  const running = crypto.createHash('sha256').update(start);
  let seen = stamp(file);

  function wrote(text) {
    fs.appendFileSync(copy, text);
    running.update(text);
    seen = stamp(file);
  }

  function check() {
    const now = stamp(file);
    if (now !== null && now === seen) return null;
    const want = read(copy);
    const got = read(file);
    const trusted = want !== null && sha(want) === 'sha256:' + running.copy().digest('hex');
    if (trusted && got !== null && got.equals(want)) {
      seen = now; // touched, the bytes the same: nothing changed
      return null;
    }
    const base = trusted ? want : Buffer.alloc(0);
    let change = 'edited';
    let removed = Buffer.alloc(0);
    let added = Buffer.alloc(0);
    if (got === null) {
      change = 'deleted';
      removed = base;
    } else if (got.length > base.length && got.subarray(0, base.length).equals(base)) {
      change = 'appended';
      added = got.subarray(base.length);
    } else if (got.length < base.length && base.subarray(0, got.length).equals(got)) {
      change = 'cut';
      removed = base.subarray(got.length);
    } else {
      let k = 0;
      while (k < got.length && k < base.length && got[k] === base[k]) k++;
      k = k === 0 ? 0 : base.lastIndexOf(0x0a, k - 1) + 1; // from the start of the first line that differs (a negative offset would count from the end)
      removed = base.subarray(k);
      added = got.subarray(k);
    }
    const out = { change, removed: cut(removed), added: cut(added), fingerprint_before: trusted ? sha(want) : null, fingerprint: got === null ? null : sha(got), restored: false };
    if (trusted) {
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.restore`);
      fs.writeFileSync(tmp, want, { mode: 0o600 });
      fs.renameSync(tmp, file);
      out.restored = true;
    }
    seen = stamp(file);
    return out;
  }

  return { wrote, check, file };
}

module.exports = { createGuard };
