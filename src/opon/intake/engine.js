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
 *   intake.receive(mark, { channel, pid })
 *                         routes the mark to its session's log, by its
 *                         session_id; a mark with no mono_ns is stamped with the
 *                         arrival time and says so (detail.stamped_by, line 238).
 *                         Glove marks (source hook or agent_claim) carry
 *                         detail.channel, `http` or `command` (decision I-3). The
 *                         first HTTP Glove payload with a pid pins the session to
 *                         that process (NF49); a later one from another pid is
 *                         written as a `tampered` mark (what: foreign_sender, both
 *                         pids, the payload as text) and never as the session's
 *                         own mark (decision I-2, test 82). Command-hook payloads
 *                         never pin and are never refused by a pin: the agent can
 *                         send them itself (NF48), which their label says.
 *                         Returns the log's answer, or { ok: false, reason } when
 *                         the mark names no session (nothing is written) or came
 *                         from the wrong process.
 *   intake.poll()         writes a `tick` (source process) to every session with
 *                         no mark written for tickMs (line 360: the heartbeat
 *                         ticks only while idle); returns how many it wrote
 *   intake.resume([{ id, log }])
 *                         after a restart, before anything else: one gap per
 *                         reopened session for the downtime (test 84; below);
 *                         returns { gaps: [{ id, seq }], failed: [{ id, reason }],
 *                         skipped: [{ id, reason }] } (sessions that ended)
 *   intake.stop(reason)   a planned stop: a closing note in each session not
 *                         yet ended, then nothing more (LD56); returns
 *                         { notes: [{ id, seq }], failed: [{ id, reason }] }
 *
 * Silence is measured on the intake's clock from the last mark written to the
 * session (a tick included), not from a source's own mono_ns. The caller's mark
 * is never changed.
 */

