'use strict';

/**
 * src/opon/intake/router.js — the intake's router (Phase 1 slice B1d; brief v4
 * station 1; design D-I 4.3): raw Claude Code hook payloads in, marks into
 * each session's log. One per intake process; it holds each session's state
 * in memory and owns no socket or timer (the server does, slice B1e).
 *
 *   createRouter({ home, clock, checkSender, codeRoot, orunmilaVersion,
 *                  installKey, hookSettingsFor?, lawPacksFor?, config?,
 *                  diff?, tickMs?, releaseMs?, sentinel?, baseline? })
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
 *       goes to odu.jsonl beside the raw log);
 *       a write's file facts are measured, before at PreToolUse and after
 *       at PostToolUse, and a read's at PostToolUse (the whole file at hook time,
 *       test 55); the adapter translates (A8); paths are normalised (line 345);
 *       each mark goes through the engine (seq, pin, stamp) with its kept files
 *       (LD124). An adapter reject is quarantined with its reason; a payload
 *       with no session, or one unsafe as a folder name (NF3), goes to
 *       <home>/intake/errors.jsonl (LD124). SessionStart opens the session and
 *       writes no mark.
 *   router.poll()       the engine's ticks (returned: how many), then releases
 *                       each session with no payload for releaseMs (LD123)
 *   router.resume({ also }?)
 *                       after a restart, before any payload: reopens the
 *                       sessions held at the last write of held.json and gives
 *                       each a gap for the downtime (test 84), `also` added to
 *                       its lost text (LD132); the engine's answer
 *   router.stop(reason) the engine's planned stop (LD56)
 *   router.error(reason, payload)
 *                       a line to <home>/intake/errors.jsonl, redacted (LD124);
 *                       the server's unreadable lines and squats (LD132)
 *   router.gap(lost)    a gap in every held session, naming what was lost and
 *                       the sessions held (the HTTP port's squat, LD139)
 *   router.held()       the ids of the sessions held, sorted
 *   router.watching()   the project roots the Sentinel watches, sorted (slice
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
  return { header: recs[0], n, open, tampered };
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
  const engine = createIntake({ openLog: (id) => states.get(id).log, clock, checkSender: o.checkSender, tickMs: o.tickMs });
  // The Ọpọ́n live (slice L1c, LD200), with the live path's flag only: one engine per session it starts.
  const live = o.baseline ? createLive({ spans: [], key: o.installKey, clock, receive: (m) => engine.receive(m, {}), error: (reason, payload) => error(reason, payload) }) : null;
  let heldText = null;
  // The Sentinel inside the intake (B4): its marks go to every watching session of the root.
  const sentinels = o.sentinel
    ? createSentinels({
        clock,
        key: o.installKey,
        diffOf,
        emit: (root, mark, keep) => {
          for (const [id, s] of [...states].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
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
  function watchFor(s) {
    if (!sentinels || s.watched) return;
    s.watched = true;
    sentinels.watch(s.root, s.limit);
  }
  function unwatchFor(s) {
    if (!sentinels || !s.watched) return;
    s.watched = false;
    sentinels.unwatch(s.root);
  }

  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });

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

  /** Reopen a session folder that exists (after a restart or a release), with its turns. */
  function reopen(id, dir) {
    const t = turnsFrom(dir);
    const root = t.header.project_root;
    let lv = null; // L1d: the reopened session's live Ọpọ́n, from a replay of its raw log so far
    const log = openSessionLog(dir, { envEntries: readEnvEntries(root).entries, onRecord: live ? (rec) => lv && live.feed(lv, rec) : null });
    if (live) {
      const marks = checkLog(dir, 'raw').records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec).slice(1);
      const header = log.header();
      lv = live.resume(dir, header, header.baseline ? baselineMap(fs.readFileSync(path.join(dir, 'baseline.jsonl'), 'utf8')) : null, marks);
    }
    const tamper = createTamperWatch({ header: t.header, codeRoot: o.codeRoot, lawPacks: lawPacksFor(root), prior: t.tampered, clock });
    return { log, root, ci: isCaseInsensitive(root), n: t.n, open: t.open, pre: new Map(), last: BigInt(clock().mono), limit: t.header.config.diff_size_limit_bytes, tamper };
  }

  function start(id, p) {
    const dir = path.join(sessionsDir, sessionFolderName(id));
    if (fs.existsSync(path.join(dir, 'raw.jsonl'))) return reopen(id, dir);
    if (typeof p.cwd !== 'string' || !p.cwd) throw new Error('the payload names no working folder, so the session has no project root');
    const root = fs.realpathSync(p.cwd);
    const entries = readEnvEntries(root).entries;
    const now = clock();
    const header = buildHeader({
      sessionId: id,
      root,
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
    });
    let baseline = null;
    if (o.baseline) {
      // Station 4's baseline, at session start (brief v4 lines 385, 387): the same exclusions the header records.
      const b = snapshot(root, { exclusions: header.config.exclusions, key: o.installKey, envValues: entries.map((e) => e.value) });
      header.baseline = { fingerprint: b.fingerprint };
      baseline = b.text;
    }
    ensureDir(sessionsDir);
    let lv = null; // the session's live Ọpọ́n (L1c): fed each mark its log writes
    const log = createSessionLog(dir, header, { envEntries: entries, baseline, onRecord: live ? (rec) => lv && live.feed(lv, rec) : null });
    if (live) lv = live.open(dir, log.header(), baseline === null ? null : baselineMap(baseline));
    const tamper = createTamperWatch({ header: { ...header, project_root: root }, codeRoot: o.codeRoot, lawPacks: lawPacksFor(root), clock });
    return { log, root, ci: isCaseInsensitive(root), n: 0, open: false, pre: new Map(), last: BigInt(now.mono), limit: header.config.diff_size_limit_bytes, tamper };
  }

  function normalise(s, m) {
    if (!isObject(m.target) || !['file', 'dir'].includes(m.target.kind) || typeof m.target.path !== 'string' || !m.target.path) return m;
    const n = normalisePath(m.target.path, { root: s.root, caseInsensitive: s.ci });
    const target = { ...m.target, path: n.path };
    if (n.outside) target.outside = true;
    else delete target.outside;
    return { ...m, target };
  }

  function payload(p, from = {}) {
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
    if (abs && kind === 'write') {
      if (ev === 'PreToolUse') s.pre.set(callId, snap(abs, o.installKey));
      else if (ev === 'PostToolUse') {
        file = writeFacts(s.pre.get(callId), snap(abs, o.installKey), abs, String(filePath), s.limit, diffOf);
        s.pre.delete(callId);
      } else if (ev === 'PostToolUseFailure') s.pre.delete(callId);
    } else if (abs && kind === 'read' && ev === 'PostToolUse') {
      const n = snap(abs, o.installKey);
      if (n.regular) file = { size: n.size, fingerprint: n.fingerprint };
    }

    const now = clock();
    const t = translatePayload(p, { turn, observedAt: now.wall, monoNs: from.monoNs, file });
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
    writeHeld();
    return { ok: t.rejects.length === 0 && results.every((r) => r.ok), results };
  }

  function poll() {
    const ticks = engine.poll();
    const now = BigInt(clock().mono);
    const ms = releaseNs / NS_PER_MS;
    const quiet = ms % 60000n === 0n ? `${ms / 60000n} minutes` : `${ms} ms`;
    const held = new Set(engine.held());
    for (const [id, s] of states) {
      if (now - s.last < releaseNs) continue;
      if (held.has(id)) engine.release(id, `released: no payload for ${quiet}`);
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
    writeHeld();
    return { ...out, failed: [...out.failed, ...failed] };
  }

  function stop(reason) {
    if (sentinels) sentinels.stop();
    const out = engine.stop(reason);
    return out;
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

module.exports = { createRouter, RELEASE_MS };
