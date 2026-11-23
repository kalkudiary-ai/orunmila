'use strict';

/**
 * src/opon/intake/live.js — the Ọpọ́n live in the intake (Phase 3 slice L1c,
 * LD200; brief v4 lines 336, 386; guarantee 3), behind ORUNMILA_OPON_LIVE=1
 * (the router's `baseline` option, LD166, LD170). The router opens one per
 * session it starts, and the session log calls feed() with each mark as
 * written (session-log.js `onRecord`).
 *
 *   createLive({ key, clock, receive, error })
 *     receive  writes a mark to its session's log (the intake engine's receive)
 *     error    a line to the intake's error log
 *   live.open(dir, header, baseline) -> the session's live state: its engine
 *              (stations 2-6, settings from the header, as replay takes them),
 *              its odù log (odu.jsonl beside the raw log, its header line
 *              written now) and its span
 *   live.pair(state)  once the router holds the session (L2, Q11 (2) (a),
 *              LD202): for every other session it holds, not ended, whose root
 *              shares files with this one's, an `overlapped` mark in each
 *              session's log naming the other, where it is not named yet. When
 *              a session's end mark is fed, each session it was named to gets
 *              one naming its end. Each engine reads overlap (station 5) only
 *              from its own log's `overlapped` marks, in seq order, as replay
 *              does, so the two agree and a peer's folder removed later changes
 *              nothing (LD181 (2))
 *   live.resume(dir, header, baseline, marks) -> the same for a session
 *              reopened after a restart (L1d): its marks so far replayed into a
 *              fresh engine, and its odù log continued only if it is the start
 *              of the replayed one
 *   live.feed(state, record)
 *              one record of the raw log, in seq order: into the engine; each
 *              group it seals, as an odù, to odu.jsonl; then, for each settled
 *              change of a file the engine names, a `fingerprinted` mark (line
 *              386; Q8's shape), written at once, so it lands before the seal
 *              (corrections item 4), right after the record that moved time on.
 *
 * The raw log is the record and replay its reference: the odù log written
 * here equals replay's of the same raw log, byte for byte. A failure here
 * (the engine, or a write to odu.jsonl) stops that session's live engine and
 * is written to the error log; the raw log goes on, and replay still gives its
 * odù log. Capture never waits on it and never breaks for it.
 */

