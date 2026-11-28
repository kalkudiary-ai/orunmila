// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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
 *              AT1b (LD330), with `peerBusy` (ORUNMILA_PEER_BUSY=1, off by
 *              default): each such mark notes whether the session it names is
 *              working (`busy`); each change of that is one more mark in every
 *              session it is named to; after a restart, a pair already named is
 *              told again where its log last said otherwise. A session works
 *              from its prompt (or first call) to its turn's end, and for good
 *              once it leaves work running past a call or the Glove records it
 *              after a turn ended. Off, no mark carries the note
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

/** AT1b (LD330): a mark that leaves work running past its call: a background command, a call asking for the background, Monitor. */
function leavesWorkRunning(rec) {
  const d = isObject(rec.detail) ? rec.detail : {};
  return d.background === true || (isObject(d.tool_input) && d.tool_input.run_in_background === true) || d.tool === 'Monitor';
}

function createLive({ key, clock, receive, error, judge = false, peerBusy = false }) {
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
      refs: new Map(), // MR2 (LD317): each mark's diff_ref by seq, for R27's diffs at the closeout
      due: [],
      draining: false,
      on: true,
      work: { busy: false, seen: false, stays: false }, // AT1b (LD330): whether it is working, as its own Glove marks show
    };
    held.set(id, st);
    return st;
  }

  /**
   * AT1b (LD330): one of the session's own records moves its working state: busy from its prompt (or its first call)
   * to its turn's end; busy for good once it leaves work running past a call, or the Glove records it after a turn has
   * ended (a background agent's call): nothing then says when that work ends. True when the state changed.
   */
  function track(st, rec) {
    if (rec.source !== 'hook' && rec.source !== 'agent_claim') return false;
    const t = isObject(rec.target) ? rec.target : {};
    if (t.kind === 'session') return false; // the session's end is named by its own notice (L2)
    const w = st.work;
    const was = w.busy;
    if (leavesWorkRunning(rec)) w.stays = true;
    if (rec.says === 'prompted') w.busy = true;
    else if (rec.says === 'ended' && t.kind === 'turn') w.busy = w.stays;
    else if (!w.busy) {
      if (w.seen) w.stays = true; // a call after its turn ended
      w.busy = true;
    }
    if (w.stays) w.busy = true;
    w.seen = true;
    return w.busy !== was;
  }

  /** AT1b: what `into`'s log last said of `about`'s work: true, false, or null for nothing yet. */
  function told(into, about) {
    const s = into.others.find((x) => x.id === about.span.id);
    return s && Array.isArray(s.busy) ? s.busy[s.busy.length - 1].to === null : null;
  }

  /** AT1b: `st`'s new state, named in the log of each session it is named to and not ended. */
  function tell(st) {
    for (const t of held.values()) if (t !== st && !t.span.ended && t.others.some((s) => s.id === st.span.id && !s.ended)) receive(overlapMark(t, st));
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
      detail: { session: s.id, root: s.root, from: s.from, ended: s.ended, ...(s.ended ? { to: s.to } : {}), ...(peerBusy ? { busy: about.work.busy } : {}) },
      cause_hint: null,
    };
  }

  /**
   * L2: name each held session sharing st's folder, and st to it, where not yet named. AT1b (LD330): with the busy
   * notes on, a pair already named (after a restart) is told the other's state again where its log last said otherwise.
   */
  function pair(st) {
    if (st.span.ended) return;
    for (const t of held.values()) {
      if (t === st || t.span.ended || !sharesFiles(t.root, st.root)) continue;
      for (const [into, about] of [[st, t], [t, st]]) {
        if (!into.others.some((s) => s.id === about.span.id)) receive(overlapMark(into, about));
        else if (peerBusy && told(into, about) !== about.work.busy) receive(overlapMark(into, about));
      }
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
        track(st, rec); // AT1b: its working state as its marks leave it
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
    if (judge && rec.detail && typeof rec.detail.diff_ref === 'string') st.refs.set(rec.seq, rec.detail.diff_ref); // only with the judge on (Leopard rule 2)
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
      const oduText = fs.readFileSync(st.file, 'utf8');
      const { testDiffs, oduRecords } = require('../ledger/beside');
      const diffs = testDiffs({ odus: oduRecords(oduText), refOf: (s) => st.refs.get(s) || null, dir: path.dirname(st.file) }); // MR2: R27
      const r = chosen.judge({ header: st.header, oduText, prior, diffs });
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
    const moved = track(st, rec); // AT1b: so too its working state
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
    if (ended) {
      for (const t of held.values()) if (t !== st && t.others.some((s) => s.id === st.span.id && !s.ended)) receive(overlapMark(t, st));
    } else if (moved && peerBusy) tell(st); // AT1b (LD330): its working state changed
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
