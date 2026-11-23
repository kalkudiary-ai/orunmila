'use strict';

/**
 * src/opon/settle/engine.js — the Ọpọ́n's event-time engine, stations 2-3
 * (brief v4 lines 355-379; Phase 2; slice R1: rules 1 and 7). Plain,
 * deterministic code (guarantee 8): marks in, group records out, nothing read
 * from disk or the clock.
 *
 *   createOpon({ sessionId, config, baseline?, byproducts?, root?, others? })
 *                 config from the session header (test 35); baseline: path ->
 *                 fingerprint (null for a link or other non-file) from the
 *                 snapshot beside the log, or null; byproducts: the header's
 *                 list (A1a), or null; root: the header's project_root; others:
 *                 the other sessions' spans (src/opon/intake/overlap.js
 *                 spanOf), or null when none are known (A2)
 *     .push(mark)   one mark, in seq order; returns the records it sealed
 *     .end()        the groups not yet sealed, in the order they opened, as
 *                   they stand (the closeout's force-settle is Phase 4)
 *     .fingerprintsDue()  the paths of the file changes that settled since
 *                   the last call, inside the root and not excluded, each due
 *                   a `fingerprinted` mark (L1b, LD200); a group asks again only
 *                   after a mark other than its own fingerprint
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
 * A group with a Glove tool call in flight (its `started`, no outcome yet)
 * waits too, so the call is judged by the end of its turn (line 439; slice C3b,
 * LD189): until the call's outcome, its turn's `ended`, the session's `ended`, or
 * the intake's downtime from after it started; the ceiling never cuts that
 * wait, and restarts at its end if the wait outlasted it. A group whose wait
 * ended with no mark of its own waits one quiet window from that moment. A
 * running command's wait ends the same way, its exit then lost (as G3).
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
 * at each step, so the moment is event time, not the order of a loop).
 *
 * A command whose exit was lost (G3, LD160; found replaying a real session):
 * the intake's downtime gap that begins after a command started, with no exit
 * recorded yet, may have swallowed the exit (line 439: outcome missing, a gap
 * covers it). From the gap's start the command is no longer counted as
 * running: its hold ends, its group settles, and it takes no later children. A mark for a settled group (in its
 * grace) joins it and opens it again, its timer restarted: the grace is there
 * for a slow source's marks of the same event. A sealed group is never
 * reopened (rule 8, slice S6). Ticks only move time.
 *
 * Net change (station 4, slice N2, LD171; lines 381-390): the intake writes a
 * `fingerprinted` mark when a group settles (source process; detail.exists, and
 * for a file that exists its size and fingerprint). It joins its key's group
 * (one the ceiling settled too) and never moves its clock, so the group settles
 * and seals when it would have without it; it never counts for the action. A
 * file group with a change on disk seals with `net_change`: `before` is the
 * target's state at its last sealed group, else the baseline's (a path the
 * baseline does not list is `absent`; a path outside the root or among the
 * header's exclusions, a link, or no baseline, is null); `after` is the group's
 * latest fingerprinted mark, if no other mark came after it, else null; each is
 * a fingerprint, `absent`, or null for unknown, and `changed` compares them
 * when both are known (null otherwise). A rename leaves its old path absent
 * (once any group of that path still in its grace has sealed: N2b, LD173).
 * Groups of marks that change nothing on disk leave `net_change` out (line 389).
 *
 * Attribution (station 5, slice A1b, LD176; lines 392-400, 413): when a group
 * seals it gets exactly one label and its `cause`, by the brief's steps in
 * order. For a change on disk: (1) a Glove outcome mark that changes a file
 * (created, modified, deleted) carrying its tool call id: `agent_tool_call`;
 * (2) every Sentinel mark of the file's change seen inside the recorded start
 * and end of a Glove tool call on that path: `time_match` (a call with no end
 * recorded cannot show "inside"); (3) an agent command running when the change
 * was first seen (G2's test): `agent_command`; (4) the path matching an entry
 * of the header's byproducts list (`createOpon`'s `byproducts`; with none, null,
 * step 4 has nothing to match; never for a path outside the root):
 * `byproduct`, its `ref` the entry; (5) else `unexplained`, cause null. For
 * marks that change nothing: a tool call with an outcome mark is explained by
 * its own call, a turn by its turn, the session's end by the session; anything
 * else is unexplained. When several tool calls qualify at one step, `ref` is
 * the first and `also` names the rest.
 *
 * Overlapping sessions (slice A2, LD179-LD181; lines 402-407): when another
 * session sharing this folder (overlap.js `concurrent`) was active at the
 * change's first sighting, only steps 1 and 4 credit; otherwise the change is
 * unexplained with a `concurrent_sessions` conflict naming every session active
 * then, this one included (LD180). Its `not_credited` then also names a tool
 * call the change fell `inside` and the commands running at it
 * (`while_running`): the agent was there, and so was another session.
 *
 * What was not credited (slice A1c, LD178): an unexplained change on disk
 * lists the agent activity beside it that the steps did not credit, from
 * recorded facts, so "unexplained" never hides that the agent was there. Each
 * Glove tool call with marks in the group: its verbs, and where the change was
 * seen against the call's recorded start and end (`after_end`, `before_start`
 * with `gap_ms`; `no_start`, `no_end`, `partly_inside`; null with no Sentinel
 * sighting). Each agent command that exited within one quiet window before the
 * change was first seen: `after_exit`, `gap_ms`. The label never changes.
 *
 * Confidence (station 6, slice C1, LD185; lines 419-427): read from the cause
 * and the sources of the marks behind the group, never lowered because one
 * witness recorded nothing (`confidenceOf`).
 *
 * Conflicts (station 6, slice C3a, LD188; lines 328, 411, 438): every sealed
 * group carries `conflicts`, empty when there is none; each names the sources
 * that bear on it and what each said (`sources`, `said`). Station 5 gives
 * `concurrent_sessions`; `conflictsOf` gives `unconfirmed_by_filesystem` (not
 * for a late edit of a call whose earlier odù, the one it amends, the Sentinel
 * or git saw change: C3a2, LD190), `contradiction` (C3e, LD199) when the Glove's
 * and the Sentinel's own marks of a file disagree on whether it is there at the
 * end, neither holding the other's account (one saw more: a sequence), and
 * `outcome_missing` (C3b, LD189) for each call with a `started` mark in the
 * group and no outcome when it seals, or an outcome its payload says was
 * interrupted: `ref` the call, `why` interrupted, gap (a Glove or intake capture
 * gap covers the call's wait) or null.
 *
 * Phantom command claims (C3c, LD191; lines 431, 433, 441; tests 4b, 39): when
 * the group holding a `claimed` mark seals, each command claim C2 reads in it
 * (`claimsOf`) is checked against its turn's runs: for a claim about tests,
 * its test runs (facts.js `isTestRun`); for any other, every command of the
 * turn. A run's status is the gate from marks' (receipts.js): a pass through
 * an unguarded pipe is `unknown`. Backed when the last run that settled
 * passed; otherwise the claim is its own sealed record (`target.kind` claim)
 * with a `phantom_claim` conflict (`why`: no_command, failed, unknown; the
 * `runs` cited), high only when the Glove was healthy (line 352) and the
 * claim had no run or the run failed, else low. Phantom file claims are
 * C3d1's (`fileVerdict`).
 *
 * Silent change (C3d2, LD194; lines 324, 369, 434; test 5): a change of a file
 * whose net change is not false and whose cause is the agent's (steps 1-3),
 * naming calls of a turn, is judged against that turn's claims, so its seal
 * waits, settled, until each such turn is over (its `ended`, the session's
 * `ended`, or the intake's downtime from after the turn began, as C3b). It is
 * closed when it would have sealed: decided, its record fixed, a later mark of
 * its target a new group, as after a seal; only the seal waits. A group whose
 * `amends` or `continues` names a waiting one waits for it, so those still name
 * an earlier odù (a parent's `children` may name later ones, as before). At its
 * seal, when its turns' confirmed claims were read and none mentions its path
 * (claims.js `mentionsOf`, matched as file claims are), it gets
 * `silent_change`: `turns`, `claim_seqs` (the claims read), and `agent_claim`
 * among its sources, having said nothing of it. No claim read: no verdict.
 *
 * Group records (LD142) use the odù's field names where they apply, and are
 * not odù records.
 */

