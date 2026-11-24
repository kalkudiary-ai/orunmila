'use strict';

/**
 * src/opon/intake/router.js — the intake's router (Phase 1 slice B1d; brief v4
 * station 1; design D-I 4.3): raw Claude Code hook payloads in, marks into
 * each session's log. One per intake process; it holds each session's state
 * in memory and owns no socket or timer (the server does, slice B1e).
 *
 *   createRouter({ home, clock, checkSender, codeRoot, orunmilaVersion,
 *                  installKey, hookSettingsFor?, lawPacksFor?, config?,
 *                  diff?, tickMs?, releaseMs?, sentinel?, baseline?, judge? })
 *       judge (BB6, with baseline): the rules file's text in each new
 *       session's header, and the verdict log written at its closeout;
 *       true for the default judge, or a judge's name (BB11)
 *   router.payload(payload, { channel, pid, monoNs } = {})
 *       -> { ok, results: [the log's answer per mark], reason? }
 *       In order: the session's log is made at first contact, with its header
 *       (configuration frozen then, line 343), in <home>/sessions/<id>/, outside
 *       the project (line 348), or reopened if it exists; the payload gets its
 *       turn (with `baseline: true`, slice N1b, LD170, the baseline snapshot of
 *       the root is taken first, skipping the header's config.exclusions, and
 *       kept beside the log as baseline.jsonl, its fingerprint in the header's
 *       `baseline`; off by default, as the live path is, LD166; with it too,
 *       slice L1c, LD200, the session's live Ọpọ́n, src/opon/intake/live.js:
 *       every mark its log writes goes through stations 2-6, each settled
 *       change of a file gets its `fingerprinted` mark, and each sealed odù
 *       goes to odu.jsonl beside the raw log; and, a lag grace after the
 *       session's end, the closeout, slice K5, LD208, provisional: the sweep's
 *       marks with a rescan mark for each file that differs from the baseline,
 *       and, F9 (LD234), the unknown shape naming the entry for one the walk
 *       could not fingerprint where the session last knew a regular file or
 *       nothing, a path under such an entry never read as gone);
 *       a write's file facts are measured, before at PreToolUse and after
 *       at PostToolUse, and a read's at PostToolUse (the whole file at hook time,
 *       test 55); the adapter translates (A8); paths are normalised (line 345);
 *       each mark goes through the engine (seq, pin, stamp) with its kept files
 *       (LD124). An adapter reject is quarantined with its reason; a payload
 *       with no session, or one unsafe as a folder name (NF3), goes to
 *       <home>/intake/errors.jsonl (LD124). SessionStart opens the session and
 *       writes no mark.
 *   router.poll()       the engine's ticks (returned: how many), then releases
 *                       each session with no payload for releaseMs (LD123); with
 *                       `judge`, one not swept since its last prompt is closed out
 *                       first (LD286)
 *   router.resume({ also }?)
 *                       after a restart, before any payload: reopens the
 *                       sessions held at the last write of held.json and gives
 *                       each a gap for the downtime (test 84), `also` added to
 *                       its lost text (LD132); the engine's answer
 *   router.stop(reason, { signal }?)
 *                       the engine's planned stop (LD56); with `signal`, a stop no one
 *                       asked for: a tampered mark (intake_stop) before each closing note (TE2)
 *   router.error(reason, payload)
 *                       a line to <home>/intake/errors.jsonl, redacted (LD124);
 *                       the server's unreadable lines and squats (LD132)
 *   router.gap(lost)    a gap in every held session, naming what was lost and
 *                       the sessions held (the HTTP port's squat, LD139)
 *   router.held()       the ids of the sessions held, sorted
 *   watchExtra          Q12 (a) (LD289): extra folders the Sentinel watches for every
 *                       held session (none by default); a mark there names its file's
 *                       absolute path (outside the project); one that holds the
 *                       project, or lies inside it, is skipped
 *   router.watching()   the folders the Sentinel watches, sorted (slice
 *                       B4, LD145): with `sentinel: true`, each session's root
 *                       is watched from its first payload until it is released,
 *                       and its `sentinel` marks and watch gaps go into every
 *                       session of that root (src/opon/intake/sentinel.js); the
 *                       header's config.exclusions is then what it does not watch
 *
 * Law-gate checks (slice B5, LD146; test 61): a payload with hook_event_name
 * `OrunmilaLawCheck` and the gate's `check` (src/laws/gate.js onCheck, sent by
 * the gate hook with ORUNMILA_GATE_MARKS=1) is one `law_gate` `checked` mark on
 * the session's latest turn, open or just closed by its Stop (the two Stop
 * hooks run in either order); it never opens a turn. With no turn yet it is
 * quarantined with the adapter's reason.
 *
 * Turns (test 63; D-Q2): a turn opens at the first payload after the previous
 * turn's Stop, or at the session's first: a prompt, or, for a continuation, a
 * tool call or a Stop. A prompt while a turn is open joins it (a prompt sent
 * mid-turn). Stop closes the turn; SessionEnd has none. Ids are t1, t2, ... per
 * session, recovered from the log when it is reopened.
 *
 * File facts: a file on the redaction list (`.env`, `.env.*`) is fingerprinted
 * with the install key and never diffed (line 249, test 54); a binary file has
 * no_diff binary; one over the header's diff_size_limit_bytes, no_diff
 * too_large (test 62); a changed text file whose diff comes back empty (no diff
 * program, NF30) gets a gap mark naming what was lost (N1). A write with no
 * PreToolUse has an unknown before-state. `.env` values for redaction are read
 * when the log is made or reopened, held in memory only (A6).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createIntake } = require('./engine');
const { createSessionLog, openSessionLog } = require('../ledger/session-log');
const { checkLog } = require('../../verify/session');
const { buildHeader } = require('./header');
const { translatePayload } = require('./adapters/claude-code');
const { translateCheck } = require('./adapters/law-gate');
const { normalisePath, isCaseInsensitive, sessionFolderName } = require('./paths');
const { readEnvEntries } = require('./leak-check');
const { fingerprint, onRedactionList, redactText } = require('./redact');
const { readRegular } = require('./regular-file');
const { unifiedDiff } = require('../../reconcile/difftool');
const { looksBinary } = require('../../capture/fs-sentinel/hasher');
const { getAdapter } = require('../../capture/agents');
const { createSentinels } = require('./sentinel');
const { createTamperWatch } = require('./tamper');
const { snapshot, baselineMap } = require('../net/baseline');
const { createLive } = require('./live');
const { prepareOffThread } = require('./start-worker');
const { canonicalize } = require('../../verify/canonical');
const crypto = require('crypto');

const CC = getAdapter('claude-code');
const RELEASE_MS = 30 * 60 * 1000;
const NS_PER_MS = 1000000n;
const TURN = /^t([1-9][0-9]*)$/;
const ERROR_TEXT = 4000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultHookSettings(root) {
  return [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'), path.join(os.homedir(), '.claude', 'settings.json')];
}

/** The turn count, whether the last turn is still open, and the tampered marks, from a session's raw log (on reopen). */
function turnsFrom(dir) {
  const recs = checkLog(dir, 'raw').records.map((r) => r.rec);
  let n = 0;
  for (const r of recs) {
    const m = typeof r.turn === 'string' && TURN.exec(r.turn);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const id = `t${n}`;
  const open = n > 0 && !recs.some((r) => r.says === 'ended' && isObject(r.target) && r.target.kind === 'turn' && r.target.id === id);
  const tampered = recs.filter((r) => r.says === 'tampered' && isObject(r.detail) && r.detail.what !== 'foreign_sender');
  // K5b (LD210 (1)): whether the session ended, and whether its closeout already ran. LD249 (LD211 (7)): both counted
  // since its last prompt, so a session resumed after its closeout (a new prompt) is swept again at its next end.
  const lastOf = (pred) => recs.reduce((at, r, i) => (pred(r) ? i : at), -1);
  const lastPrompt = lastOf((r) => r.says === 'prompted' && ['hook', 'agent_claim'].includes(r.source));
  const ended = lastOf((r) => r.says === 'ended' && isObject(r.target) && r.target.kind === 'session') > lastPrompt;
  const swept = lastOf((r) => r.says === 'exited' && r.source === 'process' && isObject(r.target) && r.target.kind === 'process' && r.target.name === 'closeout') > lastPrompt;
  return { header: recs[0], n, open, tampered, ended, swept };
}

/**
 * K3 (LD217): what git lists as changed under `root`, as path (relative to the root) -> verb, or null when the
 * root is not in a git work tree. fsmonitor off and GIT_OPTIONAL_LOCKS=0, so status writes no index lock. F2
 * (LD224): with `ci` (the root's file system ignores case) each path is lower-cased, as the snapshot names its own.
 */
function gitChanged(root, ci = false) {
  const run = (args) => spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  const top = run(['rev-parse', '--show-prefix']);
  if (top.error || top.status !== 0) return null;
  const prefix = top.stdout.trim();
  const st = run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  if (st.error || st.status !== 0) throw new Error(`git status ${st.error ? st.error.message : `exited ${st.status}`}`);
  const out = new Map();
  for (const rec of st.stdout.split('\0')) {
    if (rec.length < 4 || !rec.slice(3).startsWith(prefix)) continue;
    const xy = rec.slice(0, 2);
    const rel = rec.slice(3 + prefix.length);
    out.set(ci ? rel.toLowerCase() : rel, xy[1] === 'D' ? 'deleted' : xy === '??' || xy.includes('A') ? 'created' : xy.includes('D') ? 'deleted' : 'modified'); // F8 (LD223): the work tree first, so AD is deleted
  }
  return out;
}

/** A file's state at hook time: exists, and, for a regular file, its bytes, size and fingerprint. */
function snap(abs, key) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { exists: false };
  }
  const buf = st.isFile() ? readRegular(abs) : null;
  if (buf === null) return { exists: true, regular: false };
  return { exists: true, regular: true, buf, size: buf.length, fingerprint: fingerprint(abs, buf, key) };
}

