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
const { verifyText, verifyBuffer } = require('../../verify/chain');
const { fingerprintNow } = require('../net/baseline');
const { applyOverlapped, sharesFiles } = require('./overlap');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createLive({ key, clock, receive, error, judge = false }) {
  const held = new Map(); // session id -> its live state, for pairing (L2)

  function stop(st, why) {
    st.on = false;
    error(`the live Ọpọ́n stopped for session ${st.header.session_id}: ${why}; its raw log goes on, and replay gives its odù log`, { session_id: st.header.session_id });
  }

  /**
   * A session's live state: its own span, and the others its log's overlapped marks name (L2). `sink` (TE1's rest,
   * LD285): the session log's watch(log, file) and wrote(log, text), so the guard follows every write to the odù and
   * verdict logs; null when there is none.
   */
  function make(dir, header, baseline, sink) {
    const config = configFromHeader(header);
    const id = header.session_id;
    const others = [];
    const st = {
      sink: sink && typeof sink.watch === 'function' ? sink : { watch: () => {}, wrote: () => {} },
      header,
      span: { id, root: header.project_root, from: header.mono_ns, ended: false, to: null },
      root: header.project_root,
      file: path.join(dir, 'odu.jsonl'),
      others,
      opon: createOpon({ sessionId: id, config, baseline, byproducts: Array.isArray(config.byproducts) ? config.byproducts : null, root: header.project_root, others }),
      odu: createOduWriter(header),
      oduLast: null,
      footed: false,
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

  function open(dir, header, baseline, sink = null) {
    const st = make(dir, header, baseline, sink);
    st.oduLast = st.odu.head;
    try {
      fs.writeFileSync(st.file, canonicalize(st.odu.head) + '\n', { flag: 'wx', mode: 0o600 });
      st.sink.watch('odu', st.file);
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
  function resume(dir, header, baseline, marks, sink = null) {
    const st = make(dir, header, baseline, sink);
    st.oduLast = st.odu.head;
    try {
      // The one-string odù log (LD287): the replayed log is kept a line at a time and compared with the one on disk as
      // bytes, a line at a time, so no string of the whole log is made (V8's longest is about 512 MB).
      const lines = [Buffer.from(canonicalize(st.odu.head) + '\n', 'utf8')];
      for (const rec of marks) {
        closes(st, rec);
        for (const r of step(st, rec)) lines.push(Buffer.from(canonicalize(r) + '\n', 'utf8'));
      }
      st.opon.fingerprintsDue();
      let disk = null;
      try {
        disk = fs.readFileSync(st.file);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      // How far the log on disk is the start of the replayed one: whole lines, then at most part of the next (a crash cut).
      let i = 0;
      let at = 0;
      let start = true;
      if (disk !== null) {
        while (i < lines.length && at + lines[i].length <= disk.length && disk.subarray(at, at + lines[i].length).equals(lines[i])) at += lines[i++].length;
        if (at < disk.length) start = i < lines.length && lines[i].subarray(0, disk.length - at).equals(disk.subarray(at));
      }
      if (!start) stop(st, "its odù log on disk is not the start of replay's, and it is never edited");
      else {
        const fd = fs.openSync(st.file, disk === null ? 'wx' : 'a', 0o600);
        try {
          if (disk !== null && at < disk.length) fs.writeSync(fd, lines[i++].subarray(disk.length - at)); // the cut line, completed
          for (; i < lines.length; i++) fs.writeSync(fd, lines[i]);
        } finally {
          fs.closeSync(fd);
        }
      }
      if (st.on) st.sink.watch('odu', st.file); // TE1's rest: from the log as it now stands, the start of replay's
      const verdicts = path.join(dir, 'verdict.jsonl');
      if (fs.existsSync(verdicts) && verifyBuffer(fs.readFileSync(verdicts)).ok) st.sink.watch('verdict', verdicts);
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
    const out = st.opon.push(rec).map((g) => st.odu.add(g, (s) => st.sources.get(s))).filter(Boolean);
    if (out.length) st.oduLast = out[out.length - 1];
    return out;
  }

  /**
   * K4 (LD209; line 454): footer.json beside the logs at the closeout's end: the raw log's last
   * line (the sweep's exited mark) and the odù log's, by seq and hash; the verdict log's when the judge
   * wrote one (BB6), else null. Placed whole; a failure is in the error log and never stops capture. LD249: at every
   * closeout's end, so a session resumed and swept again is footed at its latest end.
   */
  /**
   * BB6 (lines 453-454; plan section 5): with the judge on, closeout step 7: the sealed odù log judged through the
   * judge's one interface (src/babalawo), its new records appended to verdict.jsonl beside the other two logs (a
   * resumed session's second closeout adds only what changed, LD249). Returns the log's last line, or null when no
   * verdict log could be written, which the error log says; capture never waits on it and never breaks for it.
   */
  function writeVerdicts(st) {
    if (!judge || !st.on) return null;
    const id = st.header.session_id;
    const file = path.join(path.dirname(st.file), 'verdict.jsonl');
    try {
      let prior = [];
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        if (!verifyText(text).ok) {
          error(`the verdict log of ${id} does not verify, and it is never edited: no verdicts were written at this closeout`, { session_id: id });
          return null;
        }
        prior = text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
      }
      const iface = require('../../babalawo/interface'); // BB11: the judge's one interface, by name (line 682)
      const name = judge === true ? iface.DEFAULT : judge;
      const chosen = iface.get(name);
      if (!chosen) {
        error(`no judge named "${name}" is registered: no verdicts were written for session ${id}`, { session_id: id });
        return null;
      }
      const r = chosen.judge({ header: st.header, oduText: fs.readFileSync(st.file, 'utf8'), prior });
      if (!r.ok) {
        error(`the judge did not judge session ${id}: ${r.words}`, { session_id: id });
        return null;
      }
      if (r.added.length) {
        const existed = fs.existsSync(file);
        const text = r.added.map((x) => canonicalize(x) + '\n').join('');
        fs.appendFileSync(file, text, { mode: 0o600 });
        if (existed) st.sink.wrote('verdict', text); // TE1's rest (LD285): the guard follows Orunmila's own append
        else st.sink.watch('verdict', file);
      }
      const last = r.records[r.records.length - 1];
      return { seq: last.seq, hash: last.hash };
    } catch (e) {
      error(`the verdict log of ${id} could not be written: ${e.code || e.message}`, { session_id: id });
      return null;
    }
  }

  function writeFooter(st, rec) {
    const dir = path.dirname(st.file);
    const verdict = writeVerdicts(st);
    const footer = { schema_version: 1, record: 'session_footer', session_id: st.header.session_id, raw: { seq: rec.seq, hash: rec.hash }, odu: st.on ? { seq: st.oduLast.seq, hash: st.oduLast.hash } : null, verdict };
    try {
      const tmp = path.join(dir, `footer.json.${process.pid}.tmp`);
      fs.writeFileSync(tmp, canonicalize(footer) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, 'footer.json'));
    } catch (e) {
      error(`the session footer of ${st.header.session_id} could not be written: ${e.code || e.message}`, { session_id: st.header.session_id });
    }
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
        for (const r of step(st, rec)) {
          const text = canonicalize(r) + '\n';
          fs.appendFileSync(st.file, text);
          st.sink.wrote('odu', text); // TE1's rest (LD285)
        }
        st.due.push(...st.opon.fingerprintsDue());
      } catch (e) {
        stop(st, e.message);
      }
    }
    if (rec.says === 'exited' && rec.source === 'process' && isObject(rec.target) && rec.target.kind === 'process' && rec.target.name === 'closeout') writeFooter(st, rec); // K4
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
