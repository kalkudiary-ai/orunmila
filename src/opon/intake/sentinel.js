// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/sentinel.js — the Sentinel inside the intake (slice B4,
 * LD145; brief v4 station 1, lines 345-351; design D-I 4.2(c): one watcher per
 * folder, run by the intake). The router owns it: a held session's project
 * root is watched from its first session to its last.
 *
 *   createSentinels({ clock, key, diffOf, emit, debounceMs = 150, maxPending = Infinity })
 *     maxPending  T32 (test 32, LD374; ORUNMILA_SENTINEL_MAX_PENDING, no limit by
 *                 default): with more paths than this waiting at once under a
 *                 root, the rest of the flood is dropped and one gap says so
 *     emit(root, mark, keep)   a translated mark (no session_id yet) for every
 *                              held session of `root`, with the files to keep
 *     .ignoreFor(root)  what this Sentinel does not watch under root: today's
 *                       list (src/capture/fs-sentinel/ignore.js) less
 *                       `.orunmila/`, which is watched (N3); the logs live
 *                       outside the project, so watching it cannot loop
 *     .watch(root, limit)   start (or count one more user of) root's watcher;
 *                           `limit` is the header's diff_size_limit_bytes
 *     .unwatch(root)        one user fewer; the last closes the watcher
 *     .roots()              the roots watched, sorted
 *     .stop()               close every watcher
 *
 * Each content change becomes one `sentinel` mark (created, modified or
 * deleted; a touch that changes no byte is no mark), stamped at the last raw
 * event of its burst, after a 150 ms debounce per path, as today's Sentinel
 * does. Its detail names the root it watches (NF11, `root`), the size and
 * fingerprint after, the fingerprint before (left out on `created`, line 265),
 * the line counts, and the diff kept beside the log whole (NF14, NF21), or
 * `no_diff` `binary` or `too_large` (over the header's limit). A file on the
 * redaction list (`.env`, `.env.*`) is fingerprinted with the install key and
 * never diffed (line 249). A folder it cannot watch or read is a `gap` mark
 * (N2, line 347), and so is a diff that came back empty from a changed text
 * file (NF30). Baselines are read once at watch: a big project costs that read
 * (Phase 5's large repos).
 */

const fs = require('fs');
const path = require('path');
const { createWalker } = require('../../capture/fs-sentinel/walker');
const { effectiveIgnore, isIgnored } = require('../../capture/fs-sentinel/ignore');
const { looksBinary } = require('../../capture/fs-sentinel/hasher');
const { fingerprint, onRedactionList } = require('./redact');
const { readRegular } = require('./regular-file');

const DEBOUNCE_MS = 150;
const WATCHED_ANYWAY = '.orunmila'; // N3

function countLines(diff) {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** A file's state: { size, fingerprint, buf (text within the limit, else null), binary, big }, or null when it is no regular file. */
function snapFile(abs, limit, key) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const buf = readRegular(abs);
  if (buf === null) return null;
  const binary = looksBinary(buf);
  const big = buf.length > limit;
  return { size: buf.length, fingerprint: fingerprint(abs, buf, key), buf: binary || big ? null : buf, binary, big };
}

const ignoreFor = (root) => effectiveIgnore(root).filter((e) => String(e).replace(/\/+$/, '') !== WATCHED_ANYWAY);

function createSentinels({ clock, key, diffOf, emit, debounceMs = DEBOUNCE_MS, maxPending = Infinity }) {
  const watched = new Map(); // root -> { users, walker, store, pending, limit, ignore }

  const snap = (abs, limit) => snapFile(abs, limit, key);

  function gap(root, lost, at) {
    const now = at || clock();
    emit(root, { schema_version: 1, source: 'process', agent: null, turn: null, sub_agent: null, observed_at: now.wall, mono_ns: now.mono, target: null, says: 'gap', detail: { lost, root }, cause_hint: null }, []);
  }

  function change(root, w, abs, at) {
    const prev = w.store.get(abs);
    const next = snap(abs, w.limit);
    if (!prev && !next) return; // never known, now gone (or not a file)
    if (prev && next && prev.fingerprint === next.fingerprint) return; // touch without a change
    if (next) w.store.set(abs, next);
    else w.store.delete(abs);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const says = !prev ? 'created' : !next ? 'deleted' : 'modified';
    const detail = { root };
    if (next) detail.size = next.size;
    if (says !== 'created') detail.fingerprint_before = prev.fingerprint;
    detail.fingerprint = next ? next.fingerprint : null;
    const keep = [];
    let lost = false;
    if (onRedactionList(abs)) {
      Object.assign(detail, { lines_added: null, lines_removed: null }); // its diff would hold the values (line 249)
    } else if ((prev && prev.binary) || (next && next.binary)) {
      Object.assign(detail, { lines_added: null, lines_removed: null, no_diff: 'binary' });
    } else if ((prev && prev.big) || (next && next.big)) {
      Object.assign(detail, { lines_added: null, lines_removed: null, no_diff: 'too_large' });
    } else {
      const diff = diffOf(prev ? prev.buf.toString('utf8') : '', next ? next.buf.toString('utf8') : '', rel);
      if (diff) {
        const c = countLines(diff);
        Object.assign(detail, { lines_added: c.added, lines_removed: c.removed });
        keep.push({ slot: 'diff_ref', text: diff });
      } else {
        Object.assign(detail, { lines_added: null, lines_removed: null });
        lost = true;
      }
    }
    emit(root, { schema_version: 1, source: 'sentinel', agent: null, turn: null, sub_agent: null, observed_at: at.wall, mono_ns: at.mono, target: { kind: 'file', path: rel }, says, detail, cause_hint: null }, keep);
    if (lost) gap(root, `the diff of a change to ${rel}: it came back empty from a changed text file, so no diff program ran (NF30)`, at);
  }

  /** `initial` (SN1, LD294): abs -> state, read off the intake's thread; a file it does not hold is read here. */
  function watch(root, limit, initial = null) {
    const have = watched.get(root);
    if (have) {
      have.users++;
      return;
    }
    const ignore = ignoreFor(root);
    const w = { users: 1, store: new Map(), pending: new Map(), limit, ignore, walker: null };
    watched.set(root, w);
    w.walker = createWalker({
      root,
      isIgnored: (rel) => isIgnored(rel, ignore),
      onPath: (abs) => {
        const at = clock(); // the last raw event of a burst stamps the mark
        const prev = w.pending.get(abs);
        if (!prev && w.pending.size >= maxPending) {
          // T32 (test 32, LD374): flooded past its limit, the Sentinel drops what comes after it, and says so once per flood.
          if (!w.dropping) gap(root, `changes under ${root}: more than ${maxPending} paths were waiting at once, so the Sentinel dropped the rest of this flood and did not record them live; the closeout's rescan reads the folder again`, at);
          w.dropping = true;
          return;
        }
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => {
          w.pending.delete(abs);
          if (!w.pending.size) w.dropping = false; // the flood has drained: a later one is named again
          if (watched.get(root) !== w) return;
          change(root, w, abs, at);
        }, debounceMs);
        w.pending.set(abs, { timer, at });
      },
      onError: (err) => gap(root, `the Sentinel's watch of part of ${root}: ${err.message}; changes there are not recorded live`),
    });
    for (const f of w.walker.start()) {
      const s = initial && initial.has(f) ? initial.get(f) : snap(f, limit);
      if (s) w.store.set(f, s);
    }
  }

  function close(root, w) {
    for (const p of w.pending.values()) clearTimeout(p.timer);
    w.pending.clear();
    w.walker.close();
    watched.delete(root);
  }

  function unwatch(root) {
    const w = watched.get(root);
    if (!w) return;
    if (--w.users <= 0) close(root, w);
  }

  const roots = () => [...watched.keys()].sort();

  function stop() {
    for (const [root, w] of [...watched]) close(root, w);
  }

  return { watch, unwatch, roots, stop, ignoreFor };
}

module.exports = { createSentinels, snapFile, ignoreFor, DEBOUNCE_MS };