function countLines(diff) {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** The adapter's file facts for a write, from the state before (or none) and after. */
function writeFacts(pre, post, abs, label, limit, diffOf) {
  const f = { existsAfter: post.exists };
  if (pre) f.existedBefore = pre.exists;
  if (post.regular) {
    f.size = post.size;
    f.fingerprint = post.fingerprint;
  } else if (!post.exists) f.fingerprint = null;
  if (pre && pre.regular) f.fingerprintBefore = pre.fingerprint;
  const before = pre ? (pre.regular ? pre.buf : pre.exists ? null : Buffer.alloc(0)) : null;
  const after = post.regular ? post.buf : post.exists ? null : Buffer.alloc(0);
  if (before === null || after === null) return f; // a state not known, or not a regular file: no diff
  if (onRedactionList(abs)) return f; // its diff would hold the values (line 249)
  if (looksBinary(before) || looksBinary(after)) return { ...f, noDiff: 'binary' };
  if (before.length > limit || after.length > limit) return { ...f, noDiff: 'too_large' };
  if (before.equals(after)) return { ...f, linesAdded: 0, linesRemoved: 0 };
  const diff = diffOf(before.toString('utf8'), after.toString('utf8'), label);
  if (!diff) return { ...f, diffLost: true };
  const c = countLines(diff);
  return { ...f, diff, linesAdded: c.added, linesRemoved: c.removed };
}

function createRouter(o) {
  const home = o.home;
  const clock = o.clock;
  const releaseNs = BigInt(o.releaseMs === undefined ? RELEASE_MS : o.releaseMs) * NS_PER_MS;
  const hookSettingsFor = o.hookSettingsFor || defaultHookSettings;
  const lawPacksFor = o.lawPacksFor || ((root) => ({ canon: path.join(o.codeRoot, 'laws', 'packs', 'canon.json'), project: path.join(root, '.orunmila', 'laws.json') }));
  const diffOf = o.diff || unifiedDiff;
  const sessionsDir = path.join(home, 'sessions');
  const intakeDir = path.join(home, 'intake');
  const states = new Map(); // session id -> { log, root, ci, n, open, pre, last, limit }
  const engine = createIntake({ openLog: (id) => states.get(id).log, clock, checkSender: o.checkSender, tickMs: o.tickMs, resumes: Boolean(o.judge) }); // LD286
  // The Ọpọ́n live (slice L1c, LD200), with the live path's flag only: one engine per session it starts.
  // BB6 (plan section 5): with `judge` too (ORUNMILA_JUDGE_LIVE=1, off by default), the closeout writes the verdict log.
  const live = o.baseline ? createLive({ key: o.installKey, clock, judge: o.judge || false, receive: (m) => engine.receive(m, {}), error: (reason, payload) => error(reason, payload) }) : null;
  let heldText = null;
  // Q12 (a) (LD212, LD289): extra folders the Sentinel watches for every held session (ORUNMILA_WATCH_EXTRA; none by
  // default), by their real paths; a mark there names its file's absolute path, so it reads as outside the project.
  const extraRoots = []; // filled below, once the error log can be written
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  /** The extra folders a session's Sentinel watches: none that holds its project or lies inside it (that would watch it twice). */
  const extrasFor = (root) => extraRoots.filter((x) => !inside(root, x) && !inside(x, root));
  // The Sentinel inside the intake (B4): its marks go to every watching session of the root.
  const sentinels = o.sentinel
    ? createSentinels({
        clock,
        key: o.installKey,
        diffOf,
        emit: (root, mark, keep) => {
          for (const [id, s] of [...states].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            if (s.watched && s.root !== root && (s.extras || []).includes(root)) {
              // Q12 (a): a file under an extra folder, by its absolute path (normalise marks it outside).
              const abs = mark.target && mark.target.kind === 'file' ? { ...mark, target: { ...mark.target, path: path.join(root, mark.target.path) } } : mark;
              engine.receive(normalise(s, { ...abs, session_id: id }), {}, keep);
              continue;
            }
            if (s.watched && s.root === root) engine.receive(normalise(s, { ...mark, session_id: id }), {}, keep);
            // Any write in the project's .orunmila/ is tampering, at once (test 10, B3).
            const rel = mark.source === 'sentinel' && mark.target ? mark.target.path : '';
            if (s.watched && s.root === root && (rel === '.orunmila' || rel.startsWith('.orunmila/'))) {
              const t = s.tamper.saw(path.join(root, rel), mark.detail.fingerprint, mark.detail.fingerprint_before === undefined ? null : mark.detail.fingerprint_before);
              if (t) engine.receive(normalise(s, { ...t, session_id: id }), {});
            }
          }
        },
      })
    : null;
  function watchFor(s, initial = null) {
    if (!sentinels || s.watched) return;
    s.watched = true;
    sentinels.watch(s.root, s.limit, initial); // SN1: `initial`, the Sentinel's first read made off the intake's thread
    s.extras = extrasFor(s.root); // Q12 (a)
    for (const x of s.extras) sentinels.watch(x, s.limit);
  }
  function unwatchFor(s) {
    if (!sentinels || !s.watched) return;
    s.watched = false;
    sentinels.unwatch(s.root);
    for (const x of s.extras || []) sentinels.unwatch(x);
  }

  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const x of o.watchExtra || []) {
    try {
      extraRoots.push(fs.realpathSync(x)); // Q12 (a)
    } catch (e) {
      error(`an extra folder to watch could not be found, so it is not watched: ${x} (${e.code || e.message})`, null);
    }
  }
  // TE1 (LD279): with `guard` (ORUNMILA_LOG_GUARD=1, off by default), each session's raw and quarantine logs are watched
  // against Orunmila's own copy in <home>/intake/keep/<session>/, at every write and every heartbeat.
  const guardFor = (id) => (o.guard ? { shadowDir: path.join(intakeDir, 'keep', sessionFolderName(id)) } : null);

  function writeHeld() {
    const text = JSON.stringify(engine.held());
    if (text === heldText) return;
    ensureDir(intakeDir);
    const tmp = path.join(intakeDir, `held.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, path.join(intakeDir, 'held.json'));
    heldText = text;
  }

  function error(reason, payload) {
    ensureDir(intakeDir);
    const text = redactText(JSON.stringify(payload === undefined ? null : payload) || '').text.slice(0, ERROR_TEXT);
    fs.appendFileSync(path.join(intakeDir, 'errors.jsonl'), JSON.stringify({ observed_at: clock().wall, reason, payload: text }) + '\n', { mode: 0o600 });
    return { ok: false, reason, results: [] };
  }

  /** K5 (LD208): what the closeout needs of a session: its baseline, exclusions and lag grace (from its header). */
  const closeoutFacts = (header, baseMap) => ({ baseMap, exclusions: header.config.exclusions || [], graceNs: BigInt(header.config.lag_grace_ms) * NS_PER_MS, closeoutAt: null });

  /**
   * K5 (LD208; lines 445-452): the closeout, with the live flag: the sweep's started mark, a rescan mark
   * for each file that differs from the baseline (changed, new, or gone), then exited, which seals every
   * group (K1). A walk that fails is in the error log; the sweep still ends.
   */
  function sweep(id, s) {
    const mark = (target, says, detail, source = 'process') => {
      const now = clock();
      return { schema_version: 1, session_id: id, source, agent: null, turn: null, sub_agent: null, observed_at: now.wall, mono_ns: now.mono, target, says, detail, cause_hint: null };
    };
    const rescanned = []; // K3: the paths the rescan marked, for git to corroborate
    const who = { kind: 'process', name: 'closeout' };
    engine.receive(mark(who, 'started', {}), {});
    let walked = 'pass'; // K7 (LD216): fail when the walk threw, so no claim is rated on a walk that did not run
    if (s.baseMap) {
      try {
        const snap = snapshot(s.root, { exclusions: s.exclusions, key: o.installKey, envValues: readEnvEntries(s.root).entries.map((e) => e.value) });
        // K5c (LD210 (2)): against what the session last knew of each file, else the baseline, as the engine reads a rescan.
        const known = s.lv && s.lv.on ? s.lv.opon.lastStates() : new Map();
        const last = (p) => (known.has(p) ? known.get(p) : s.baseMap.has(p) ? s.baseMap.get(p) : 'absent');
        const now = new Set();
        const hidden = []; // F9 (LD234): entries the walk could not fingerprint; nothing under them was seen
        for (const e of snap.entries) {
          now.add(e.path);
          if (typeof e.fingerprint !== 'string') {
            hidden.push(e.path);
            // F9 (LD234, Q26): where the session last knew a regular file or nothing, the change is unknown: the existing unknown shape, naming the entry.
            if (typeof last(e.path) === 'string') {
              engine.receive(mark({ kind: 'file', path: e.path }, 'fingerprinted', { exists: true, size: null, fingerprint: null, rescan: true, entry: e.kind }), {});
              rescanned.push(e.path);
            }
            continue;
          }
          if (s.baseMap.get(e.path) === e.fingerprint && last(e.path) === e.fingerprint) continue;
          engine.receive(mark({ kind: 'file', path: e.path }, 'fingerprinted', { exists: true, size: e.size, fingerprint: e.fingerprint, rescan: true }), {});
          rescanned.push(e.path);
        }
        const gone = [...new Set([...s.baseMap.keys(), ...known.keys()])].sort();
        for (const p of gone) {
          if (now.has(p) || typeof last(p) !== 'string' || last(p) === 'absent') continue;
          if (hidden.some((h) => h === '.' || p.startsWith(h + '/'))) continue; // F9: under a link or an unreadable folder: not seen, never read as gone
          engine.receive(mark({ kind: 'file', path: p }, 'fingerprinted', { exists: false, rescan: true }), {});
          rescanned.push(p);
        }
      } catch (e) {
        walked = 'fail';
        error(`the closeout's rescan of session ${id} failed: ${e.message}; the sweep ends without it`, { session_id: id });
      }
      try {
        // K3 (LD217; step 3): git, the last witness, only for a path it lists and the rescan marked.
        const changed = rescanned.length ? gitChanged(s.root, s.ci) : null;
        if (changed) for (const p of rescanned) if (changed.has(p)) engine.receive(mark({ kind: 'file', path: p }, changed.get(p), {}, 'git'), {});
      } catch (e) {
        error(`git at the closeout of session ${id} failed: ${e.message}; the sweep ends without it`, { session_id: id });
      }
    }
    if (o.judge) heartbeatGaps(id, s, mark); // BB5a, with the judge's flag only (Leopard rule 2)
    engine.receive(mark(who, 'exited', { exit_status: walked }), {});
  }

  /**
   * BB5a (LD277; brief v4 lines 670, 686): at the closeout, one gap mark for each hole in the session's raw log longer
   * than its lag grace while the intake held it: no record and no tick, after neither an intake closing note (a release
   * or a planned stop), the session's end, nor a gap already recorded. Its since and until are the records either
   * side, so the judge marks the record Incomplete and verify names the window. A hole a gap names is not marked again.
   */
  function heartbeatGaps(id, s, mark) {
    const recs = checkLog(path.join(sessionsDir, sessionFolderName(id)), 'raw').records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec).slice(1);
    const named = new Set(recs.filter((r) => r.says === 'gap' && isObject(r.detail) && isObject(r.detail.since)).map((r) => r.detail.since.mono_ns));
    let ended = false;
    for (let i = 0; i + 1 < recs.length; i++) {
      const [a, b] = [recs[i], recs[i + 1]];
      if (a.says === 'ended' && isObject(a.target) && a.target.kind === 'session') ended = true;
      if (a.says === 'prompted') ended = false;
      if (ended || b.says === 'gap' || named.has(a.mono_ns)) continue;
      if (a.says === 'exited' && isObject(a.target) && a.target.kind === 'process' && a.target.name === 'intake') continue;
      const ns = BigInt(b.mono_ns) - BigInt(a.mono_ns);
      if (ns <= s.graceNs) continue;
      const lost = `no record for ${ns / NS_PER_MS} ms while the intake held this session: no tick was written, so marks sent meanwhile may have been lost (a hang, or the intake busy)`;
      engine.receive(mark(null, 'gap', { lost, since: { mono_ns: a.mono_ns, observed_at: a.observed_at }, until: { mono_ns: b.mono_ns, observed_at: b.observed_at } }), {});
    }
  }

  /** Reopen a session folder that exists (after a restart or a release), with its turns. */
  function reopen(id, dir) {
    const t = turnsFrom(dir);
    const root = t.header.project_root;
    let lv = null; // L1d: the reopened session's live Ọpọ́n, from a replay of its raw log so far
    const log = openSessionLog(dir, { envEntries: readEnvEntries(root).entries, onRecord: live ? (rec) => lv && live.feed(lv, rec) : null, guard: guardFor(id) });
    const header = log.header();
    const baseMap = live && header.baseline ? baselineMap(fs.readFileSync(path.join(dir, 'baseline.jsonl'), 'utf8')) : null;
    if (live) {
      const marks = checkLog(dir, 'raw').records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec).slice(1);
      lv = live.resume(dir, header, baseMap, marks, log); // TE1's rest (LD285): the session log guards the odù and verdict logs too
    }
    const tamper = createTamperWatch({ header: t.header, codeRoot: o.codeRoot, lawPacks: lawPacksFor(root), prior: t.tampered, clock });
    const facts = closeoutFacts(header, baseMap);
    // K5b (LD210 (1)): swept before: never again; ended and not swept: a lag grace after this reopen.
    if (t.swept) facts.closeoutAt = true;
    else if (t.ended && lv) facts.closeoutAt = BigInt(clock().mono) + facts.graceNs;
    return { log, root, ci: isCaseInsensitive(root), n: t.n, open: t.open, pre: new Map(), last: BigInt(clock().mono), limit: t.header.config.diff_size_limit_bytes, tamper, lv, ...facts };
  }

  /** A new session's header, as its first payload arrives (`at`): its root, its `.env` entries and whether it folds case. */
  function freshHeader(id, p, at = clock()) {
    if (typeof p.cwd !== 'string' || !p.cwd) throw new Error('the payload names no working folder, so the session has no project root');
    const root = fs.realpathSync(p.cwd);
    const entries = readEnvEntries(root).entries;
    const now = at;
    const ci = isCaseInsensitive(root);
    const header = buildHeader({
      sessionId: id,
      root,
      caseInsensitive: ci, // Q25 (LD233): the probe the marks are folded by, in the header for replay
      agent: { name: CC.id, version: null },
      orunmilaVersion: o.orunmilaVersion,
      codeRoot: o.codeRoot,
      lawPacks: lawPacksFor(root),
      hookSettings: hookSettingsFor(root),
      config: sentinels ? { ...(o.config || {}), exclusions: sentinels.ignoreFor(root) } : o.config,
      observedAt: now.wall,
      monoNs: now.mono,
      envValues: entries.map((e) => e.value),
      byproducts: Boolean(o.baseline), // the live path's flag (LD166): the byproducts list in the header (A1a, LD175)
      rules: Boolean(o.judge), // the judge's flag (BB6): the rules file's text in the header (Q34)
    });
    return { root, entries, ci, header, at };
  }

  /**
   * A new session's log. `prepared` (SN1, LD294): its header built when its first payload arrived and, when the start
   * worker gave one, its baseline; without them both are made here, in the intake's thread, as before.
   */
  function start(id, p, prepared = null) {
    const dir = path.join(sessionsDir, sessionFolderName(id));
    if (!prepared && fs.existsSync(path.join(dir, 'raw.jsonl'))) return reopen(id, dir);
    const { root, entries, ci, header, at: now } = prepared || freshHeader(id, p);
    let baseline = null;
    if (o.baseline) {
      // Station 4's baseline, at session start (brief v4 lines 385, 387): the same exclusions the header records.
      const b = prepared && prepared.baseline ? prepared.baseline : snapshot(root, { exclusions: header.config.exclusions, key: o.installKey, envValues: entries.map((e) => e.value) });
      header.baseline = { fingerprint: b.fingerprint };
      baseline = b.text;
    }
    ensureDir(sessionsDir);
    let lv = null; // the session's live Ọpọ́n (L1c): fed each mark its log writes
    const log = createSessionLog(dir, header, { envEntries: entries, baseline, onRecord: live ? (rec) => lv && live.feed(lv, rec) : null, guard: guardFor(id) });
    const baseMap = baseline === null ? null : baselineMap(baseline);
    if (live) lv = live.open(dir, log.header(), baseMap, log); // TE1's rest (LD285)
    const tamper = createTamperWatch({ header: { ...header, project_root: root }, codeRoot: o.codeRoot, lawPacks: lawPacksFor(root), clock });
    return { log, root, ci, n: 0, open: false, pre: new Map(), last: BigInt(now.mono), limit: header.config.diff_size_limit_bytes, tamper, lv, ...closeoutFacts(header, baseMap) };
  }

  function normalise(s, m) {
    if (!isObject(m.target) || !['file', 'dir'].includes(m.target.kind) || typeof m.target.path !== 'string' || !m.target.path) return m;
    const n = normalisePath(m.target.path, { root: s.root, caseInsensitive: s.ci });
    const target = { ...m.target, path: n.path };
    if (n.outside) target.outside = true;
    else delete target.outside;
    return { ...m, target };
  }

  /**
   * SN1 (LD294), with `asyncStart` (ORUNMILA_ASYNC_START=1, off by default): a new session that needs a baseline starts
   * off the intake's thread (start-worker.js), and its payloads wait in a queue meanwhile, each with the time it
   * arrived and the file facts measured then; once its log exists they are written in order. Without it, or for a
   * session whose log exists, everything happens at once, as before.
   */
  const starting = new Map(); // session id -> { f: its header etc., queue: [{ p, from, at, snap }] }
  function payload(p, from = {}) {
    const id = p && p.session_id;
    if (o.asyncStart && typeof id === 'string' && id && !states.has(id)) {
      const q = starting.get(id);
      if (q) return enqueue(q, p, from);
      let fresh = false;
      try {
        fresh = Boolean(o.baseline) && !fs.existsSync(path.join(sessionsDir, sessionFolderName(id), 'raw.jsonl'));
      } catch {
        /* an id unsafe as a folder name: apply() refuses it */
      }
      if (fresh) {
        const b = begin(id, p, from);
        if (b) return b;
      }
    }
    return apply(p, from, null);
  }

  /** The file a write's or read's payload names, and its state now (a queued payload's facts are its arrival's). */
  function factsNow(root, p) {
    const toolName = CC.fields.toolName(p);
    const input = CC.fields.toolInput(p) || {};
    const kind = toolName ? CC.classifyTool(toolName, input) : null;
    const filePath = kind === 'write' || kind === 'read' ? CC.fields.filePath(input) : null;
    if (!filePath) return null;
    const ev = p.hook_event_name;
    const measured = (kind === 'write' && (ev === 'PreToolUse' || ev === 'PostToolUse')) || (kind === 'read' && ev === 'PostToolUse');
    return measured ? snap(path.resolve(root, String(filePath)), o.installKey) : null;
  }

  function enqueue(q, p, from) {
    q.queue.push({ p, from, at: clock(), snap: factsNow(q.f.root, p) });
    return { ok: true, queued: true, results: [] };
  }

  function begin(id, p, from) {
    let f;
    try {
      f = freshHeader(id, p);
    } catch {
      return null; // apply() writes why to the error log
    }
    const q = { f, queue: [] };
    starting.set(id, q);
    enqueue(q, p, from);
    const job = { root: f.root, exclusions: f.header.config.exclusions, key: o.installKey, envValues: f.entries.map((e) => e.value), sentinel: sentinels ? { ignore: sentinels.ignoreFor(f.root), limit: f.header.config.diff_size_limit_bytes } : null };
    (o.prepare || prepareOffThread)(job).then(
      (r) => finish(id, q, r),
      (e) => {
        error(`the start of session ${id} could not run off the intake's thread (${e.message}); it ran in it`, { session_id: id });
        finish(id, q, null);
      },
    );
    return { ok: true, queued: true, results: [] };
  }

  /**
   * SN1: the earliest observation of a file wins. The worker reads the tree after the session's first payload, so an
   * agent's write answered at once may land before the worker reads that file; a queued PreToolUse measured it before
   * the write, so its state replaces the worker's entry (the session's start state). Returns the corrected baseline,
   * or null when nothing changed. Stated limit: a person's edit in that same window is read as the start state.
   */
  function earliestWins(base, f, queue) {
    const envValues = f.entries.map((e) => e.value);
    const firsts = new Map();
    for (const item of queue) {
      if (item.p.hook_event_name !== 'PreToolUse' || !item.snap) continue;
      const fp = CC.fields.filePath(CC.fields.toolInput(item.p) || {});
      if (!fp) continue;
      const n = normalisePath(path.resolve(f.root, String(fp)), { root: f.root, caseInsensitive: f.ci });
      if (n.outside) continue;
      const r = redactText(n.path, envValues);
      if (!firsts.has(r.text)) firsts.set(r.text, { snap: item.snap, kinds: r.kinds });
    }
    if (!firsts.size) return null;
    const entries = new Map(base.text.split('\n').filter(Boolean).map((l) => [JSON.parse(l).path, JSON.parse(l)]));
    let changed = false;
    for (const [rel, { snap: sn, kinds }] of firsts) {
      const was = entries.get(rel);
      if (!sn.exists) {
        if (was) changed = entries.delete(rel);
        continue;
      }
      if (!sn.regular || (was && was.fingerprint === sn.fingerprint && was.size === sn.size)) continue;
      entries.set(rel, { path: rel, size: sn.size, fingerprint: sn.fingerprint, ...(kinds.length ? { redactions: kinds } : {}) });
      changed = true;
    }
    if (!changed) return null;
    const text = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((e) => canonicalize(e) + '\n').join('');
    return { text, fingerprint: 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
  }

  function finish(id, q, r) {
    starting.delete(id);
    let s;
    try {
      const base = r ? r.baseline : null;
      s = start(id, q.queue[0].p, { ...q.f, baseline: (base && earliestWins(base, q.f, q.queue)) || base });
    } catch (e) {
      for (const item of q.queue) error(`the session's log could not be opened: ${e.message}`, item.p);
      return;
    }
    states.set(id, s);
    if (s.lv) live.pair(s.lv);
    watchFor(s, r && r.store ? new Map(r.store) : null);
    for (const item of q.queue) apply(item.p, item.from, item);
  }

  /** One payload into its session's log; `item`, a queued payload with its arrival time and file facts (SN1). */
  function apply(p, from = {}, item = null) {
    const id = p && p.session_id;
    if (typeof id !== 'string' || !id) return error('the payload names no session, so it has no log to go to', p);
    let s = states.get(id);
    if (!s) {
      try {
        s = start(id, p);
      } catch (e) {
        return error(`the session's log could not be opened: ${e.message}`, p);
      }
      states.set(id, s);
      if (s.lv) live.pair(s.lv); // L2 (LD202): the sessions sharing its folder, named in each other's logs
    }
    s.last = BigInt(clock().mono);
    watchFor(s);
    // What was frozen at session start, fingerprinted again at every payload (B3, LD147).
    const tampered = s.tamper.check().map((m) => engine.receive(normalise(s, { ...m, session_id: id }), {}));
    const ev = p.hook_event_name;
    if (ev === 'SessionStart') {
      writeHeld();
      return { ok: tampered.every((r) => r.ok), results: tampered };
    }
    if (ev === 'OrunmilaLawCheck') {
      const c = translateCheck({ sessionId: id, agent: CC.id, turn: s.n > 0 ? `t${s.n}` : null, observedAt: clock().wall, check: p.check });
      const results = c.mark ? [engine.receive(c.mark, from)] : c.rejects.map((r) => engine.receive({ session_id: id, adapter_reject: r.reason, payload: p }, from));
      writeHeld();
      return { ok: results.every((r) => r.ok), results };
    }
    if (s.closeoutAt === true && ev === 'UserPromptSubmit') s.closeoutAt = null; // LD249: resumed after its closeout: its next end sweeps again
    let turn = null;
    if (ev !== 'SessionEnd') {
      if (!s.open) {
        s.n++;
        s.open = true;
      }
      turn = `t${s.n}`;
    }

    // File facts for a write (before and after) or a read (the whole file at hook time).
    const toolName = CC.fields.toolName(p);
    const input = CC.fields.toolInput(p) || {};
    const kind = toolName ? CC.classifyTool(toolName, input) : null;
    const callId = CC.fields.callId(p);
    const filePath = kind === 'write' || kind === 'read' ? CC.fields.filePath(input) : null;
    const abs = filePath ? path.resolve(s.root, String(filePath)) : null;
    let file;
    const measured = () => (item ? item.snap : snap(abs, o.installKey)); // SN1: a queued payload's file as it was when it arrived
    if (abs && kind === 'write') {
      if (ev === 'PreToolUse') s.pre.set(callId, measured());
      else if (ev === 'PostToolUse') {
        file = writeFacts(s.pre.get(callId), measured(), abs, String(filePath), s.limit, diffOf);
        s.pre.delete(callId);
      } else if (ev === 'PostToolUseFailure') s.pre.delete(callId);
    } else if (abs && kind === 'read' && ev === 'PostToolUse') {
      const n = measured();
      if (n.regular) file = { size: n.size, fingerprint: n.fingerprint };
    }

    const now = item ? item.at : clock(); // SN1: a queued payload keeps the time it arrived
    const t = translatePayload(p, { turn, observedAt: now.wall, monoNs: from.monoNs !== undefined ? from.monoNs : item ? item.at.mono : undefined, file });
    const results = [];
    for (const { mark, keep } of t.marks) results.push(engine.receive(normalise(s, mark), from, keep));
    for (const r of t.rejects) results.push(engine.receive({ session_id: id, adapter_reject: r.reason, payload: p }, from));
    if (file && file.diffLost) {
      const gap = {
        schema_version: 1,
        session_id: id,
        source: 'process',
        agent: null,
        turn: null,
        sub_agent: null,
        observed_at: now.wall,
        target: { kind: 'file', path: String(filePath) },
        says: 'gap',
        detail: { lost: 'the diff of this change: it came back empty from a changed text file, so no diff program ran (NF30)' },
        cause_hint: callId || null,
      };
      results.push(engine.receive(normalise(s, gap), {}));
    }
    if (ev === 'Stop') s.open = false;
    if (ev === 'SessionEnd' && s.lv && s.closeoutAt === null) s.closeoutAt = BigInt(clock().mono) + s.graceNs; // K5: a lag grace after the end
    writeHeld();
    return { ok: t.rejects.length === 0 && results.every((r) => r.ok), results };
  }

  function poll() {
    if (o.guard) for (const s of states.values()) s.log.guard(); // TE1: a change to a log is found by the next heartbeat at the latest
    const ticks = engine.poll();
    const now = BigInt(clock().mono);
    for (const [id, s] of states) {
      if (s.closeoutAt !== null && s.closeoutAt !== true && now >= s.closeoutAt) {
        s.closeoutAt = true; // once per session
        sweep(id, s);
      }
    }
    const ms = releaseNs / NS_PER_MS;
    const quiet = ms % 60000n === 0n ? `${ms / 60000n} minutes` : `${ms} ms`;
    const held = new Set(engine.held());
    for (const [id, s] of states) {
      if (now - s.last < releaseNs) continue;
      if (held.has(id)) {
        // LD286 (LD249's open point), with the judge's flag (Leopard rule 2): a session not swept since its last prompt
        // (it never ended, or resumed after its closeout and never ended again) is closed out before it is released, so
        // nothing it holds waits for ever. A later prompt resumes it, as LD249 reads.
        if (o.judge && s.lv && s.closeoutAt === null) {
          s.closeoutAt = true;
          sweep(id, s);
        }
        engine.release(id, `released: no payload for ${quiet}`);
      }
      unwatchFor(s);
    }
    writeHeld();
    return ticks;
  }

  function resume(opts = {}) {
    let ids = [];
    try {
      ids = JSON.parse(fs.readFileSync(path.join(intakeDir, 'held.json'), 'utf8'));
    } catch {
      /* no held list: nothing was held */
    }
    const entries = [];
    const failed = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      try {
        const s = reopen(id, path.join(sessionsDir, sessionFolderName(id)));
        states.set(id, s);
        watchFor(s);
        entries.push({ id, log: s.log });
      } catch (e) {
        failed.push({ id, reason: e.message });
        error(`a held session could not be reopened after a restart: ${e.message}`, { session_id: id });
      }
    }
    const out = engine.resume(entries, { also: opts.also });
    for (const e of entries) if (states.get(e.id).lv) live.pair(states.get(e.id).lv); // L2: after the gaps, as the engine resumes first
    writeHeld();
    return { ...out, failed: [...out.failed, ...failed] };
  }

  /**
   * The intake's stop (LD56). With `signal` (TE2, LD283): a stop no one asked for through `orunmila intake stop`, so a
   * tampered mark (what: intake_stop, the signal) goes before the closing note in every session not yet ended.
   */
  function stop(reason, { signal } = {}) {
    if (sentinels) sentinels.stop();
    const first = signal
      ? (id, now) => ({ schema_version: 1, session_id: id, source: 'process', agent: null, turn: null, sub_agent: null, observed_at: now.wall, mono_ns: now.mono, target: { kind: 'process', name: 'intake' }, says: 'tampered', detail: { what: 'intake_stop', signal }, cause_hint: null })
      : undefined;
    return engine.stop(reason, { first });
  }

  /** A gap in every held session, naming what was lost (a squat on the HTTP port, LD139). */
  function gap(lost) {
    const now = clock();
    const named = engine.held();
    return named.map((id) =>
      engine.receive({ schema_version: 1, session_id: id, source: 'process', agent: null, turn: null, sub_agent: null, target: null, observed_at: now.wall, says: 'gap', detail: { lost: String(lost), sessions: named }, cause_hint: null }, {}),
    );
  }

  const watching = () => (sentinels ? sentinels.roots() : []);

  return { payload, poll, resume, stop, error, gap, held: engine.held, watching };
}

module.exports = { createRouter, RELEASE_MS, gitChanged };