const fs = require('fs');
const path = require('path');
const { createOpon } = require('../settle/engine');
const { createOduWriter } = require('../ledger/odu-log');
const { configFromHeader } = require('./header');
const { canonicalize } = require('../../verify/canonical');
const { fingerprintNow } = require('../net/baseline');
const { applyOverlapped, sharesFiles } = require('./overlap');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createLive({ key, clock, receive, error }) {
  const held = new Map(); // session id -> its live state, for pairing (L2)

  function stop(st, why) {
    st.on = false;
    error(`the live Ọpọ́n stopped for session ${st.header.session_id}: ${why}; its raw log goes on, and replay gives its odù log`, { session_id: st.header.session_id });
  }

  /** A session's live state: its own span, and the others its log's overlapped marks name (L2). */
  function make(dir, header, baseline) {
    const config = configFromHeader(header);
    const id = header.session_id;
    const others = [];
    const st = {
      header,
      span: { id, root: header.project_root, from: header.mono_ns, ended: false, to: null },
      root: header.project_root,
      file: path.join(dir, 'odu.jsonl'),
      others,
      opon: createOpon({ sessionId: id, config, baseline, byproducts: Array.isArray(config.byproducts) ? config.byproducts : null, root: header.project_root, others }),
      odu: createOduWriter(header),
      sources: new Map(),
      due: [],
      draining: false,
      on: true,
    };
    held.set(id, st);
    return st;
  }

  /** L2 (LD202): the intake's note in `into`'s log of session `about`, as it stands. */
  function overlapMark(into, about) {
    const now = clock();
    const s = about.span;
    return {
      schema_version: 1,
      session_id: into.header.session_id,
      source: 'process',
      agent: null,
      turn: null,
      sub_agent: null,
      observed_at: now.wall,
      mono_ns: now.mono,
      target: { kind: 'process', name: 'intake' },
      says: 'overlapped',
      detail: { session: s.id, root: s.root, from: s.from, ended: s.ended, ...(s.ended ? { to: s.to } : {}) },
      cause_hint: null,
    };
  }

  /** L2: name each held session sharing st's folder, and st to it, where not yet named. */
  function pair(st) {
    if (st.span.ended) return;
    for (const t of held.values()) {
      if (t === st || t.span.ended || !sharesFiles(t.root, st.root)) continue;
      if (!st.others.some((s) => s.id === t.span.id)) receive(overlapMark(st, t));
      if (!t.others.some((s) => s.id === st.span.id)) receive(overlapMark(t, st));
    }
  }

  function open(dir, header, baseline) {
    const st = make(dir, header, baseline);
    try {
      fs.writeFileSync(st.file, canonicalize(st.odu.head) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      stop(st, `its odù log could not be begun (${e.code || e.message})`);
    }
    return st;
  }

  /**
   * A session reopened after a restart (L1d, LD200 (6)): its raw log's marks so far replayed into a
   * fresh engine; the fingerprints they ask for are dropped (the restart's gap covers the downtime, and
   * `after` reads unknown, as replay reads it). The odù log on disk goes on when it is the start of the
   * replayed one (the rest appended, as after a crash between a mark and its odù); a missing one is
   * written whole; any other is never edited, and the session's live engine stops.
   */
  function resume(dir, header, baseline, marks) {
    const st = make(dir, header, baseline);
    try {
      let text = canonicalize(st.odu.head) + '\n';
      for (const rec of marks) {
        closes(st, rec);
        for (const r of step(st, rec)) text += canonicalize(r) + '\n';
      }
      st.opon.fingerprintsDue();
      let disk = null;
      try {
        disk = fs.readFileSync(st.file, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (disk === null) fs.writeFileSync(st.file, text, { flag: 'wx', mode: 0o600 });
      else if (!text.startsWith(disk)) stop(st, "its odù log on disk is not the start of replay's, and it is never edited");
      else if (text.length > disk.length) fs.appendFileSync(st.file, text.slice(disk.length));
    } catch (e) {
      stop(st, `it could not be resumed (${e.code || e.message})`);
    }
    return st;
  }

  /** The session's own span closed at its end mark; true when this record closed it. */
  function closes(st, rec) {
    if (!(rec.says === 'ended' && isObject(rec.target) && rec.target.kind === 'session' && !st.span.ended)) return false;
    st.span.to = rec.mono_ns;
    st.span.ended = true;
    return true;
  }

  /** One record through the session's engine: its source kept, an overlapped mark's news taken first (L2); the odùs it seals. */
  function step(st, rec) {
    st.sources.set(rec.seq, rec.source);
    if (rec.says === 'overlapped') applyOverlapped(st.others, rec);
    return st.opon.push(rec).map((g) => st.odu.add(g, (s) => st.sources.get(s))).filter(Boolean);
  }

  function fingerprintMark(st, rel) {
    const now = clock();
    return {
      schema_version: 1,
      session_id: st.header.session_id,
      source: 'process',
      agent: null,
      turn: null,
      sub_agent: null,
      observed_at: now.wall,
      mono_ns: now.mono,
      target: { kind: 'file', path: rel },
      says: 'fingerprinted',
      detail: fingerprintNow(path.join(st.root, rel), rel, key),
      cause_hint: null,
    };
  }

  function feed(st, rec) {
    const ended = closes(st, rec); // kept even when this session's engine has stopped: the others' records depend on it
    if (st.on) {
      try {
        for (const r of step(st, rec)) fs.appendFileSync(st.file, canonicalize(r) + '\n');
        st.due.push(...st.opon.fingerprintsDue());
      } catch (e) {
        stop(st, e.message);
      }
    }
    // L2: the end of this session, named to each session it was named to.
    if (ended) for (const t of held.values()) if (t !== st && t.others.some((s) => s.id === st.span.id && !s.ended)) receive(overlapMark(t, st));
    if (st.draining) return; // a fingerprint written below feeds back in: the loop below takes what it adds
    st.draining = true;
    try {
      while (st.on && st.due.length) receive(fingerprintMark(st, st.due.shift()));
    } finally {
      st.draining = false;
    }
  }

  return { open, resume, pair, feed };
}

module.exports = { createLive };
