'use strict';

/**
 * src/opon/intake/live.js — the Ọpọ́n live in the intake (Phase 3 slice L1c,
 * LD200; brief v4 lines 336, 386; guarantee 3), behind ORUNMILA_OPON_LIVE=1
 * (the router's `baseline` option, LD166, LD170). The router opens one per
 * session it starts, and the session log calls feed() with each mark as
 * written (session-log.js `onRecord`).
 *
 *   createLive({ spans, key, clock, receive, error })
 *     spans    one list shared by every session the router holds (LD200 (5),
 *              LD181 (1)): each session's span, open-ended while it is held and
 *              not ended, closed at its end mark; every engine reads it for
 *              overlap (station 5), as replay reads the folders beside a log
 *     receive  writes a mark to its session's log (the intake engine's receive)
 *     error    a line to the intake's error log
 *   live.open(dir, header, baseline) -> the session's live state: its engine
 *              (stations 2-6, settings from the header, as replay takes them),
 *              its odù log (odu.jsonl beside the raw log, its header line
 *              written now) and its span
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

const OPEN = String(2n ** 63n); // a held session's span runs on while it is held
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createLive({ spans, key, clock, receive, error }) {
  function stop(st, why) {
    st.on = false;
    error(`the live Ọpọ́n stopped for session ${st.header.session_id}: ${why}; its raw log goes on, and replay gives its odù log`, { session_id: st.header.session_id });
  }

  /** A session's live state, its span in the shared list (replacing any older one of its id). */
  function make(dir, header, baseline) {
    const config = configFromHeader(header);
    const id = header.session_id;
    const old = spans.findIndex((s) => s.id === id);
    if (old >= 0) spans.splice(old, 1);
    const span = { id, root: header.project_root, from: header.mono_ns, to: OPEN, ended: false };
    spans.push(span);
    return {
      header,
      span,
      root: header.project_root,
      file: path.join(dir, 'odu.jsonl'),
      opon: createOpon({ sessionId: id, config, baseline, byproducts: Array.isArray(config.byproducts) ? config.byproducts : null, root: header.project_root, others: spans }),
      odu: createOduWriter(header),
      sources: new Map(),
      due: [],
      draining: false,
      on: true,
    };
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
      for (const rec of marks) for (const r of step(st, rec)) text += canonicalize(r) + '\n';
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

  /** One record through the session's engine: its source kept, its span closed at the session's end; the odùs it seals. */
  function step(st, rec) {
    st.sources.set(rec.seq, rec.source);
    if (rec.says === 'ended' && isObject(rec.target) && rec.target.kind === 'session' && !st.span.ended) {
      st.span.to = rec.mono_ns;
      st.span.ended = true;
    }
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
    if (!st.on) return;
    try {
      for (const r of step(st, rec)) fs.appendFileSync(st.file, canonicalize(r) + '\n');
      st.due.push(...st.opon.fingerprintsDue());
    } catch (e) {
      stop(st, e.message);
      return;
    }
    if (st.draining) return; // a fingerprint written below feeds back in: the loop below takes what it adds
    st.draining = true;
    try {
      while (st.on && st.due.length) receive(fingerprintMark(st, st.due.shift()));
    } finally {
      st.draining = false;
    }
  }

  return { open, resume, feed };
}

module.exports = { createLive };