const path = require('path');
const { keyOf, aliasPath } = require('../group/keys');
const { isIgnored } = require('../../capture/fs-sentinel/ignore');
const { concurrent } = require('../intake/overlap');
const { claimsOf, mentionsOf } = require('../corroborate/claims');
const { isTestRun } = require('../../laws/facts');
const { hasUnguardedPipe } = require('../../laws/evaluate');

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

/** A fingerprinted mark's state of its target: a fingerprint, 'absent', or null for unknown (N2). */
function fingerprintedState(m) {
  const d = m.detail && typeof m.detail === 'object' ? m.detail : {};
  if (d.exists === false) return 'absent';
  return d.exists === true && typeof d.fingerprint === 'string' ? d.fingerprint : null;
}

/** A label with a cause of `kind`: the first id its `ref`, any others in `also` (A1b). */
function explained(kind, ids) {
  return { attribution: 'explained', cause: ids.length > 1 ? { kind, ref: ids[0], also: ids.slice(1) } : { kind, ref: ids[0] } };
}
const UNEXPLAINED = { attribution: 'unexplained', cause: null };
/** A conflict's copy, its lists copied too (C3a). */
const copyConflict = (c) => ({ ...c, sources: [...c.sources], said: Object.fromEntries(Object.entries(c.said).map(([k, v]) => [k, [...v]])), ...(c.sessions ? { sessions: [...c.sessions] } : {}) });
const CHANGES_A_FILE = new Set(['created', 'modified', 'deleted']);
const AGENT_CAUSES = new Set(['agent_tool_call', 'time_match', 'agent_command']); // station 5's credits to this session (C3d1)

