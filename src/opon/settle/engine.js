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
 * later than that is a new event.
 *
 * Process-aware hold (rule 3): a command's group with a `started` mark and no
 * `exited` (or failed `ended`) yet stays open however long it is quiet, and the
 * ceiling never cuts it; once the process has exited it waits one quiet
 * window. A turn's group holds until its `ended` mark, subject to the ceiling;
 * a held group force-settled at the ceiling is still running, so its next mark
 * continues it however late (LD154). Children of a running command: slice G2.
 *
 * Renames and temp files (rule 4, LD155): an editor's temp file joins the
 * group of the file it stands for (src/opon/group/keys.js aliasPath), and vim's
 * `4913` its folder's latest open file group; their marks are listed but do
 * not count for the action, so a temp file's own creation never makes an edit
 * look like one. A `renamed` mark moves the old path's open group into the new
 * path's (merged with it if it has one). A mark for a settled group (in its
 * grace) joins it and opens it again, its timer restarted: the grace is there
 * for a slow source's marks of the same event. A sealed group is never
 * reopened (rule 8, slice S6). Ticks only move time.
 *
 * Group records (LD142) use the odù's field names where they apply, and are
 * not odù records: no net change, attribution, confidence or conflicts yet.
 */

const path = require('path');
const { keyOf, aliasPath } = require('../group/keys');

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

  /** Why a group may not settle yet (rule 3): 'process', 'turn' or null. */
  function holdOf(g) {
    if (g.isCommand && g.says.includes('started') && !g.says.some((v) => v === 'exited' || v === 'ended')) return 'process';
    if (g.isTurn && !g.turnEnded) return 'turn';
    return null;
  }

  function record(g) {
    return {
      group_id: g.id,
      session_id: sessionId,
      state: g.state,
      target: g.target,
      action: actionOf(g.realSays.length ? g.realSays : g.says),
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
        const hold = holdOf(g);
        const byQuiet = hold ? null : g.last + quiet;
        // A command that was seen starting is held until it exits, never cut by the ceiling (rule 3).
        const byCeiling = g.isCommand && g.says.includes('started') ? null : g.first + ceiling;
        const at = byQuiet === null ? byCeiling : byCeiling === null || byQuiet <= byCeiling ? byQuiet : byCeiling;
        if (at !== null && t >= at) {
          g.state = 'settled';
          g.settledAt = at;
          if (at !== byQuiet) {
            // Rule 2: force-settled; the target's next marks go to a continuation.
            g.forced = true;
            if (live.get(g.key) === g) live.delete(g.key);
            forcedLast.set(g.key, { id: g.id, at, held: hold !== null });
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

  /** The open file group in `dir` that had a mark last (vim's 4913 joins it), or null. */
  function latestOpenIn(dir) {
    let best = null;
    for (const g of live.values()) {
      if (g.state !== 'open' || !g.key.startsWith('file:') || path.posix.dirname(g.target.path) !== dir) continue;
      if (!best || g.last > best.last || (g.last === best.last && g.n > best.n)) best = g;
    }
    return best;
  }

  /** Rule 4: the old path's open group goes to the new path, merged with the new path's own. */
  function rename(fromKey, toKey, target) {
    const a = live.get(fromKey);
    if (!a || a.state !== 'open') return;
    live.delete(fromKey);
    const b = live.get(toKey);
    if (!b) {
      a.key = toKey;
      a.target = target;
      live.set(toKey, a);
      return;
    }
    const rows = [...a.seqs.map((s, i) => [s, a.says[i], a.real[i]]), ...b.seqs.map((s, i) => [s, b.says[i], b.real[i]])].sort((x, y) => x[0] - y[0]);
    b.seqs = rows.map((r) => r[0]);
    b.says = rows.map((r) => r[1]);
    b.real = rows.map((r) => r[2]);
    b.realSays = rows.filter((r) => r[2]).map((r) => r[1]);
    if (a.first < b.first) b.first = a.first;
    if (a.last > b.last) b.last = a.last;
    unsealed.delete(a.id);
    all.splice(all.indexOf(a), 1);
  }

  function push(m) {
    const t = BigInt(m.mono_ns);
    now = now === null || t > now ? t : now;
    const out = advance(now);
    if (m.says === 'tick') return out;
    let key = keyOf(m);
    let target = m.target;
    let real = true;
    if (m.target && m.target.kind === 'file' && typeof m.target.path === 'string') {
      const p = m.target.path;
      if (path.posix.basename(p) === '4913') {
        const host = latestOpenIn(path.posix.dirname(p));
        if (host) {
          key = host.key;
          target = host.target;
          real = false;
        }
      } else if (aliasPath(p) !== p) {
        target = { ...m.target, path: aliasPath(p) };
        key = `file:${target.path}`;
        real = false;
      }
      if (m.says === 'renamed' && m.detail && typeof m.detail.from === 'string') rename(`file:${m.detail.from}`, key, target);
    }
    let g = live.get(key);
    if (!g) {
      const f = forcedLast.get(key);
      forcedLast.delete(key);
      const continues = f && (f.held || now - f.at < quiet) ? f.id : null;
      g = { n: ++made, id: id(made), key, state: 'open', target, seqs: [], says: [], real: [], realSays: [], first: now, last: now, settledAt: null, sealedAt: null, forced: false, continues, isCommand: key.startsWith('command:'), isTurn: key.startsWith('turn:'), turnEnded: false };
      live.set(key, g);
      unsealed.set(g.id, g);
      all.push(g);
    } else if (g.state === 'settled') {
      g.state = 'open';
      g.settledAt = null;
    }
    g.seqs.push(m.seq);
    g.says.push(m.says);
    g.real.push(real);
    if (real) g.realSays.push(m.says);
    g.last = now;
    if (m.says === 'ended' && m.target && m.target.kind === 'turn') g.turnEnded = true;
    return out;
  }

  const end = () => all.filter((g) => g.state !== 'sealed').map(record);

  return { push, end };
}

module.exports = { createOpon, actionOf };
