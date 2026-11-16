'use strict';

/**
 * src/opon/intake/engine.js — the intake's core (brief v4 lines 343, 360;
 * design D-I 4.3; Phase 1 slice B1). Built unwired before the 0.2.3 cut: no
 * socket, timer or file of its own. The caller gives it a clock and a session
 * log per session (src/opon/ledger/session-log.js), sends it marks that an
 * adapter has already translated, and calls poll() on a timer.
 *
 *   createIntake({ openLog, clock, tickMs = 500 })
 *     openLog(sessionId)  the session's log ({ append }), opened on its first mark
 *     clock()             { mono: '<decimal ns>', wall: '<ISO time>' }, the intake's
 *                         own time of arrival
 *   intake.receive(mark)  routes the mark to its session's log, by its
 *                         session_id; a mark with no mono_ns is stamped with the
 *                         arrival time and says so (detail.stamped_by, line 238).
 *                         Returns the log's answer, or { ok: false, reason } when
 *                         the mark names no session (nothing is written).
 *   intake.poll()         writes a `tick` (source process) to every session with
 *                         no mark written for tickMs (line 360: the heartbeat
 *                         ticks only while idle); returns how many it wrote
 *
 * Silence is measured on the intake's clock from the last mark written to the
 * session (a tick included), not from a source's own mono_ns. The caller's mark
 * is never changed.
 */

const TICK_MS = 500;
const NS_PER_MS = 1000000n;

function createIntake({ openLog, clock, tickMs = TICK_MS }) {
  const sessions = new Map(); // session id -> { log, last: bigint mono of the last mark written }
  const quiet = BigInt(tickMs) * NS_PER_MS;

  function write(s, m, now) {
    const r = s.log.append(m);
    if (r.ok) s.last = BigInt(now.mono);
    return r;
  }

  function receive(input) {
    const m = JSON.parse(JSON.stringify(input));
    const id = m && m.session_id;
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'the mark names no session, so it cannot be routed to a log' };
    const now = clock();
    let s = sessions.get(id);
    if (!s) {
      s = { log: openLog(id), last: BigInt(now.mono) };
      sessions.set(id, s);
    }
    if (m.mono_ns === undefined) {
      m.mono_ns = now.mono;
      if (m.detail && typeof m.detail === 'object' && !Array.isArray(m.detail)) m.detail = { ...m.detail, stamped_by: 'intake' };
    }
    return write(s, m, now);
  }

  function poll() {
    const now = clock();
    let written = 0;
    for (const [id, s] of sessions) {
      if (BigInt(now.mono) - s.last < quiet) continue;
      const tick = {
        schema_version: 1,
        session_id: id,
        source: 'process',
        agent: null,
        turn: null,
        sub_agent: null,
        observed_at: now.wall,
        mono_ns: now.mono,
        target: null,
        says: 'tick',
        detail: {},
        cause_hint: null,
      };
      if (write(s, tick, now).ok) written++;
    }
    return written;
  }

  return { receive, poll };
}

module.exports = { createIntake, TICK_MS };
