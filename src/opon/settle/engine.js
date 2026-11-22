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
 * path's (merged with it if it has one).
 *
 * Folders fold down (rule 6, LD156): a folder's own change on disk joins the
 * earliest-opened open file group beneath it; with none, it waits in a group
 * of its own, which the first file group to open beneath it takes in. A
 * folder's marks never count for the action. A folder keeps its own group only
 * when nothing beneath it changed while it was open (created or deleted while
 * empty, as the brief says, or a lone change: kept, never dropped). Delete then
 * recreate inside one window is `modified` (rule 5): the action reads whether
 * the target existed before its first change and after its last.
 *
 * Late marks (rule 8, LD157): a sealed group never changes. A mark for a
 * target whose last group is sealed is late for it when it carries a tool
 * call id that group has, or was itself observed (its own mono_ns) at or
 * before the seal: it opens a new group whose `amends` names the sealed one.
 * Any other mark for that target is a new event.
 *
 * Witness status (G1, LD158; line 331): every group names both witnesses.
 * `saw` lists that witness's own mark_seqs, its verbs (`says`) and each mark's
 * key slots (exit_status, read_kind, result, fingerprints); the Glove is the
 * `hook` and `agent_claim` marks, the Sentinel the `sentinel` marks. A witness
 * with no marks is, from recorded facts only: for the Sentinel, `out_of_scope`
 * when the group is no disk event (`not_a_disk_event`), its path is outside the
 * project (`outside_root`) or among the header's exclusions (`excluded`); for
 * either, `down` when a recorded gap covers the group's time (the intake's
 * downtime for both, a Sentinel watch gap for the Sentinel, any other capture
 * gap for the Glove); otherwise `saw_nothing`, which does not say it was
 * healthy. A gap is taken into account before time moves on, so a group it
 * covers knows it before it seals.
 *
 * Parents and children (station 3, G2, LD159; test 2): a file change no Glove
 * mark made (the Sentinel's), observed while exactly one command is running
 * (between its `started` and its exit), becomes that command's child
 * (`parent_id`, the parent's `children`). With two or more running, it has no
 * parent: who made it is attribution's question (Phase 3). A Glove edit
 * joining a child ties it to a direct edit tool call and detaches it. A child
 * is held while its parent runs, then waits one quiet window after the exit;
 * a parent settles only once it has exited and every child has settled, at the
 * later of the two moments (groups with children are settled after the rest
 * at each step, so the moment is event time, not the order of a loop). A mark for a settled group (in its
 * grace) joins it and opens it again, its timer restarted: the grace is there
 * for a slow source's marks of the same event. A sealed group is never
 * reopened (rule 8, slice S6). Ticks only move time.
 *
 * Group records (LD142) use the odù's field names where they apply, and are
 * not odù records: no net change, attribution, confidence or conflicts yet.
 */

const path = require('path');
const { keyOf, aliasPath } = require('../group/keys');
const { isIgnored } = require('../../capture/fs-sentinel/ignore');

const NS_PER_MS = 1000000n;
const DISK = new Set(['created', 'modified', 'deleted', 'renamed']);
const GLOVE = new Set(['hook', 'agent_claim']);
const SLOTS = ['exit_status', 'read_kind', 'result', 'fingerprint_before', 'fingerprint'];

/** A mark's key detail slots, for its witness's `slots`. */
function slotsOf(m) {
  const out = { seq: m.seq };
  const d = m.detail && typeof m.detail === 'object' ? m.detail : {};
  for (const k of SLOTS) if (k in d) out[k] = d[k];
  return out;
}

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
  const sealedLast = new Map(); // key -> { id, at, causes }: the key's last sealed group (rule 8)
  const gaps = []; // { from, to, who: 'both' | 'sentinel' | 'glove' } (G1)
  const exclusions = Array.isArray(config.exclusions) ? config.exclusions : [];
  const all = [];
  let now = null;
  let made = 0;

  const id = (n) => `g_${String(n).padStart(4, '0')}`;

  /** Why a group may not settle yet (rule 3): 'process', 'turn' or null. */
  function holdOf(g) {
    if (g.parentId !== null) {
      const p = unsealed.get(g.parentId);
      if (p && holdOf(p) === 'process') return 'process'; // a child of a running command (G2)
    }
    if (g.isCommand && g.says.includes('started') && !g.says.some((v) => v === 'exited' || v === 'ended')) return 'process';
    if (g.isTurn && !g.turnEnded) return 'turn';
    return null;
  }

  function witness(g, name) {
    const mine = g.sources.map((s, i) => (name === 'glove' ? GLOVE.has(s) : s === 'sentinel') ? i : -1).filter((i) => i >= 0);
    if (mine.length) return { status: 'saw', mark_seqs: mine.map((i) => g.seqs[i]), says: mine.map((i) => g.says[i]), slots: mine.map((i) => g.slots[i]) };
    const disk = (g.key.startsWith('file:') || g.key.startsWith('dirchange:')) && g.says.some((v) => DISK.has(v));
    if (name === 'sentinel') {
      if (!disk) return { status: 'out_of_scope', scope: 'not_a_disk_event' };
      if (g.target && g.target.outside) return { status: 'out_of_scope', scope: 'outside_root' };
      if (g.target && isIgnored(g.target.path, exclusions)) return { status: 'out_of_scope', scope: 'excluded' };
    }
    if (gaps.some((x) => (x.who === 'both' || x.who === name) && x.from <= g.last && x.to >= g.first)) return { status: 'down' };
    return { status: 'saw_nothing' };
  }

  /** A gap mark's cover (G1): the intake's downtime (both), a Sentinel watch gap, or another capture gap (the Glove). */
  function registerGap(m) {
    const d = m.detail && typeof m.detail === 'object' ? m.detail : {};
    const seen = BigInt(m.mono_ns);
    const from = d.since && d.since.mono_ns ? BigInt(d.since.mono_ns) : seen;
    const to = d.until && d.until.mono_ns ? BigInt(d.until.mono_ns) : seen;
    gaps.push({ from, to, who: d.since ? 'both' : d.root ? 'sentinel' : 'glove' });
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
      witness_status: { glove: witness(g, 'glove'), sentinel: witness(g, 'sentinel') },
      parent_id: g.parentId,
      children: [...g.childIds],
      amends: g.amends,
      continues: g.continues,
    };
  }

  function advance(t) {
    const sealed = [];
    const parentsLast = [...unsealed.values()].sort((a, b) => (a.childIds.length > 0) - (b.childIds.length > 0) || a.n - b.n);
    for (const g of parentsLast) {
      if (g.state === 'open') {
        const hold = holdOf(g);
        const parent = g.parentId !== null ? unsealed.get(g.parentId) : null;
        const from = parent && parent.exitAt !== null && parent.exitAt > g.last ? parent.exitAt : g.last; // a child waits from its parent's exit
        let byQuiet = hold ? null : from + quiet;
        if (byQuiet !== null && g.childIds.length) {
          // A parent settles only once every child has settled, at the later moment (G2).
          const kids = g.childIds.map((c) => unsealed.get(c)).filter(Boolean);
          if (kids.some((k) => k.state === 'open')) byQuiet = null;
          else for (const k of kids) if (k.settledAt > byQuiet) byQuiet = k.settledAt;
        }
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
      sealedLast.set(g.key, { id: g.id, at: g.sealedAt, causes: g.causes });
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

  /** The open file group beneath folder `dir` that opened first (rule 6), or null. */
  function firstOpenUnder(dir) {
    let best = null;
    for (const g of live.values()) {
      if (g.state !== 'open' || !g.key.startsWith('file:') || !g.target.path.startsWith(dir === '.' ? '' : dir + '/')) continue;
      if (!best || g.n < best.n) best = g;
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
    absorb(b, a, null);
  }

  /** Group `a`'s marks go into `b` (their `real` flags kept, or set to `asReal`), and `a` is gone. */
  function absorb(b, a, asReal) {
    const realOf = (x, i) => (asReal === null ? x.real[i] : asReal);
    const rows = [...a.seqs.map((s, i) => [s, a.says[i], realOf(a, i), a.sources[i], a.slots[i]]), ...b.seqs.map((s, i) => [s, b.says[i], b.real[i], b.sources[i], b.slots[i]])].sort((x, y) => x[0] - y[0]);
    b.seqs = rows.map((r) => r[0]);
    b.says = rows.map((r) => r[1]);
    b.real = rows.map((r) => r[2]);
    b.realSays = rows.filter((r) => r[2]).map((r) => r[1]);
    b.sources = rows.map((r) => r[3]);
    b.slots = rows.map((r) => r[4]);
    for (const c of a.causes) b.causes.add(c);
    if (a.first < b.first) b.first = a.first;
    if (a.last > b.last) b.last = a.last;
    unsealed.delete(a.id);
    all.splice(all.indexOf(a), 1);
  }

  function push(m) {
    const t = BigInt(m.mono_ns);
    now = now === null || t > now ? t : now;
    if (m.says === 'gap') registerGap(m); // before time moves on: a group it covers knows before it seals
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
    } else if (key.startsWith('dirchange:')) {
      // Rule 6: a folder's change joins a file change beneath it.
      const host = firstOpenUnder(m.target.path);
      if (host) {
        key = host.key;
        target = host.target;
        real = false;
      }
    }
    let g = live.get(key);
    if (!g) {
      const f = forcedLast.get(key);
      forcedLast.delete(key);
      const continues = f && (f.held || now - f.at < quiet) ? f.id : null;
      const s = sealedLast.get(key);
      const amends = s && ((m.cause_hint && s.causes.has(m.cause_hint)) || BigInt(m.mono_ns) <= s.at) ? s.id : null;
      g = { n: ++made, id: id(made), key, state: 'open', parentId: null, childIds: [], startAt: null, exitAt: null, target, seqs: [], says: [], real: [], realSays: [], sources: [], slots: [], first: now, last: now, settledAt: null, sealedAt: null, forced: false, continues, amends, causes: new Set(), isCommand: key.startsWith('command:'), isTurn: key.startsWith('turn:'), turnEnded: false };
      live.set(key, g);
      unsealed.set(g.id, g);
      all.push(g);
      if (key.startsWith('file:') && !GLOVE.has(m.source)) {
        // G2: a change no Glove mark made, while exactly one command runs, is that command's child.
        const seen = BigInt(m.mono_ns);
        const running = [...unsealed.values()].filter((c) => c.isCommand && c.startAt !== null && c.startAt <= seen && (c.exitAt === null || seen <= c.exitAt));
        if (running.length === 1) {
          g.parentId = running[0].id;
          running[0].childIds.push(g.id);
        }
      }
      if (key.startsWith('file:')) {
        // Rule 6: a folder change still waiting above this file folds into it.
        for (const d of [...live.values()]) {
          if (d.state === 'open' && d.key.startsWith('dirchange:') && target.path.startsWith(d.target.path === '.' ? '' : d.target.path + '/')) {
            live.delete(d.key);
            absorb(g, d, false);
          }
        }
      }
    } else if (g.state === 'settled') {
      g.state = 'open';
      g.settledAt = null;
    }
    g.seqs.push(m.seq);
    g.says.push(m.says);
    g.real.push(real);
    g.sources.push(m.source);
    g.slots.push(slotsOf(m));
    if (m.cause_hint) g.causes.add(m.cause_hint);
    if (real) g.realSays.push(m.says);
    g.last = now;
    if (m.says === 'ended' && m.target && m.target.kind === 'turn') g.turnEnded = true;
    if (g.isCommand && m.says === 'started' && g.startAt === null) g.startAt = now;
    if (g.isCommand && (m.says === 'exited' || m.says === 'ended')) g.exitAt = now;
    if (g.parentId !== null && GLOVE.has(m.source) && m.cause_hint) {
      // G2: a Glove edit ties this change to a direct edit tool call: not the command's child.
      const p = unsealed.get(g.parentId);
      if (p) p.childIds = p.childIds.filter((c) => c !== g.id);
      g.parentId = null;
    }
    return out;
  }

  const end = () => all.filter((g) => g.state !== 'sealed').map(record);

  return { push, end };
}

module.exports = { createOpon, actionOf };