function createOpon({ sessionId, config, baseline = null, byproducts = null, root = null, others = null }) {
  const quiet = BigInt(config.quiet_window_ms) * NS_PER_MS;
  const grace = BigInt(config.lag_grace_ms) * NS_PER_MS;
  const ceiling = BigInt(config.ceiling_ms) * NS_PER_MS;
  const live = new Map(); // key -> the group a new mark for it joins: open, or settled by quiet
  const unsealed = new Map(); // id -> group, in the order they opened
  const forcedLast = new Map(); // key -> { id, at }: the last group of the key force-settled at its ceiling
  const sealedLast = new Map(); // key -> { id, at, causes }: the key's last sealed group (rule 8)
  const gaps = []; // { from, to, who: 'both' | 'sentinel' | 'glove' } (G1)
  const lastState = new Map(); // key -> the target's state at its last sealed group, or after a rename (N2)
  const calls = new Map(); // tool call id -> { keys, start, end }: the Glove's tool calls on files, for step 2 (A1b)
  const inFlight = new Map(); // tool call id -> { turn, start, done, interrupted, end }: every Glove call, for its outcome (C3b)
  const claimsAt = new Map(); // a claimed mark's seq -> { turn, row, claims }: its command claims (C3c)
  const commandsOf = new Map(); // turn -> Map(call id -> { ref, text, rows, outcome }): the turn's commands, for its claims (C3c)
  const turnsSeen = new Set(); // turns with an agent's own Glove mark, and the turns that ended: the Glove's health (line 352; C3c)
  const turnsEnded = new Set();
  const changes = []; // { path, first, attr, changed, rows, sessions }: each sealed change on disk, for file claims (C3d1)
  const callTurn = new Map(); // tool call id -> the turn its Glove marks name (C3d1)
  const turnStart = new Map(); // turn -> when its first Glove mark came (C3d1)
  let hooksChanged = false; // the agent's hook settings changed: the Glove down from then (line 352)
  const turnOver = new Map(); // turn -> when it was over: its `ended`, or the intake's downtime (C3d2)
  let sessionOver = null; // when the session's `ended` came: every turn over from then (C3d2)
  const heard = new Map(); // turn -> [{ seq, paths }]: its confirmed claimed marks and the paths they mention (C3d2)
  const waiting = []; // closed groups whose seal waits for their turns or a group they name, in the order they closed (C3d2)
  const freedAt = new Map(); // a waiting group's id -> when it sealed (C3d2)
  const exclusions = Array.isArray(config.exclusions) ? config.exclusions : [];
  const due = []; // L1b: the paths of settled file changes due a fingerprint, in the order they settled
  const all = [];
  let now = null;
  let made = 0;

  const id = (n) => `g_${String(n).padStart(4, '0')}`;

  /** The Glove tool calls with a `started` mark in group g, in seq order (C3b). */
  const startedIn = (g) => [...new Set(g.hints.filter((h, i) => h && g.says[i] === 'started' && GLOVE.has(g.sources[i])))];
  /** C3b (LD189): the latest moment a call of g stopped waiting (its outcome, its turn's end, a gap), or null. */
  function releaseOf(g) {
    let r = null;
    for (const id of startedIn(g)) {
      const e = inFlight.get(id).end;
      if (e !== null && (r === null || e > r)) r = e;
    }
    return r;
  }

  /** Why a group may not settle yet (rule 3; C3b): 'process', 'call', 'turn' or null. */
  function holdOf(g) {
    if (g.parentId !== null) {
      const p = unsealed.get(g.parentId);
      if (p && holdOf(p) === 'process') return 'process'; // a child of a running command (G2)
    }
    if (g.isCommand && g.says.includes('started') && !g.says.some((v) => v === 'exited' || v === 'ended') && !g.lost) return 'process';
    if (startedIn(g).some((id) => inFlight.get(id).end === null)) return 'call'; // line 439: judged by the end of its turn
    if (g.isTurn && !g.turnEnded) return 'turn';
    return null;
  }

  /** C3b: the calls still waiting that `pred` picks stop waiting at `at`; a running command's exit is then lost (as G3). */
  function endCalls(pred, at) {
    for (const [id, t] of inFlight) {
      if (t.start === null || t.end !== null || !pred(t)) continue;
      t.end = at;
      for (const c of unsealed.values()) {
        if (c.key === `command:${id}` && c.exitAt === null) {
          c.lost = true;
          c.exitAt = at;
        }
      }
    }
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
    const who = d.since ? 'both' : d.root ? 'sentinel' : 'glove';
    gaps.push({ from, to, who });
    if (who === 'both') {
      // G3, C3b: a call started before the intake's downtime with no outcome yet may have lost it; a command's exit so (endCalls; G3b, LD205).
      endCalls((t) => t.start <= from, from);
      for (const [t, at] of turnStart) if (at <= from && !turnOver.has(t)) turnOver.set(t, from); // C3d2: and any turn's end
    }
  }

  /** The target's state before a group (N2): its last sealed group's after, else the baseline's. */
  function stateBefore(g) {
    if (lastState.has(g.key)) return lastState.get(g.key);
    const t = g.target;
    if (!baseline || !t || t.outside || isIgnored(t.path, exclusions)) return null;
    return baseline.has(t.path) ? baseline.get(t.path) : 'absent';
  }

  /** A sealed group's net change, or undefined for marks that change nothing on disk (line 389). */
  function netChange(g) {
    if (!g.key.startsWith('file:') || !g.says.some((v) => DISK.has(v))) return undefined;
    const before = stateBefore(g);
    const after = g.fp && g.fp.seq > g.lastOther ? g.fp.state : null;
    lastState.set(g.key, g.renamedAway ? 'absent' : after);
    return { before, after, changed: before === null || after === null ? null : before !== after };
  }

  /** The agent commands running at `seen` (G2's test), in the order they opened. */
  function runningAt(seen) {
    return [...unsealed.values()].filter((c) => c.isCommand && c.startAt !== null && c.startAt <= seen && (c.exitAt === null || seen <= c.exitAt));
  }

  /** C3a (LD188): a conflict naming the sources that bear on it and what each said, in seq order (`[]`: nothing). */
  function conflictOf(g, kind, sources, extra = {}) {
    const names = [...new Set(sources)].sort();
    const said = {};
    for (const s of names) said[s] = g.says.filter((v, i) => g.sources[i] === s);
    return { kind, sources: names, said, ...extra };
  }

  /**
   * Station 6's conflicts beside station 5's (C3a, LD188; lines 411, 438): a Glove edit of a file that no
   * Sentinel or git mark shows, while the Sentinel's status is `saw_nothing` (inside the root, not
   * excluded, no gap covering it), is `unconfirmed_by_filesystem`. Down or out of scope: no conflict.
   */
  function conflictsOf(g) {
    const out = [];
    const gloveEdit = g.says.some((v, i) => CHANGES_A_FILE.has(v) && g.sources[i] === 'hook');
    // C3a2 (LD190): a late edit of a call whose earlier odù the Sentinel or git saw change was seen, in the odù it amends.
    const seenBefore = g.amended && g.amended.seen && g.hints.some((h, i) => h && CHANGES_A_FILE.has(g.says[i]) && g.sources[i] === 'hook' && g.amended.causes.has(h));
    if (g.key.startsWith('file:') && gloveEdit && !seenBefore && !g.sources.includes('git') && witness(g, 'sentinel').status === 'saw_nothing') out.push(conflictOf(g, 'unconfirmed_by_filesystem', ['hook', 'sentinel']));
    // C3e (LD199; line 435): the witnesses' own marks of the file end it apart, one only there, the other only gone; an account holding the other's is a sequence.
    const ends = (s) => new Set(g.says.filter((v, i) => g.real[i] && g.sources[i] === s && DISK.has(v)).map((v) => v === 'deleted'));
    const [hookEnds, sentinelEnds] = [ends('hook'), ends('sentinel')];
    if (g.key.startsWith('file:') && hookEnds.size && sentinelEnds.size && ![...hookEnds].some((e) => sentinelEnds.has(e))) out.push(conflictOf(g, 'contradiction', ['hook', 'sentinel']));
    // C3b (LD189; line 439, test 71): a started call with no outcome by the end of its turn, or one its payload says was interrupted.
    for (const id of startedIn(g)) {
      const t = inFlight.get(id);
      const covered = gaps.some((x) => (x.who === 'both' || x.who === 'glove') && x.from <= t.end && x.to >= t.start);
      const why = t.done ? (t.interrupted ? 'interrupted' : undefined) : covered ? 'gap' : null;
      if (why !== undefined) out.push(conflictOf(g, 'outcome_missing', g.sources, { ref: id, why }));
    }
    return out;
  }

  /** Line 352 (C3c, C3c2): the Glove was healthy up to `at`: no capture gap covering it, its hook settings unchanged, every turn begun by `by` ended. */
  const gloveHealthy = (at, by) => !hooksChanged && !gaps.some((x) => (x.who === 'both' || x.who === 'glove') && x.from <= at) && [...turnsSeen].every((t) => turnsEnded.has(t) || turnStart.get(t) > by);
  /** C3c (LD191): a run's status as the gate from marks reads it (receipts.js); a pass through an unguarded pipe is unknown (line 433). */
  const piped = (r) => r.outcome !== null && r.outcome.status === 'pass' && hasUnguardedPipe(r.text);
  const runStatus = (r) => (r.outcome === null || piped(r) || !['pass', 'fail'].includes(r.outcome.status) ? 'unknown' : r.outcome.status);

  /** C3c, C3d1: a claim's own sealed record (line 431): its claimed mark and the marks it cites, explained by its turn. */
  function claimRecord(g, at, c, cited, confidence, conflictsFor) {
    const rows = [...new Map([at.row, ...cited].map((r) => [r.seq, r])).values()].sort((a, b) => a.seq - b.seq);
    const cg = { id: id(++made), key: `claim:${at.row.seq}`, state: 'sealed', target: { kind: 'claim', turn: at.turn, text: c.text }, seqs: rows.map((r) => r.seq), says: rows.map((r) => r.says), realSays: ['claimed'], sources: rows.map((r) => r.source), slots: rows.map((r) => r.slot), hints: rows.map((r) => r.hint), first: g.first, last: g.last, settledAt: g.settledAt, sealedAt: g.sealedAt, forced: false, parentId: null, childIds: [], amends: null, continues: null, net: undefined, notCredited: undefined };
    cg.attr = { attribution: 'explained', cause: { kind: 'turn', ref: at.turn } }; // line 413: made in its turn
    cg.confidence = confidence;
    cg.conflicts = conflictsFor(cg);
    return record(cg);
  }

  /** C3d1 (LD192 (2)): a path as the agent wrote it, made comparable with targets: less a leading ./, an absolute path under the root relative. */
  function asWritten(w) {
    let p = w.replace(/^\.\//, '');
    if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1);
    return p;
  }
  /** C3d1: target path `t` is the path written as `p`, or ends with `/` and it (a bare name matches every file of that name). */
  const named = (t, p) => typeof t === 'string' && (t === p || t.endsWith('/' + p));

  /** C3d2 (LD194): when turn `t` was over, or null while it runs. */
  const overAt = (t) => (turnOver.has(t) ? turnOver.get(t) : sessionOver);
  /** C3d2 (LD194; line 434): the turns whose claims judge group g: those its cause's calls name, for an agent-caused change of a file not shown unchanged. */
  function turnsOf(g) {
    const c = g.attr.cause;
    if (!g.key.startsWith('file:') || g.net === undefined || g.net.changed === false || !c || !AGENT_CAUSES.has(c.kind)) return [];
    return [...new Set([c.ref, ...(c.also || [])].map((h) => callTurn.get(h)).filter(Boolean))].sort();
  }
  /** C3d2 (LD194; line 434): a silent_change when its turns' confirmed claims were read and none mentions its path; else null. */
  function silentOf(g) {
    const read = g.judged.flatMap((t) => heard.get(t) || []);
    if (!read.length || read.some((c) => c.paths.some((w) => named(g.target.path, asWritten(w))))) return null;
    return conflictOf(g, 'silent_change', [...g.sources, 'agent_claim'], { turns: [...g.judged], claim_seqs: read.map((c) => c.seq).sort((a, b) => a - b) });
  }

  /**
   * C3d1 (LD192; lines 406, 432): what backs a file claim of `turn` written as `w`, or null when it is backed: a
   * change on a matching path credited to a call of this turn, its net change not false, or one still settling.
   * Else `unchanged` (every such change has a net change of false), `not_credited` (a change seen in the turn's
   * time that this session's steps did not credit), `no_event`; with the changes cited and their overlap's sessions.
   */
  function fileVerdict(turn, w) {
    const p = asWritten(w);
    const matches = (t) => named(t, p);
    const ofTurn = (h) => Boolean(h) && callTurn.get(h) === turn;
    if ([...unsealed.values()].some((u) => u.key.startsWith('file:') && matches(u.target.path) && u.hints.some((h, i) => ofTurn(h) && u.sources[i] === 'hook' && CHANGES_A_FILE.has(u.says[i])))) return null;
    const seen = changes.filter((ch) => matches(ch.path));
    const mine = seen.filter((ch) => ch.attr.cause && AGENT_CAUSES.has(ch.attr.cause.kind) && [ch.attr.cause.ref, ...(ch.attr.cause.also || [])].some(ofTurn));
    if (mine.some((ch) => ch.changed !== false)) return null;
    const others = seen.filter((ch) => !mine.includes(ch) && turnStart.has(turn) && ch.first >= turnStart.get(turn));
    const why = mine.length ? 'unchanged' : others.length ? 'not_credited' : 'no_event';
    const cited = why === 'unchanged' ? mine : others;
    return { why, cited, sessions: [...new Set(cited.flatMap((ch) => ch.sessions))].sort() };
  }

  /** C3c (LD191; lines 431, 433, 441) and C3d1 (LD192): each claim of g's `claimed` marks the evidence does not back, as a sealed record of its own. */
  function phantomsOf(g) {
    const out = [];
    for (const [i, seq] of g.seqs.entries()) {
      const at = g.says[i] === 'claimed' ? claimsAt.get(seq) : undefined;
      for (const c of at ? at.claims : []) {
        if (c.commands.length) {
          const tests = c.commands.some((p) => /\b(?:tests?|tested|suites?|specs?)\b/.test(p));
          const runs = [...(commandsOf.get(at.turn) || new Map()).values()].filter((r) => !tests || isTestRun(r.text));
          let backed = null; // the last run that settled: true a pass, false a fail
          for (const r of runs) if (runStatus(r) !== 'unknown') backed = runStatus(r) === 'pass';
          if (backed !== true) {
            const why = !runs.length ? 'no_command' : backed === false ? 'failed' : 'unknown';
            const confidence = why !== 'unknown' && gloveHealthy(g.sealedAt, g.last) ? 'high' : 'low';
            const cited = runs.map((r) => ({ ref: r.ref, text: r.text, status: runStatus(r), ...(r.outcome && Number.isInteger(r.outcome.exit_code) ? { exit_code: r.outcome.exit_code } : {}), ...(piped(r) ? { piped: true } : {}) }));
            out.push(claimRecord(g, at, c, runs.flatMap((r) => r.rows), confidence, (cg) => [conflictOf(cg, 'phantom_claim', cg.sources, { claim: 'command', phrases: [...c.commands], hedged: c.hedged, why, runs: cited })]));
          }
        }
        for (const w of c.files) {
          const f = fileVerdict(at.turn, w);
          if (!f) continue;
          // Line 441: high only when git or the closeout rescan saw the target unchanged (Phase 4); a change that is not this session's: medium (test 38).
          const confidence = f.why === 'not_credited' ? 'medium' : 'low';
          const targets = [...new Set(f.cited.map((ch) => ch.path))].sort();
          out.push(claimRecord(g, at, c, f.cited.flatMap((ch) => ch.rows), confidence, (cg) => [conflictOf(cg, 'phantom_claim', cg.sources, { claim: 'file', path: w, hedged: c.hedged, why: f.why, targets }), ...(f.sessions.length ? [conflictOf(cg, 'concurrent_sessions', cg.sources, { sessions: f.sessions })] : [])]));
        }
      }
    }
    return out;
  }

  /** Station 5 (A1b): one label and its cause, by the brief's steps in order. */
  function attributionOf(g) {
    const glove = (keep) => [...new Set(g.hints.filter((h, i) => h && GLOVE.has(g.sources[i]) && keep(g.says[i])))];
    const disk = (g.key.startsWith('file:') || g.key.startsWith('dirchange:')) && g.says.some((v) => DISK.has(v));
    if (!disk) {
      if (g.key.startsWith('turn:')) return explained('turn', [g.key.slice('turn:'.length)]);
      if (g.key.startsWith('session:')) return explained('session', [g.key.slice('session:'.length)]);
      const own = glove((v) => v !== 'started');
      return own.length ? explained('agent_tool_call', own) : UNEXPLAINED;
    }
    const direct = glove((v) => CHANGES_A_FILE.has(v));
    if (direct.length) return explained('agent_tool_call', direct);
    const during = g.overlap && g.overlap.length > 0; // A2: only steps 1 and 4 credit (line 404)
    if (!during && g.changeSeen.length) {
      const lo = g.changeSeen.reduce((a, b) => (b < a ? b : a));
      const hi = g.changeSeen.reduce((a, b) => (b > a ? b : a));
      const inside = [...calls].filter(([, c]) => c.keys.has(g.key) && c.start !== null && c.end !== null && c.start <= lo && hi <= c.end).map(([id]) => id);
      if (inside.length) return explained('time_match', inside);
    }
    if (!during && g.atChange && g.atChange.length) return explained('agent_command', g.atChange);
    if (byproducts && g.target && !g.target.outside) {
      const entry = byproducts.find((e) => isIgnored(g.target.path, [e]));
      if (entry !== undefined) return { attribution: 'byproduct', cause: { kind: 'byproduct', ref: entry } };
    }
    if (during) return { ...UNEXPLAINED, conflicts: [conflictOf(g, 'concurrent_sessions', g.sources, { sessions: [...new Set([sessionId, ...g.overlap])].sort() })] };
    return UNEXPLAINED;
  }

  /**
   * Station 6's confidence (C1, LD185; lines 419-427): from the cause and the sources of the marks behind
   * the group, never from a witness's silence (line 427). Only a claim: low. A direct cause, a tool call's
   * own outcome, a turn, the session's end: high. A time match or a running command: medium. No agent
   * cause: a change on disk the Sentinel or git saw is high (certain, its label says unexplained or
   * byproduct), else medium; marks that change nothing are medium with a Glove mark in them (a call with
   * only `started`: line 423, "medium at most"), else high (Orunmila's own record: a gap, a note).
   */
  function confidenceOf(g, attr) {
    if (g.sources.every((s) => s === 'agent_claim')) return 'low';
    const kind = attr.cause && attr.cause.kind;
    if (kind === 'time_match' || kind === 'agent_command') return 'medium';
    if (kind && kind !== 'byproduct') return 'high';
    const disk = (g.key.startsWith('file:') || g.key.startsWith('dirchange:')) && g.says.some((v) => DISK.has(v));
    if (disk) return g.sources.some((s) => s === 'sentinel' || s === 'git') ? 'high' : 'medium';
    return g.sources.some((s) => GLOVE.has(s)) ? 'medium' : 'high';
  }

  /** A1c (LD178): the agent activity beside an unexplained change that the steps did not credit, or undefined. */
  function notCreditedOf(g) {
    const out = [];
    const seen = g.changeSeen;
    const lo = seen.length ? seen.reduce((a, b) => (b < a ? b : a)) : null;
    const hi = seen.length ? seen.reduce((a, b) => (b > a ? b : a)) : null;
    const ms = (ns) => Number(ns / NS_PER_MS);
    for (const ref of new Set(g.hints.filter((h, i) => h && GLOVE.has(g.sources[i])))) {
      const says = g.says.filter((v, i) => g.hints[i] === ref && GLOVE.has(g.sources[i]));
      const c = calls.get(ref);
      let rel = { seen: null };
      if (lo !== null && c) {
        if (c.end !== null && lo > c.end) rel = { seen: 'after_end', gap_ms: ms(lo - c.end) };
        else if (c.start !== null && hi < c.start) rel = { seen: 'before_start', gap_ms: ms(c.start - hi) };
        else if (c.start === null) rel = { seen: 'no_start' };
        else if (c.end === null) rel = { seen: 'no_end' };
        else if (c.start <= lo && hi <= c.end) rel = { seen: 'inside' }; // only while sessions overlap (A2)
        else rel = { seen: 'partly_inside' };
      }
      out.push({ kind: 'agent_tool_call', ref, says, ...rel });
    }
    for (const ref of g.overlap && g.overlap.length ? g.atChange || [] : []) out.push({ kind: 'agent_command', ref, seen: 'while_running' });
    for (const x of g.besideExit || []) out.push({ kind: 'agent_command', ref: x.ref, seen: 'after_exit', gap_ms: ms(x.gap) });
    return out.length ? out : undefined;
  }

  function record(g) {
    const net = g.net; // set when the group seals
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
      ...(net === undefined ? {} : { net_change: { ...net } }),
      ...(g.attr ? { attribution: g.attr.attribution, cause: g.attr.cause, confidence: g.confidence } : {}),
      ...(g.conflicts ? { conflicts: g.conflicts.map(copyConflict) } : {}),
      ...(g.notCredited ? { not_credited: g.notCredited.map((e) => ({ ...e, ...(e.says ? { says: [...e.says] } : {}) })) } : {}),
    };
  }

  function advance(t) {
    const sealed = [];
    const parentsLast = [...unsealed.values()].sort((a, b) => (a.childIds.length > 0) - (b.childIds.length > 0) || a.n - b.n);
    for (const g of parentsLast) {
      if (g.state === 'open') {
        const hold = holdOf(g);
        const parent = g.parentId !== null ? unsealed.get(g.parentId) : null;
        const fromMarks = parent && parent.exitAt !== null && parent.exitAt > g.last ? parent.exitAt : g.last; // a child waits from its parent's exit
        const released = releaseOf(g);
        const from = released !== null && released > fromMarks ? released : fromMarks; // C3b: and a call's group from its release
        let byQuiet = hold ? null : from + quiet;
        if (byQuiet !== null && g.childIds.length) {
          // A parent settles only once every child has settled, at the later moment (G2).
          const kids = g.childIds.map((c) => unsealed.get(c)).filter(Boolean);
          if (kids.some((k) => k.state === 'open')) byQuiet = null;
          else for (const k of kids) if (k.settledAt > byQuiet) byQuiet = k.settledAt;
        }
        // A command that was seen starting is held until it exits, never cut by the ceiling (rule 3); a call in
        // flight likewise until it stops waiting, and a wait that outlasted the ceiling restarts it (C3b, LD189).
        const cut = released !== null && released > g.first + ceiling ? released + ceiling : g.first + ceiling;
        const byCeiling = hold === 'call' || (g.isCommand && g.says.includes('started')) ? null : cut;
        const at = byQuiet === null ? byCeiling : byCeiling === null || byQuiet <= byCeiling ? byQuiet : byCeiling;
        if (at !== null && t >= at) {
          g.state = 'settled';
          g.settledAt = at;
          // L1b (LD200 (2); line 386): a change of a file inside the root, settled with a mark since it last asked, is due a fingerprint.
          if (g.key.startsWith('file:') && g.says.some((v) => DISK.has(v)) && !g.target.outside && !isIgnored(g.target.path, exclusions) && g.fpAsked !== g.lastOther) {
            g.fpAsked = g.lastOther;
            due.push(g.target.path);
          }
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
    const ready = [];
    for (const g of sealed) {
      close(g);
      // C3d2 (LD194): its seal waits while a turn that judges it runs, or an earlier odù it names waits.
      g.judged = turnsOf(g);
      g.after = [g.amends, g.continues].filter((x) => x !== null && waiting.some((w) => w.id === x));
      if (g.after.length || g.judged.some((x) => overAt(x) === null)) {
        g.sealedAt = null;
        waiting.push(g);
      } else ready.push(g);
    }
    // Sealed in event-time order; a group freed with one it names, at the same moment, after it (a stable sort).
    const freed = release();
    const out = [];
    while (ready.length || freed.length) out.push(...emit(!freed.length || (ready.length && ready[0].sealedAt <= freed[0].sealedAt) ? ready.shift() : freed.shift()));
    return out;
  }

  /** A group decided where it would have sealed (rule 7): stations 4-6, its record fixed; only its seal may wait (C3d2). */
  function close(g) {
    g.net = netChange(g);
    g.attr = attributionOf(g);
    g.confidence = confidenceOf(g, g.attr);
    g.conflicts = [...(g.attr.conflicts || []), ...conflictsOf(g)];
    const disk = (g.key.startsWith('file:') || g.key.startsWith('dirchange:')) && g.says.some((v) => DISK.has(v));
    g.notCredited = disk && g.attr.attribution === 'unexplained' ? notCreditedOf(g) : undefined;
    if (g.net !== undefined) changes.push({ path: g.target.path, first: g.first, attr: g.attr, changed: g.net.changed, rows: g.seqs.map((s, k) => ({ seq: s, says: g.says[k], source: g.sources[k], slot: g.slots[k], hint: g.hints[k] })), sessions: g.conflicts.filter((c) => c.kind === 'concurrent_sessions').flatMap((c) => c.sessions) }); // C3d1
    const seen = g.says.some((v, i) => DISK.has(v) && (g.sources[i] === 'sentinel' || g.sources[i] === 'git')); // C3a2
    sealedLast.set(g.key, { id: g.id, at: g.sealedAt, causes: g.causes, seen });
    if (live.get(g.key) === g) live.delete(g.key);
    unsealed.delete(g.id);
    g.extra = g.isTurn ? phantomsOf(g) : []; // C3c: a phantom claim right after the group holding it
    g.rec = record(g);
  }

  /** C3d2 (LD194): the waiting groups whose turns are over and whose named groups have sealed, each at the latest of those moments, in that order. */
  function release() {
    const freed = [];
    for (let moved = true; moved; ) {
      moved = false;
      for (const g of [...waiting]) {
        const overs = g.judged.map(overAt);
        if (overs.includes(null) || g.after.some((x) => waiting.some((w) => w.id === x))) continue;
        waiting.splice(waiting.indexOf(g), 1);
        g.sealedAt = [g.settledAt + grace, ...overs, ...g.after.map((x) => freedAt.get(x))].reduce((a, b) => (b > a ? b : a));
        freedAt.set(g.id, g.sealedAt);
        freed.push(g);
        moved = true;
      }
    }
    return freed.sort((a, b) => (a.sealedAt < b.sealedAt ? -1 : a.sealedAt > b.sealedAt ? 1 : 0));
  }

  /** A closed group sealed: its fixed record, with its silent-change verdict (C3d2), then any phantom claims it holds. */
  function emit(g) {
    g.state = 'sealed';
    const silent = g.judged.length ? silentOf(g) : null;
    if (silent) g.conflicts.push(silent);
    return [{ ...g.rec, state: 'sealed', sealed_at_ns: String(g.sealedAt), conflicts: g.conflicts.map(copyConflict) }, ...g.extra];
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
    // N2, N2b (LD173): nothing is at the old path after a rename. A group of it that the rename does not
    // move (settled, in its grace) keeps its own before and leaves the path absent when it seals.
    const waiting = [...unsealed.values()].filter((g) => g.key === fromKey && g.state !== 'open');
    for (const g of waiting) g.renamedAway = true;
    if (!waiting.length) lastState.set(fromKey, 'absent');
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
    const rows = [...a.seqs.map((s, i) => [s, a.says[i], realOf(a, i), a.sources[i], a.slots[i], a.hints[i]]), ...b.seqs.map((s, i) => [s, b.says[i], b.real[i], b.sources[i], b.slots[i], b.hints[i]])].sort((x, y) => x[0] - y[0]);
    b.seqs = rows.map((r) => r[0]);
    b.says = rows.map((r) => r[1]);
    b.real = rows.map((r) => r[2]);
    b.realSays = rows.filter((r) => r[2]).map((r) => r[1]);
    b.sources = rows.map((r) => r[3]);
    b.slots = rows.map((r) => r[4]);
    b.hints = rows.map((r) => r[5]);
    b.changeSeen = [...b.changeSeen, ...a.changeSeen];
    if (b.atChange === null) b.atChange = a.atChange;
    if (b.besideExit === null) b.besideExit = a.besideExit;
    if (b.overlap === null) b.overlap = a.overlap;
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
    const fingerprint = m.says === 'fingerprinted'; // N2: joins its group and never moves its clock, so it settles when it would have
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
    if (!g && fingerprint) {
      // A group the ceiling settled is out of `live`, but its fingerprint is still its own (N2).
      const f = forcedLast.get(key);
      if (f && unsealed.has(f.id)) g = unsealed.get(f.id);
    }
    if (!g) {
      const f = forcedLast.get(key);
      forcedLast.delete(key);
      const continues = f && (f.held || now - f.at < quiet) ? f.id : null;
      const s = sealedLast.get(key);
      const amends = s && ((m.cause_hint && s.causes.has(m.cause_hint)) || BigInt(m.mono_ns) <= s.at) ? s.id : null;
      const amended = amends ? s : null; // C3a2: what the odù it amends saw
      g = { n: ++made, id: id(made), key, state: 'open', parentId: null, childIds: [], startAt: null, exitAt: null, lost: false, target, seqs: [], says: [], real: [], realSays: [], sources: [], slots: [], first: now, last: now, settledAt: null, sealedAt: null, forced: false, continues, amends, amended, causes: new Set(), isCommand: key.startsWith('command:'), isTurn: key.startsWith('turn:'), turnEnded: false, fp: null, lastOther: 0, net: undefined, hints: [], changeSeen: [], atChange: null, besideExit: null, overlap: null, attr: null, confidence: null, conflicts: null, notCredited: undefined };
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
    if (fingerprint) {
      real = false;
      g.fp = { seq: m.seq, state: fingerprintedState(m) };
    } else g.lastOther = m.seq;
    g.seqs.push(m.seq);
    g.says.push(m.says);
    g.real.push(real);
    g.sources.push(m.source);
    g.slots.push(slotsOf(m));
    g.hints.push(m.cause_hint || null);
    if (DISK.has(m.says) && !GLOVE.has(m.source) && m.target && (m.target.kind === 'file' || m.target.kind === 'dir')) {
      // A1b: when the change was seen, for steps 2 (a file's own marks) and 3 (the commands running at its first).
      const seen = BigInt(m.mono_ns);
      if (m.target.kind === 'file') g.changeSeen.push(seen);
      if (g.atChange === null) {
        g.atChange = runningAt(seen).map((c) => c.key.slice('command:'.length));
        // A1c: the commands that exited within one quiet window before it, for an unexplained change's `not_credited`.
        // A2: the other sessions sharing this folder that were active when the change was first seen.
        g.overlap = others && root !== null ? concurrent(others, root, seen).filter((s) => s !== sessionId) : [];
        g.besideExit = [...unsealed.values()].filter((c) => c.isCommand && !c.lost && c.exitAt !== null && c.exitAt < seen && seen - c.exitAt <= quiet).map((c) => ({ ref: c.key.slice('command:'.length), gap: seen - c.exitAt }));
      }
    }
    if (GLOVE.has(m.source) && m.cause_hint && key.startsWith('file:')) {
      // A1b, step 2: a Glove tool call on a file, from its start to its outcome, on the mark's own clock.
      const c = calls.get(m.cause_hint) || { keys: new Set(), start: null, end: null };
      c.keys.add(key);
      if (m.says === 'started') c.start = BigInt(m.mono_ns);
      else c.end = BigInt(m.mono_ns);
      calls.set(m.cause_hint, c);
    }
    if (m.cause_hint) g.causes.add(m.cause_hint);
    if (real) g.realSays.push(m.says);
    if (!fingerprint) g.last = now;
    if (m.says === 'ended' && m.target && m.target.kind === 'turn') g.turnEnded = true;
    if (GLOVE.has(m.source)) {
      // C3c (LD191): a claim's command claims, its turn's commands, and the turns the Glove's health counts (line 352).
      const row = { seq: m.seq, says: m.says, source: m.source, slot: slotsOf(m), hint: m.cause_hint || null };
      const claims = m.says === 'claimed' && m.turn ? claimsOf(m).filter((c) => c.commands.length || c.files.length) : [];
      if (m.cause_hint && m.turn && !callTurn.has(m.cause_hint)) callTurn.set(m.cause_hint, m.turn);
      if (m.turn && !turnStart.has(m.turn)) turnStart.set(m.turn, now);
      if (claims.length) claimsAt.set(m.seq, { turn: m.turn, row, claims });
      const d = m.detail && typeof m.detail === 'object' ? m.detail : {};
      if (m.says === 'claimed' && m.turn && typeof d.text === 'string' && d.claim_unconfirmed !== true) heard.set(m.turn, [...(heard.get(m.turn) || []), { seq: m.seq, paths: mentionsOf(m) }]); // C3d2
      if (m.target && m.target.kind === 'command' && m.cause_hint && m.turn) {
        const runs = commandsOf.get(m.turn) || new Map();
        const r = runs.get(m.cause_hint) || { ref: m.cause_hint, text: String(m.target.text || ''), rows: [], outcome: null };
        r.rows.push(row);
        if (m.says !== 'started') r.outcome = { status: m.detail && m.detail.exit_status, exit_code: m.detail && m.detail.exit_code };
        runs.set(m.cause_hint, r);
        commandsOf.set(m.turn, runs);
      }
      if (m.turn && !m.sub_agent) turnsSeen.add(m.turn);
    }
    if (m.says === 'ended' && m.target && m.target.kind === 'turn' && (m.target.id || m.turn)) {
      turnsEnded.add(m.target.id || m.turn);
      if (!turnOver.has(m.target.id || m.turn)) turnOver.set(m.target.id || m.turn, now); // C3d2
    }
    if (m.says === 'ended' && m.target && m.target.kind === 'session' && sessionOver === null) sessionOver = now; // C3d2
    if (m.says === 'tampered' && m.detail && m.detail.what === 'hook_settings') hooksChanged = true;
    if (GLOVE.has(m.source) && m.cause_hint) {
      // C3b (LD189): a call waits from its `started` until its outcome, its turn's end, the session's end or a gap.
      const c = inFlight.get(m.cause_hint) || { turn: null, start: null, done: false, interrupted: false, end: null };
      if (m.says === 'started') {
        if (c.start === null) c.start = now;
        c.turn = m.turn || null;
      } else {
        c.done = true;
        if (c.end === null) c.end = now;
        if (m.detail && m.detail.interrupted === true) c.interrupted = true; // the payload says so (claude-code.js)
      }
      inFlight.set(m.cause_hint, c);
    }
    if (m.says === 'ended' && m.target && m.target.kind === 'turn') endCalls((c) => c.turn !== null && c.turn === (m.target.id || m.turn), now);
    if (m.says === 'ended' && m.target && m.target.kind === 'session') endCalls(() => true, now);
    if (g.isCommand && m.says === 'started' && g.startAt === null) g.startAt = now;
    if (g.isCommand && (m.says === 'exited' || m.says === 'ended')) g.exitAt = now;
    if (g.parentId !== null && GLOVE.has(m.source) && m.cause_hint) {
      // G2: a Glove edit ties this change to a direct edit tool call: not the command's child.
      const p = unsealed.get(g.parentId);
      if (p) p.childIds = p.childIds.filter((c) => c !== g.id);
      g.parentId = null;
    }
    if (m.says === 'exited' && m.source === 'process' && m.target && m.target.kind === 'process' && m.target.name === 'closeout') out.push(...closeoutNow()); // K1 (LD204)
    return out;
  }

  /**
   * K1 (LD204; lines 451-452): the closeout's end. The session is over and every call's wait ends
   * (a call, or a command, with no outcome is outcome_missing); every group not yet sealed (open,
   * settled, or waiting for its turn) is closed through stations 4-6 and sealed now, in the order
   * they opened.
   */
  function closeoutNow() {
    if (sessionOver === null) sessionOver = now;
    endCalls(() => true, now);
    const rest = [...unsealed.values()];
    for (const g of rest) {
      if (g.state === 'open') {
        g.state = 'settled';
        g.settledAt = now;
      }
    }
    for (const g of rest) {
      close(g);
      g.judged = turnsOf(g);
      g.after = [];
    }
    const sealing = [...waiting.splice(0, waiting.length), ...rest].sort((a, b) => a.n - b.n);
    for (const g of sealing) g.sealedAt = now;
    return sealing.flatMap(emit);
  }

  const end = () => all.filter((g) => g.state !== 'sealed').map(record);
  /** L1b: the paths due a fingerprint since the last call, each given once; the live intake writes them, replay reads them from the log. */
  const fingerprintsDue = () => due.splice(0, due.length);

  return { push, end, fingerprintsDue };
}

module.exports = { createOpon, actionOf };
