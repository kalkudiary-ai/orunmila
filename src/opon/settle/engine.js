'use strict';

/**
 * src/opon/settle/engine.js — the Ọpọ́n's event-time engine, stations 2-3
 * (brief v4 lines 355-379; Phase 2; slice R1: rules 1 and 7). Plain,
 * deterministic code (guarantee 8): marks in, group records out, nothing read
 * from disk or the clock.
 *
 *   createOpon({ sessionId, config })   config from the session header (test 35)
 *     .push(mark)   one mark, in seq order; returns the records it sealed
 *     .end()        the groups not yet sealed, in the order they opened, as
 *                   they stand (the closeout's force-settle is Phase 4)
 *
 * Event time (line 359): "now" is the mono_ns of the latest mark, ticks
 * included, and never goes back (a mark stamped earlier than now, a late
 * source, is processed at now). Before each mark joins its group, every group
 * is moved on to now: an open group whose last mark is a quiet window old is
 * settled at that moment (rule 1), and a settled group a lag grace older is
 * sealed (rule 7); groups sealed at one step are emitted in the order they
 * sealed, then the order they opened. A group that never goes quiet is
 * force-settled at its first mark plus the ceiling, whichever comes first
 * (rule 2, `ceiling: true`); it takes no more marks, and the target's next
 * mark, if it comes within a quiet window of that moment (the target is still
 * busy), opens a continuation group that names it (`continues`, LD153); a mark
 * later than that is a new event. A mark for a settled group (in its
 * grace) joins it and opens it again, its timer restarted: the grace is there
 * for a slow source's marks of the same event. A sealed group is never
 * reopened (rule 8, slice S6). Ticks only move time.
 *
 * Group records (LD142) use the odù's field names where they apply, and are
 * not odù records: no net change, attribution, confidence or conflicts yet.
 */

const { keyOf } = require('../group/keys');

const NS_PER_MS = 1000000n;
const DISK = new Set(['created', 'modified', 'deleted', 'renamed']);

/**
 * A group's action. For changes on disk, from whether the target existed
 * before its first change and after its last; otherwise the last outcome
 * verb, a tool call's `started` only when nothing followed it.
 */
function actionOf(says) {
  const disk = says.filter((v) => DISK.has(v));
  if (disk.length) {
    const before = disk[0] !== 'created';
    const after = disk[disk.length - 1] !== 'deleted';
    if (before && after) return disk.includes('renamed') && disk.every((v) => v === 'renamed') ? 'renamed' : 'modified';
    if (!before && after) return 'created';
    return 'deleted';
  }
  const done = says.filter((v) => v !== 'started');
  return done.length ? done[done.length - 1] : says[says.length - 1];
}

function createOpon({ sessionId, config }) {
  const quiet = BigInt(config.quiet_window_ms) * NS_PER_MS;
  const grace = BigInt(config.lag_grace_ms) * NS_PER_MS;
  const ceiling = BigInt(config.ceiling_ms) * NS_PER_MS;
  const live = new Map(); // key -> the group a new mark for it joins: open, or settled by quiet
  const unsealed = new Map(); // id -> group, in the order they opened
  const forcedLast = new Map(); // key -> { id, at }: the last group of the key force-settled at its ceiling
  const all = [];
  let now = null;
  let made = 0;

  const id = (n) => `g_${String(n).padStart(4, '0')}`;

  function record(g) {
    return {
      group_id: g.id,
      session_id: sessionId,
      state: g.state,
      target: g.target,
      action: actionOf(g.says),
      window: { first_seq: g.seqs[0], last_seq: g.seqs[g.seqs.length - 1] },
      mark_seqs: [...g.seqs],
      settled_at_ns: g.settledAt === null ? null : String(g.settledAt),
      sealed_at_ns: g.sealedAt === null ? null : String(g.sealedAt),
      ceiling: g.forced,
      parent_id: null,
      children: [],
      amends: null,
      continues: g.continues,
    };
  }

  function advance(t) {
    const sealed = [];
    for (const g of unsealed.values()) {
      if (g.state === 'open') {
        const byQuiet = g.last + quiet;
        const byCeiling = g.first + ceiling;
        const at = byQuiet <= byCeiling ? byQuiet : byCeiling;
        if (t >= at) {
          g.state = 'settled';
          g.settledAt = at;
          if (byCeiling < byQuiet) {
            // Rule 2: force-settled; the target's next marks go to a continuation.
            g.forced = true;
            if (live.get(g.key) === g) live.delete(g.key);
            forcedLast.set(g.key, { id: g.id, at });
          }
        }
      }
      if (g.state === 'settled' && t - g.settledAt >= grace) {
        g.sealedAt = g.settledAt + grace;
        sealed.push(g);
      }
    }
    sealed.sort((a, b) => (a.sealedAt < b.sealedAt ? -1 : a.sealedAt > b.sealedAt ? 1 : a.n - b.n));
    return sealed.map((g) => {
      g.state = 'sealed';
      if (live.get(g.key) === g) live.delete(g.key);
      unsealed.delete(g.id);
      return record(g);
    });
  }

  function push(m) {
    const t = BigInt(m.mono_ns);
    now = now === null || t > now ? t : now;
    const out = advance(now);
    if (m.says === 'tick') return out;
    const key = keyOf(m);
    let g = live.get(key);
    if (!g) {
      const f = forcedLast.get(key);
      forcedLast.delete(key);
      const continues = f && now - f.at < quiet ? f.id : null;
      g = { n: ++made, id: id(made), key, state: 'open', target: m.target, seqs: [], says: [], first: now, last: now, settledAt: null, sealedAt: null, forced: false, continues };
      live.set(key, g);
      unsealed.set(g.id, g);
      all.push(g);
    } else if (g.state === 'settled') {
      g.state = 'open';
      g.settledAt = null;
    }
    g.seqs.push(m.seq);
    g.says.push(m.says);
    g.last = now;
    return out;
  }

  const end = () => all.filter((g) => g.state !== 'sealed').map(record);

  return { push, end };
}

module.exports = { createOpon, actionOf };