const TICK_MS = 500;
const NS_PER_MS = 1000000n;
const GLOVE_SOURCES = ['hook', 'agent_claim']; // the Glove's marks: the agent's own hooks and its claim
const CHANNELS = ['http', 'command']; // detail.channel (decision I-3)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createIntake({ openLog, clock, tickMs = TICK_MS }) {
  const sessions = new Map(); // session id -> { log, last: bigint mono of the last mark written }
  const quiet = BigInt(tickMs) * NS_PER_MS;
  let stopped = false;

  function write(s, m, now) {
    const r = s.log.append(m);
    if (r.ok) s.last = BigInt(now.mono);
    return r;
  }

  /** A payload for a pinned session from another process: recorded as tampered, never as the session's mark (I-2). */
  function foreign(s, id, m, pid, now) {
    const t = {
      schema_version: 1,
      session_id: id,
      source: 'process',
      agent: null,
      turn: null,
      sub_agent: null,
      observed_at: now.wall,
      mono_ns: now.mono,
      target: { kind: 'process' },
      says: 'tampered',
      detail: { what: 'foreign_sender', sender_pid: pid, pinned_pid: s.pin, received: JSON.stringify(m) },
      cause_hint: null,
    };
    const r = write(s, t, now);
    return {
      ok: false,
      reason: `a payload for session ${id} came from another process (pid ${pid}; the session is pinned to pid ${s.pin}): recorded as tampered, not as the session's mark`,
      tampered: r.ok ? r.seq : null,
    };
  }

  function receive(input, from = {}) {
    if (stopped) return { ok: false, reason: 'intake has stopped: nothing more is written until it restarts, and the restart gap covers this mark' };
    const m = JSON.parse(JSON.stringify(input));
    const id = m && m.session_id;
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'the mark names no session, so it cannot be routed to a log' };
    const now = clock();
    let s = sessions.get(id);
    if (!s) {
      s = { log: openLog(id), last: BigInt(now.mono), pin: null };
      sessions.set(id, s);
    }
    const glove = GLOVE_SOURCES.includes(m.source);
    const pid = Number.isInteger(from.pid) ? from.pid : null;
    if (glove && from.channel === 'http' && pid !== null) {
      // Pinned at first contact (NF49): only HTTP payloads carry a sender the agent cannot choose.
      if (s.pin === null) s.pin = pid;
      else if (s.pin !== pid) return foreign(s, id, m, pid, now);
    }
    if (glove && CHANNELS.includes(from.channel) && isObject(m.detail)) m.detail = { ...m.detail, channel: from.channel };
    if (m.mono_ns === undefined) {
      m.mono_ns = now.mono;
      if (isObject(m.detail)) m.detail = { ...m.detail, stamped_by: 'intake' };
    }
    const r = write(s, m, now);
    if (r.ok && m.says === 'ended' && isObject(m.target) && m.target.kind === 'session') s.ended = true;
    return r;
  }

  function poll() {
    if (stopped) return 0;
    const now = clock();
    let written = 0;
    for (const [id, s] of sessions) {
      if (s.ended) continue; // an ended session never ticks (LD55)
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

  /**
   * After a restart (test 84; design D-I 4.7). `entries` are the reopened logs
   * (session-log.js openSessionLog) of the sessions the intake was serving.
   * A session whose log holds its end mark is held but skipped: no gap, no
   * tick, named in no gap (LD55). One gap goes into each of the others, from
   * the latest record among all of them (the intake's last write: a tick when
   * idle) to now, naming them all. It is
   * written on every restart, however short: hooks never wait for intake, so
   * anything sent meanwhile is lost. A reboot resets the monotonic clock, so a
   * now below `since` is written too, flagged clock_reset. A gap a log refuses
   * is reported in `failed`, never dropped.
   */
  function resume(entries) {
    if (sessions.size) throw new Error('resume comes first: this intake already holds sessions');
    const ids = entries.map((e) => e.id);
    if (new Set(ids).size !== ids.length) throw new Error('a session is resumed twice');
    const out = { gaps: [], failed: [], skipped: [] };
    if (!entries.length) return out;
    const now = clock();
    const since = entries.map((e) => e.log.last()).reduce((a, b) => (BigInt(b.mono_ns) > BigInt(a.mono_ns) ? b : a));
    const live = entries.filter((e) => !e.log.ended());
    const named = live.map((e) => e.id).sort();
    for (const { id, log } of entries) {
      const s = { log, last: BigInt(now.mono), pin: null };
      sessions.set(id, s);
      if (log.ended()) {
        // Held, so a late mark still lands in its log, but no gap and no tick (LD55).
        s.ended = true;
        out.skipped.push({ id, reason: 'the session ended' });
        continue;
      }
      const detail = {
        lost: `every mark sent to intake while it was not running, from ${since.observed_at} to ${now.wall}`,
        since: { mono_ns: since.mono_ns, observed_at: since.observed_at },
        until: { mono_ns: now.mono, observed_at: now.wall },
        sessions: named,
      };
      if (BigInt(now.mono) < BigInt(since.mono_ns)) detail.clock_reset = true;
      const gap = { schema_version: 1, session_id: id, source: 'process', agent: null, turn: null, sub_agent: null, target: null, observed_at: now.wall, mono_ns: now.mono, says: 'gap', detail, cause_hint: null };
      const r = write(s, gap, now);
      if (r.ok) out.gaps.push({ id, seq: r.seq });
      else out.failed.push({ id, reason: (r.reasons || [r.reason]).join('; ') });
    }
    return out;
  }

  /**
   * A planned stop (LD56): one closing note in each session not yet ended,
   * then nothing more is accepted or ticked. The next restart's gap starts
   * at the note, the intake's last write. A second stop writes nothing.
   */
  function stop(reason) {
    const out = { notes: [], failed: [] };
    if (stopped) return out;
    stopped = true;
    const now = clock();
    for (const [id, s] of sessions) {
      if (s.ended) continue;
      const note = {
        schema_version: 1,
        session_id: id,
        source: 'process',
        agent: null,
        turn: null,
        sub_agent: null,
        observed_at: now.wall,
        mono_ns: now.mono,
        target: { kind: 'process', name: 'intake' },
        says: 'exited',
        detail: { exit_status: 'pass', reason: String(reason) },
        cause_hint: null,
      };
      const r = write(s, note, now);
      if (r.ok) out.notes.push({ id, seq: r.seq });
      else out.failed.push({ id, reason: (r.reasons || [r.reason]).join('; ') });
    }
    return out;
  }

  return { receive, poll, resume, stop };
}

module.exports = { createIntake, TICK_MS };
