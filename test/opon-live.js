'use strict';

/**
 * test/opon-live.js — the Ọpọ́n live in the intake (Phase 3 slice L1, LD166,
 * LD200; brief v4 lines 336, 386, guarantee 3): one engine per held session,
 * fed every record its log takes; a settled change of a file gets a
 * `fingerprinted` mark; sealed groups go to the session's odù log, which must
 * equal replay's byte for byte. Behind ORUNMILA_OPON_LIVE=1 (the router's
 * `baseline` option); with it off nothing changes. Glove and Sentinel joined
 * on every odù asserted (LD182). Hand-built payloads and logs, labelled so
 * (brief line 761): made-up paths in throwaway folders.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M, FP } = require('./helpers-opon');
const { createOpon } = require('../src/opon/settle/engine');
const { replayFolder } = require('../src/opon/replay');
const { oduLog, createOduWriter } = require('../src/opon/ledger/odu-log');
const { canonicalize } = require('../src/verify/canonical');
const { verifyText } = require('../src/verify/chain');

const withBase = (fn) => () => {
  const base = tmpDir();
  try {
    fn(base);
  } finally {
    rmrf(base);
  }
};
const rawRecords = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

it(
  'L1a: the odù writer, given each sealed group as it seals and each mark\'s source, writes the odù log oduLog writes, byte for byte',
  withBase((base) => {
    const s = makeLog(base);
    s.append(M.started(0, 'e1', { kind: 'file', path: 'src/a.ts' }));
    s.append(M.edited(100, 'e1', 'src/a.ts'));
    s.append(M.disk(300, 'src/a.ts'));
    s.append(M.disk(400, 'src/hand.ts'));
    s.append(M.turnEnded(900));
    s.append(M.tick(10000));
    const out = replayFolder(s.dir);
    assert.strictEqual(out.ok, true, out.words);
    const [header, ...marks] = rawRecords(s.dir);
    const groups = out.lines.slice(1).map((l) => JSON.parse(l));
    const source = new Map(marks.map((m) => [m.seq, m.source]));
    const w = createOduWriter(header);
    const text = [w.head, ...groups.map((g) => w.add(g, (seq) => source.get(seq))).filter(Boolean)].map((r) => canonicalize(r) + '\n').join('');
    assert.strictEqual(text, out.odu);
    assert.strictEqual(text, oduLog({ header, marks, groups }).text);
    assert.deepStrictEqual(verifyText(text), { ok: true, lines: 4 }, 'its own chain, checked apart from oduLog: the header, the edit, the hand edit, the turn');
    const odus = text.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const of = (p) => odus.find((o) => o.target && o.target.path === p);
    assert.deepStrictEqual([of('src/a.ts').witness_status.glove.status, of('src/a.ts').witness_status.sentinel.status], ['saw', 'saw']);
    assert.deepStrictEqual([of('src/hand.ts').witness_status.glove.status, of('src/hand.ts').witness_status.sentinel.status], ['saw_nothing', 'saw']);
    assert.strictEqual(w.add({ ...groups[0], state: 'open' }, (seq) => source.get(seq)), null, 'a group not sealed is not written');
  }),
);

it(
  'L1b line 386: a change of a file inside the root is due a fingerprint each time it settles with a mark since it last asked, never for its own fingerprint; a read, an excluded path and one outside the root are never due',
  () => {
    const o = createOpon({ sessionId: 'ses_l1b', config: { quiet_window_ms: 1500, lag_grace_ms: 3000, ceiling_ms: 30000, exclusions: ['node_modules'] } });
    let seq = 0;
    const sealed = [];
    const push = (m) => sealed.push(...o.push({ ...m, seq: ++seq }));
    push(M.edited(0, 'e1', 'src/a.ts'));
    push(M.disk(50, 'src/a.ts'));
    push(M.read(0, 'r1', 'src/b.ts'));
    push(M.disk(0, 'node_modules/x.js', 'created'));
    push({ ...M.edited(0, 'e2', '/elsewhere/y.ts'), target: { kind: 'file', path: '/elsewhere/y.ts', outside: true } });
    push(M.turnEnded(100));
    push(M.tick(1000));
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'nothing has settled yet');
    push(M.tick(1600));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'each ask is given once');
    push(M.fingerprinted(1650, 'src/a.ts', FP('b')));
    push(M.tick(2200));
    assert.deepStrictEqual(o.fingerprintsDue(), [], 'its own fingerprint reopens it until the next step, and does not ask again');
    push(M.disk(2300, 'src/a.ts')); // a slow source's mark in its grace: it opens and settles again, and asks again
    push(M.tick(3900));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
    push(M.fingerprinted(3950, 'src/a.ts', FP('c')));
    push(M.tick(9000));
    const a = sealed.find((g) => g.target && g.target.path === 'src/a.ts');
    assert.deepStrictEqual([a.witness_status.glove.status, a.witness_status.sentinel.status, a.net_change.after], ['saw', 'saw', FP('c')]);
    push(M.disk(10000, 'src/a.ts')); // a new event after the seal
    push(M.tick(11600));
    assert.deepStrictEqual(o.fingerprintsDue(), ['src/a.ts']);
  },
);

// L1c: the router's live path, driven by Claude Code payloads (the shapes test/intake-router.js uses).
const { createRouter } = require('../src/opon/intake/router');
const MS = 1000000n;
const KEY = Buffer.alloc(32, 7);
const SRC = path.join(__dirname, '..', 'src');
function fakeClock() {
  let mono = 5000n * MS;
  let wall = Date.UTC(2026, 10, 23, 1, 0, 0, 0);
  const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
  clock.advance = (ms) => {
    mono += BigInt(ms) * MS;
    wall += ms;
  };
  return clock;
}
function cc(project, sid) {
  const base = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  return {
    prompt: (prompt) => ({ ...base, hook_event_name: 'UserPromptSubmit', prompt }),
    pre: (tool_name, tool_input, id) => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: id }),
    post: (tool_name, tool_input, tool_response, id) => ({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: id }),
    stop: (text) => ({ ...base, hook_event_name: 'Stop', last_assistant_message: text }),
  };
}
/** A short session through a router, `live` its flag: a Write, an Edit of a file the baseline holds, a command, a Stop, then 15 s of polls. */
function liveSession(base, live, sid = 'ses_live1') {
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'old.js'), 'old\n');
  const clock = fakeClock();
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: live });
  const p = cc(project, sid);
  const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
  const fresh = path.join(project, 'src', 'new.js');
  const old = path.join(project, 'src', 'old.js');
  send(p.prompt('make it'));
  send(p.pre('Write', { file_path: fresh, content: 'a\n' }, 'w1'));
  fs.writeFileSync(fresh, 'a\n');
  send(p.post('Write', { file_path: fresh, content: 'a\n' }, {}, 'w1'));
  clock.advance(200);
  send(p.pre('Edit', { file_path: old }, 'w2'));
  fs.writeFileSync(old, 'new\n');
  send(p.post('Edit', { file_path: old }, {}, 'w2'));
  send(p.pre('Bash', { command: 'true' }, 'b1'));
  send(p.post('Bash', { command: 'true' }, { stdout: '', stderr: '' }, 'b1'));
  send(p.stop('I wrote src/new.js and edited src/old.js.'));
  for (let i = 0; i < 25; i++) {
    clock.advance(600);
    router.poll();
  }
  return { dir: path.join(home, 'sessions', sid), project };
}

it(
  'L1c guarantee 3: with the live flag, the intake writes each settled change\'s fingerprinted mark before its seal and each sealed odù to odu.jsonl, and replay of the raw log gives that odù log byte for byte',
  withBase((base) => {
    const { dir, project } = liveSession(base, true);
    const raw = rawRecords(dir);
    const fps = raw.filter((m) => m.says === 'fingerprinted');
    assert.deepStrictEqual(fps.map((m) => [m.source, m.target.path, m.detail.exists, m.detail.size]), [['process', 'src/new.js', true, 2], ['process', 'src/old.js', true, 4]]);
    const { fingerprintNow } = require('../src/opon/net/baseline');
    assert.strictEqual(fps[1].detail.fingerprint, fingerprintNow(path.join(project, 'src', 'old.js'), 'src/old.js', KEY).fingerprint);
    const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
    const out = replayFolder(dir);
    assert.strictEqual(out.ok, true, out.words);
    assert.strictEqual(live, out.odu);
    assert.ok(verifyText(live).ok);
    const odus = live.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const of = (p) => odus.find((o) => o.target && o.target.path === p);
    const fresh = of('src/new.js');
    const old = of('src/old.js');
    assert.deepStrictEqual([fresh.witness_status.glove.status, fresh.witness_status.sentinel.status, fresh.net_change.before, fresh.net_change.after === fps[0].detail.fingerprint, fresh.net_change.changed], ['saw', 'saw_nothing', 'absent', true, true]);
    assert.deepStrictEqual([old.witness_status.glove.status, old.witness_status.sentinel.status, old.net_change.changed, old.net_change.after === fps[1].detail.fingerprint], ['saw', 'saw_nothing', true, true], 'the baseline\'s before; the settle-time after, in the odù, so it came before the seal (a later one would leave after null)');
  }),
);

it(
  'L1c: with the flag off nothing changes: no odu.jsonl, no fingerprinted mark, and the same marks as before',
  withBase((base) => {
    const { dir } = liveSession(base, false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'odu.jsonl')), false);
    const says = rawRecords(dir).slice(1).map((m) => m.says);
    assert.strictEqual(says.includes('fingerprinted'), false);
    assert.deepStrictEqual(says.filter((v) => v !== 'tick'), ['prompted', 'started', 'created', 'started', 'modified', 'started', 'exited', 'claimed', 'ended']);
  }),
);

it(
  'L1c: a failure of the live path never stops capture: an odù log that cannot be begun, or one that stops taking lines, ends that session\'s live engine with a line in the error log, and the raw log goes on whole',
  withBase((base) => {
    // Cannot be begun: a folder already where odu.jsonl goes.
    fs.mkdirSync(path.join(base, 'home', 'sessions', 'ses_live1', 'odu.jsonl'), { recursive: true });
    const { dir } = liveSession(base, true);
    const says = rawRecords(dir).slice(1).map((m) => m.says).filter((v) => v !== 'tick');
    assert.deepStrictEqual(says, ['prompted', 'started', 'created', 'started', 'modified', 'started', 'exited', 'claimed', 'ended'], 'every mark kept; no fingerprint once the live engine stopped');
    const errors = fs.readFileSync(path.join(base, 'home', 'intake', 'errors.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(errors.map((e) => e.reason.startsWith('the live Ọpọ́n stopped for session ses_live1: its odù log could not be begun')), [true]);
  }),
);

it(
  'L1c: an odù log that stops taking lines mid-session ends the live engine there, with a line in the error log; every later mark is still written',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const p = cc(project, 'ses_live2');
    const file = path.join(project, 'src', 'x.js');
    const odu = path.join(home, 'sessions', 'ses_live2', 'odu.jsonl');
    assert.strictEqual(router.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    fs.rmSync(odu);
    fs.mkdirSync(odu); // the next odù cannot be appended
    router.payload(p.pre('Write', { file_path: file }, 'w1'));
    fs.writeFileSync(file, 'x\n');
    assert.strictEqual(router.payload(p.post('Write', { file_path: file }, {}, 'w1')).ok, true);
    assert.strictEqual(router.payload(p.stop('Done.')).ok, true);
    for (let i = 0; i < 25; i++) {
      clock.advance(600);
      router.poll();
    }
    const says = rawRecords(path.join(home, 'sessions', 'ses_live2')).slice(1).map((m) => m.says).filter((v) => v !== 'tick');
    assert.deepStrictEqual(says, ['prompted', 'started', 'created', 'claimed', 'ended', 'fingerprinted'], 'every mark; the fingerprint at the settle (1.5 s after the Stop), before the first seal failed to append');
    const errors = fs.readFileSync(path.join(home, 'intake', 'errors.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(errors.map((e) => e.reason.startsWith('the live Ọpọ́n stopped for session ses_live2: ')), [true]);
  }),
);

it('L1c line 386: a file\'s state now is streamed when it is a regular file; no entry is exists false; a folder or a link is exists true with size and fingerprint unknown, never guessed', withBase((base) => {
  const { fingerprintNow } = require('../src/opon/net/baseline');
  fs.writeFileSync(path.join(base, 'f'), 'abc');
  fs.mkdirSync(path.join(base, 'd'));
  fs.symlinkSync(path.join(base, 'f'), path.join(base, 'l'));
  assert.deepStrictEqual(fingerprintNow(path.join(base, 'f'), 'f', KEY), { exists: true, size: 3, fingerprint: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  assert.deepStrictEqual(fingerprintNow(path.join(base, 'none'), 'none', KEY), { exists: false });
  for (const n of ['d', 'l']) assert.deepStrictEqual(fingerprintNow(path.join(base, n), n, KEY), { exists: true, size: null, fingerprint: null }, n);
  assert.deepStrictEqual(fingerprintNow(path.join(base, 'f', 'under'), 'f/under', KEY), { exists: true, size: null, fingerprint: null }, 'a path through a file: ENOTDIR, unknown');
}));

it(
  'L2 Q11 (2) (a), lines 402-405, guarantee 3: each session\'s own log gets an overlapped mark for every other held session sharing its folder, at the start and at that one\'s end; live and replay read overlap from those marks, so a peer\'s folder removed later changes nothing: a command\'s child change in B is concurrent while A runs, credited once A has ended',
  withBase((base) => {
    const { createLive } = require('../src/opon/intake/live');
    const { as, ns, wall } = require('./helpers-opon');
    const run = (aEnds) => {
      const sub = path.join(base, aEnds ? 'ended' : 'running');
      fs.mkdirSync(sub);
      let now = 0;
      const st = {};
      const logs = {};
      const live = createLive({ key: KEY, clock: () => ({ mono: ns(now), wall: wall(now) }), receive: (m) => logs[m.session_id].append(m), error: (r) => assert.fail(r) });
      logs.ses_a = makeLog(sub, {}, { sessionId: 'ses_a', onRecord: (r) => st.a && live.feed(st.a, r) });
      logs.ses_b = makeLog(sub, {}, { sessionId: 'ses_b', root: logs.ses_a.root, onRecord: (r) => st.b && live.feed(st.b, r) });
      st.a = live.open(logs.ses_a.dir, logs.ses_a.sealedHeader, null);
      live.pair(st.a);
      st.b = live.open(logs.ses_b.dir, logs.ses_b.sealedHeader, null);
      live.pair(st.b);
      if (aEnds) {
        now = 100;
        logs.ses_a.append(as('ses_a', M.sessionEnded(100)));
      }
      for (const [ms, m] of [[200, M.started(200, 'c1', { kind: 'command', text: 'make' }, 'Bash')], [300, M.disk(300, 'src/made.ts')], [400, M.exited(400, 'c1', 'make')], [400, M.turnEnded(400)], [12000, M.tick(12000)]]) {
        now = ms;
        logs.ses_b.append(as('ses_b', m));
      }
      const odu = fs.readFileSync(path.join(logs.ses_b.dir, 'odu.jsonl'), 'utf8');
      const before = replayFolder(logs.ses_b.dir);
      rmrf(logs.ses_a.dir); // the peer's folder removed (retention, test 45, or by hand)
      const after = replayFolder(logs.ses_b.dir);
      const odus = odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      const marks = rawRecords(logs.ses_b.dir).filter((m) => m.says === 'overlapped').map((m) => [m.source, m.target.kind, m.detail.session, m.detail.ended]);
      return { odu, before: before.odu, after: after.odu, made: odus.find((o) => o.target && o.target.path === 'src/made.ts'), marks };
    };
    const running = run(false);
    assert.deepStrictEqual(running.marks, [['process', 'process', 'ses_a', false]], "A named in B's own log when B began");
    assert.deepStrictEqual([running.made.witness_status.glove.status, running.made.witness_status.sentinel.status, running.made.attribution, running.made.conflicts.map((c) => [c.kind, c.sessions])], ['saw_nothing', 'saw', 'unexplained', [['concurrent_sessions', ['ses_a', 'ses_b']]]]);
    assert.strictEqual(running.before, running.odu, 'replay gives the live odù log');
    assert.strictEqual(running.after, running.odu, "and still does with A's folder gone");
    const ended = run(true);
    assert.deepStrictEqual(ended.marks, [['process', 'process', 'ses_a', false], ['process', 'process', 'ses_a', true]], "A's end named in B's own log");
    assert.deepStrictEqual([ended.made.witness_status.glove.status, ended.made.witness_status.sentinel.status, ended.made.attribution, ended.made.cause, ended.made.conflicts], ['saw_nothing', 'saw', 'explained', { kind: 'agent_command', ref: 'c1' }, []]);
    assert.strictEqual(ended.before, ended.odu);
    assert.strictEqual(ended.after, ended.odu);
  }),
);

/** L1d: a session through one router, a restart (a second router over the same home, resumed), then more through the second. */
function restarted(base, between = () => {}) {
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const clock = fakeClock();
  const make = () => createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
  const p = cc(project, 'ses_live3');
  const dir = path.join(home, 'sessions', 'ses_live3');
  const write = (router, id, name, text) => {
    const file = path.join(project, 'src', name);
    router.payload(p.pre('Write', { file_path: file }, id));
    fs.writeFileSync(file, text);
    assert.strictEqual(router.payload(p.post('Write', { file_path: file }, {}, id)).ok, true);
  };
  const polls = (router, n) => {
    for (let i = 0; i < n; i++) {
      clock.advance(600);
      router.poll();
    }
  };
  const one = make();
  assert.strictEqual(one.payload(p.prompt('go'), { channel: 'command' }).ok, true);
  write(one, 'w1', 'a.js', 'a\n');
  assert.strictEqual(one.payload(p.stop('I wrote src/a.js.')).ok, true); // its turn ends, so a.js may seal (C3d2)
  polls(one, 12); // a.js settles, gets its fingerprint and seals, and so does the turn
  assert.strictEqual(one.payload(p.prompt('more'), { channel: 'command' }).ok, true);
  write(one, 'w2', 'b.js', 'b\n'); // b.js still open at the restart
  between(dir);
  clock.advance(2000);
  const two = make();
  const r = two.resume();
  assert.deepStrictEqual(r.failed, []);
  write(two, 'w3', 'c.js', 'c\n');
  assert.strictEqual(two.payload(p.stop('Done.')).ok, true);
  polls(two, 25);
  return { dir, home };
}

it(
  'L1d guarantee 3: after a restart the reopened session is replayed into a fresh engine and its odù log goes on, equal to replay of the whole raw log; one a crash cut short of its last odù is caught up',
  withBase((base) => {
    for (const [name, between] of [
      ['a plain restart', () => {}],
      ['a crash before the last odù was written', (dir) => {
        const f = path.join(dir, 'odu.jsonl');
        const lines = fs.readFileSync(f, 'utf8').split('\n').slice(0, -1);
        assert.ok(lines.length >= 2, 'an odù was written before the restart');
        fs.writeFileSync(f, lines.slice(0, -1).map((l) => l + '\n').join(''));
      }],
    ]) {
      const sub = path.join(base, name.replace(/ /g, '_'));
      fs.mkdirSync(sub);
      const { dir } = restarted(sub, between);
      const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
      const out = replayFolder(dir);
      assert.strictEqual(out.ok, true, out.words);
      assert.strictEqual(live, out.odu, name);
      const odus = live.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      // The restart's gap covers b.js (open at the restart) and c.js (written as it resumed): the Sentinel is down there, from that recorded fact.
      for (const [f, sentinel] of [['src/a.js', 'saw_nothing'], ['src/b.js', 'down'], ['src/c.js', 'down']]) {
        const o = odus.find((x) => x.target && x.target.path === f);
        assert.deepStrictEqual([f, o.witness_status.glove.status, o.witness_status.sentinel.status], [f, 'saw', sentinel], name);
      }
      assert.ok(rawRecords(dir).some((m) => m.says === 'gap'), 'the restart\'s gap is in the raw log, and so in both');
    }
  }),
);

it(
  'L1e LD200 (6): a session begun with the flag off and reopened with it on has its odù log written whole from replay, and the fingerprints replay asks for, of changes settled before the restart, are dropped; later ones are written; live equals replay',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const make = (live) => createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: live });
    const p = cc(project, 'ses_live4');
    const dir = path.join(home, 'sessions', 'ses_live4');
    const write = (router, id, name) => {
      const file = path.join(project, 'src', name);
      router.payload(p.pre('Write', { file_path: file }, id));
      fs.writeFileSync(file, name);
      assert.strictEqual(router.payload(p.post('Write', { file_path: file }, {}, id)).ok, true);
    };
    const polls = (router, n) => {
      for (let i = 0; i < n; i++) {
        clock.advance(600);
        router.poll();
      }
    };
    const off = make(false);
    assert.strictEqual(off.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    write(off, 'w1', 'a.js');
    polls(off, 6); // a.js settles in the raw log's time, with no fingerprint: the flag was off
    assert.strictEqual(fs.existsSync(path.join(dir, 'odu.jsonl')), false);
    clock.advance(1000);
    const on = make(true);
    assert.deepStrictEqual(on.resume().failed, []);
    write(on, 'w2', 'c.js');
    assert.strictEqual(on.payload(p.stop('I wrote src/a.js and src/c.js.')).ok, true);
    polls(on, 25);
    const fps = rawRecords(dir).filter((m) => m.says === 'fingerprinted').map((m) => m.target.path);
    assert.deepStrictEqual(fps, ['src/c.js'], 'a.js settled before the restart: its fingerprint, asked for by the replay, is dropped');
    const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
    assert.strictEqual(live, replayFolder(dir).odu);
    const odus = live.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    const a = odus.find((o) => o.target && o.target.path === 'src/a.js');
    const c = odus.find((o) => o.target && o.target.path === 'src/c.js');
    assert.deepStrictEqual([a.witness_status.glove.status, a.witness_status.sentinel.status, a.net_change.after], ['saw', 'saw_nothing', null], 'no fingerprint, so after is unknown');
    assert.deepStrictEqual([c.witness_status.glove.status, c.witness_status.sentinel.status, typeof c.net_change.after], ['saw', 'down', 'string']);
  }),
);

it(
  'L1f: an odù log that cannot be read at a reopen for a reason other than its absence (a folder in its place) stops that session\'s live engine with a line in the error log; the restart and capture go on',
  withBase((base) => {
    const { dir, home } = restarted(base, (d) => {
      fs.rmSync(path.join(d, 'odu.jsonl'));
      fs.mkdirSync(path.join(d, 'odu.jsonl'));
    });
    const errors = fs.readFileSync(path.join(home, 'intake', 'errors.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(errors.map((e) => e.reason.startsWith('the live Ọpọ́n stopped for session ses_live3: it could not be resumed (EISDIR)')), [true]);
    const says = rawRecords(dir).map((m) => m.says);
    assert.ok(says.includes('gap') && says.includes('claimed'), 'the restart\'s gap and the later marks are written');
  }),
);

it(
  'L1d: an odù log on disk that is not the start of replay\'s is never edited: the live engine stops for that session with a line in the error log, and capture goes on',
  withBase((base) => {
    let kept = null;
    const { dir, home } = restarted(base, (d) => {
      fs.appendFileSync(path.join(d, 'odu.jsonl'), '{"not":"an odù"}\n');
      kept = fs.readFileSync(path.join(d, 'odu.jsonl'), 'utf8');
    });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8'), kept, 'never edited');
    const errors = fs.readFileSync(path.join(home, 'intake', 'errors.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(errors.map((e) => e.reason.startsWith('the live Ọpọ́n stopped for session ses_live3: its odù log on disk is not the start of replay\'s')), [true]);
    assert.ok(rawRecords(dir).some((m) => m.says === 'claimed'), 'capture went on');
  }),
);

it(
  'L2 through the router: two sessions in one folder are each named in the other\'s log when the second begins, the first\'s end is named in the second\'s, and each session\'s odù log equals its replay, before and after the other\'s folder is removed; with the flag off no overlapped mark is written',
  withBase((base) => {
    for (const on of [true, false]) {
      const sub = path.join(base, on ? 'on' : 'off');
      const home = path.join(sub, 'home');
      const project = path.join(sub, 'project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      const clock = fakeClock();
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: on });
      const a = cc(project, 'ses_pa');
      const b = cc(project, 'ses_pb');
      const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
      send(a.prompt('one'));
      clock.advance(100);
      send(b.prompt('two'));
      clock.advance(100);
      send({ session_id: 'ses_pa', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' });
      const file = path.join(project, 'src', 'b.js');
      send(b.pre('Write', { file_path: file }, 'w1'));
      fs.writeFileSync(file, 'b\n');
      send(b.post('Write', { file_path: file }, {}, 'w1'));
      send(b.stop('I wrote src/b.js.'));
      for (let i = 0; i < 25; i++) {
        clock.advance(600);
        router.poll();
      }
      const dir = (id) => path.join(home, 'sessions', id);
      const named = (id) => rawRecords(dir(id)).filter((m) => m.says === 'overlapped').map((m) => [m.detail.session, m.detail.ended]);
      if (!on) {
        assert.deepStrictEqual([named('ses_pa'), named('ses_pb')], [[], []]);
        continue;
      }
      assert.deepStrictEqual([named('ses_pa'), named('ses_pb')], [[['ses_pb', false]], [['ses_pa', false], ['ses_pa', true]]]);
      const { compile } = require('../src/verify/schema');
      const checkMark = compile(JSON.parse(fs.readFileSync(path.join(SRC, '..', 'spec', 'mark.schema.json'), 'utf8')));
      const [began, endedMark] = rawRecords(dir('ses_pb')).filter((m) => m.says === 'overlapped');
      assert.deepStrictEqual([checkMark(began), checkMark(endedMark), typeof endedMark.detail.to], [[], [], 'string']);
      const { to: _to, ...noTo } = endedMark.detail;
      assert.ok(checkMark({ ...endedMark, detail: noTo }).length > 0, 'an ended session is named with its end');
      assert.ok(checkMark({ ...began, detail: { ...began.detail, to: endedMark.detail.to } }).length > 0, 'one not ended has no end');
      const odu = fs.readFileSync(path.join(dir('ses_pb'), 'odu.jsonl'), 'utf8');
      assert.strictEqual(replayFolder(dir('ses_pb')).odu, odu);
      const bjs = odu.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.path === 'src/b.js');
      assert.deepStrictEqual([bjs.witness_status.glove.status, bjs.witness_status.sentinel.status], ['saw', 'saw_nothing']);
      assert.strictEqual(replayFolder(dir('ses_pa')).odu, fs.readFileSync(path.join(dir('ses_pa'), 'odu.jsonl'), 'utf8'));
      rmrf(dir('ses_pa'));
      assert.strictEqual(replayFolder(dir('ses_pb')).odu, odu, "A's folder gone, B's replay unchanged");
    }
  }),
);

it(
  'K5 lines 445-452 (LD208; provisional, Q17): with the live flag, a lag grace after the session ends the intake runs the closeout: the sweep\'s marks, a rescan mark for each file that differs from the baseline, and every group sealed; a hand change no witness saw becomes missed_live; live equals replay; flag off, no sweep',
  withBase((base) => {
    for (const on of [true, false]) {
      const sub = path.join(base, on ? 'on' : 'off');
      const home = path.join(sub, 'home');
      const project = path.join(sub, 'project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.writeFileSync(path.join(project, 'src', 'old.js'), 'old\n');
      fs.writeFileSync(path.join(project, 'src', 'same.js'), 'same\n');
      fs.writeFileSync(path.join(project, 'src', 'gone.js'), 'gone\n');
      const clock = fakeClock();
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: on });
      const p = cc(project, 'ses_k5');
      const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
      const old = path.join(project, 'src', 'old.js');
      send(p.prompt('go'));
      send(p.pre('Edit', { file_path: old }, 'w1'));
      fs.writeFileSync(old, 'new\n');
      send(p.post('Edit', { file_path: old }, {}, 'w1'));
      send(p.stop('I edited src/old.js.'));
      fs.writeFileSync(path.join(project, 'src', 'hand.js'), 'by hand\n'); // no hook, no Sentinel here: only the rescan can see it
      fs.rmSync(path.join(project, 'src', 'gone.js')); // a baseline file removed by hand
      clock.advance(100);
      send({ session_id: 'ses_k5', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' });
      for (let i = 0; i < 15; i++) {
        clock.advance(600);
        router.poll();
      }
      const dir = path.join(home, 'sessions', 'ses_k5');
      const raw = rawRecords(dir);
      const sweepSays = raw.filter((m) => m.target && m.target.kind === 'process' && m.target.name === 'closeout').map((m) => m.says);
      const rescanned = raw.filter((m) => m.says === 'fingerprinted' && m.detail.rescan === true).map((m) => m.target.path).sort();
      if (!on) {
        assert.deepStrictEqual([sweepSays, rescanned, fs.existsSync(path.join(dir, 'odu.jsonl'))], [[], [], false]);
        continue;
      }
      assert.deepStrictEqual([sweepSays, rescanned], [['started', 'exited'], ['src/gone.js', 'src/hand.js', 'src/old.js']], 'the files that differ from the baseline; same.js not');
      assert.deepStrictEqual(raw.filter((m) => m.detail && m.detail.rescan === true && m.target.path === 'src/gone.js').map((m) => m.detail.exists), [false]);
      const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
      const out = replayFolder(dir);
      assert.strictEqual(live, out.odu);
      assert.deepStrictEqual(out.lines.slice(1).map((l) => JSON.parse(l)).filter((g) => g.state !== 'sealed'), [], 'nothing left unsealed');
      const odus = live.split('\n').slice(1, -1).map((l) => JSON.parse(l));
      const hand = odus.find((o) => o.target && o.target.path === 'src/hand.js');
      assert.deepStrictEqual([hand.witness_status.glove.status, hand.witness_status.sentinel.status, hand.action, hand.conflicts.map((c) => c.kind)], ['saw_nothing', 'saw_nothing', 'created', ['missed_live']]);
      const gone = odus.find((o) => o.target && o.target.path === 'src/gone.js');
      assert.deepStrictEqual([gone.witness_status.glove.status, gone.witness_status.sentinel.status, gone.action, gone.conflicts.map((c) => c.kind)], ['saw_nothing', 'saw_nothing', 'deleted', ['missed_live']]);
      const edited = odus.filter((o) => o.target && o.target.path === 'src/old.js');
      assert.deepStrictEqual(edited.map((o) => [o.witness_status.glove.status, o.conflicts.map((c) => c.kind)]), [['saw', ['unconfirmed_by_filesystem']]], 'the agent edit: one odù, not missed');
    }
  }),
);

it(
  'K4 line 454 (LD209; provisional, Q17): at the closeout\'s end the live intake writes footer.json naming the raw log\'s and the odù log\'s last lines by seq and hash, the verdict log not yet (Phase 6); verify checks it, and names a footer whose hash its log does not hold',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const p = cc(project, 'ses_k4');
    assert.strictEqual(router.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    assert.strictEqual(router.payload(p.stop('Nothing to do.')).ok, true);
    assert.strictEqual(router.payload({ session_id: 'ses_k4', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' }).ok, true);
    for (let i = 0; i < 10; i++) {
      clock.advance(600);
      router.poll();
    }
    const dir = path.join(home, 'sessions', 'ses_k4');
    const footer = JSON.parse(fs.readFileSync(path.join(dir, 'footer.json'), 'utf8'));
    const raw = rawRecords(dir);
    const exited = raw.find((m) => m.target && m.target.name === 'closeout' && m.says === 'exited');
    const odu = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual([footer.record, footer.session_id, footer.raw, footer.odu, footer.verdict], ['session_footer', 'ses_k4', { seq: exited.seq, hash: exited.hash }, { seq: odu[odu.length - 1].seq, hash: odu[odu.length - 1].hash }, null]);
    const { compile } = require('../src/verify/schema');
    const checkFooter = compile(JSON.parse(fs.readFileSync(path.join(SRC, '..', 'spec', 'session-footer.schema.json'), 'utf8')));
    assert.deepStrictEqual(checkFooter(footer), []);
    const { verifySession } = require('../src/verify/session');
    const v = verifySession(dir);
    assert.deepStrictEqual([v.ok, v.words.includes('the session footer matches the raw log and the odù log')], [true, true], v.words);
    fs.writeFileSync(path.join(dir, 'footer.json'), JSON.stringify({ ...footer, raw: { ...footer.raw, hash: 'sha256:' + '0'.repeat(64) } }));
    const bad = verifySession(dir);
    assert.deepStrictEqual([bad.ok, bad.words], [false, `Record broken: the session footer names line ${footer.raw.seq + 1} of the raw log with a hash that line does not have.`]);
    fs.writeFileSync(path.join(dir, 'footer.json'), JSON.stringify({ ...footer, odu: { ...footer.odu, hash: 'sha256:' + '0'.repeat(64) } }));
    const badOdu = verifySession(dir);
    assert.deepStrictEqual([badOdu.ok, badOdu.words], [false, `Record broken: the session footer names line ${footer.odu.seq + 1} of the odù log with a hash that line does not have.`]);
  }),
);

it(
  'K5b (LD210 (1)): a restart inside the lag grace after the session ended still runs the closeout, once; a session swept before a restart is never swept again, though another SessionEnd comes',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const make = () => createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const polls = (router, n) => {
      for (let i = 0; i < n; i++) {
        clock.advance(600);
        router.poll();
      }
    };
    const p = cc(project, 'ses_k5b');
    const end = { session_id: 'ses_k5b', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' };
    const one = make();
    assert.strictEqual(one.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    assert.strictEqual(one.payload(end).ok, true);
    polls(one, 1); // inside the lag grace: no sweep yet
    const dir = path.join(home, 'sessions', 'ses_k5b');
    const sweeps = () => rawRecords(dir).filter((m) => m.target && m.target.kind === 'process' && m.target.name === 'closeout').map((m) => m.says);
    assert.deepStrictEqual(sweeps(), []);
    const two = make(); // the restart
    assert.deepStrictEqual(two.resume().failed, []);
    polls(two, 10);
    assert.deepStrictEqual(sweeps(), ['started', 'exited'], 'swept after the restart');
    assert.ok(fs.existsSync(path.join(dir, 'footer.json')));
    const three = make(); // another restart, and another SessionEnd
    assert.deepStrictEqual(three.resume().failed, []);
    assert.strictEqual(three.payload(end).ok, true);
    polls(three, 10);
    assert.deepStrictEqual(sweeps(), ['started', 'exited'], 'never swept twice');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8'), replayFolder(dir).odu);
  }),
);

it(
  'K5c (LD210 (2)): a file the agent changed and a hand then put back to its baseline bytes is rescanned, and the change no witness saw is missed_live; live equals replay',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'old.js'), 'old\n');
    const clock = fakeClock();
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const p = cc(project, 'ses_k5c');
    const old = path.join(project, 'src', 'old.js');
    const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
    send(p.prompt('go'));
    send(p.pre('Edit', { file_path: old }, 'w1'));
    fs.writeFileSync(old, 'new\n');
    send(p.post('Edit', { file_path: old }, {}, 'w1'));
    send(p.stop('I edited src/old.js.'));
    for (let i = 0; i < 12; i++) {
      clock.advance(600);
      router.poll();
    }
    fs.writeFileSync(old, 'old\n'); // a hand puts the baseline bytes back
    send({ session_id: 'ses_k5c', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' });
    for (let i = 0; i < 10; i++) {
      clock.advance(600);
      router.poll();
    }
    const dir = path.join(home, 'sessions', 'ses_k5c');
    const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
    assert.strictEqual(live, replayFolder(dir).odu);
    const odus = live.split('\n').slice(1, -1).map((l) => JSON.parse(l)).filter((o) => o.target && o.target.path === 'src/old.js');
    assert.deepStrictEqual(odus.map((o) => [o.witness_status.glove.status, o.witness_status.sentinel.status, o.action, o.conflicts.map((c) => c.kind)]), [['saw', 'saw_nothing', 'modified', ['unconfirmed_by_filesystem']], ['saw_nothing', 'saw_nothing', 'modified', ['missed_live']]]);
    assert.strictEqual(odus[1].net_change.before, odus[0].net_change.after, 'the revert, from what the edit left');
  }),
);

it(
  'K1b (LD210 (3)): a group that settles inside the closeout\'s exited step is sealed with what it has, and no fingerprint is written after exited; nothing is left unsealed',
  withBase((base) => {
    const { createLive } = require('../src/opon/intake/live');
    const { ns, wall } = require('./helpers-opon');
    let now = 0;
    let st = null;
    let log = null;
    const live = createLive({ key: KEY, clock: () => ({ mono: ns(now), wall: wall(now) }), receive: (m) => log.append(m), error: (r) => assert.fail(r) });
    log = makeLog(base, {}, { onRecord: (r) => st && live.feed(st, r) });
    st = live.open(log.dir, log.sealedHeader, null);
    const sweepMark = (ms, says) => ({ schema_version: 1, session_id: 'ses_replay_test', source: 'process', agent: null, turn: null, sub_agent: null, observed_at: wall(ms), mono_ns: ns(ms), cause_hint: null, target: { kind: 'process', name: 'closeout' }, says, detail: says === 'exited' ? { exit_status: 'pass' } : {} });
    for (const [ms, m] of [[9000, M.disk(9000, 'src/x.ts')], [10000, sweepMark(10000, 'started')], [11000, sweepMark(11000, 'exited')]]) {
      now = ms;
      log.append(m);
    }
    const raw = rawRecords(log.dir);
    const exited = raw.findIndex((m) => m.says === 'exited' && m.target && m.target.name === 'closeout');
    assert.deepStrictEqual(raw.slice(exited + 1).map((m) => m.says), [], 'nothing after the closeout\'s end');
    const out = replayFolder(log.dir);
    assert.deepStrictEqual(out.lines.slice(1).map((l) => JSON.parse(l)).filter((g) => g.state !== 'sealed').map((g) => g.target), []);
    const x = out.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.path === 'src/x.ts');
    assert.deepStrictEqual([x.witness_status.glove.status, x.witness_status.sentinel.status, x.net_change.after], ['saw_nothing', 'saw', null]);
  }),
);

it(
  'K4b (LD210 (5)): verify checks the odù log\'s own chain when the footer names it, and that the footer names the closeout\'s exited mark and this session',
  withBase((base) => {
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const p = cc(project, 'ses_k4b');
    assert.strictEqual(router.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    assert.strictEqual(router.payload(p.stop('Nothing to do.')).ok, true);
    assert.strictEqual(router.payload({ session_id: 'ses_k4b', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' }).ok, true);
    for (let i = 0; i < 10; i++) {
      clock.advance(600);
      router.poll();
    }
    const dir = path.join(home, 'sessions', 'ses_k4b');
    const { verifySession } = require('../src/verify/session');
    const footerFile = path.join(dir, 'footer.json');
    const footer = JSON.parse(fs.readFileSync(footerFile, 'utf8'));
    const raw = rawRecords(dir);
    const first = raw[1];
    const words = (f) => {
      fs.writeFileSync(footerFile, JSON.stringify(f));
      const v = verifySession(dir);
      return [v.ok, v.words];
    };
    assert.deepStrictEqual(words({ ...footer, raw: { seq: first.seq, hash: first.hash } }), [false, `Record broken: the session footer names line ${first.seq + 1} of the raw log, which is not the closeout's end.`]);
    assert.deepStrictEqual(words({ ...footer, session_id: 'ses_other' }), [false, 'Record broken: the session footer names another session.']);
    fs.writeFileSync(footerFile, JSON.stringify(footer));
    const oduFile = path.join(dir, 'odu.jsonl');
    const lines = fs.readFileSync(oduFile, 'utf8').split('\n');
    const odu1 = JSON.parse(lines[1]);
    lines[1] = JSON.stringify({ ...odu1, action: 'deleted' });
    fs.writeFileSync(oduFile, lines.join('\n'));
    const v = verifySession(dir);
    assert.deepStrictEqual([v.ok, v.words.startsWith('Record broken at line 2 of the odù log')], [false, true], v.words);
  }),
);

it(
  'K4c (LD211 (4), LD214; Q22 checklist rows footer-*): a line the footer names, edited or cut short, breaks the record in either log; a whole line after it is a late delivery (intact); a line cut after it is a crash, excused only in the odù log; a footer that is not one is broken',
  withBase((base) => {
    const { seal } = require('../src/verify/chain');
    const { canonicalize } = require('../src/verify/canonical');
    const { verifySession } = require('../src/verify/session');
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
    const p = cc(project, 'ses_k4c');
    assert.strictEqual(router.payload(p.prompt('go'), { channel: 'command' }).ok, true);
    assert.strictEqual(router.payload(p.stop('Nothing to do.')).ok, true);
    assert.strictEqual(router.payload({ session_id: 'ses_k4c', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' }).ok, true);
    for (let i = 0; i < 10; i++) {
      clock.advance(600);
      router.poll();
    }
    const dir = path.join(home, 'sessions', 'ses_k4c');
    const files = { raw: path.join(dir, 'raw.jsonl'), odu: path.join(dir, 'odu.jsonl'), footer: path.join(dir, 'footer.json') };
    const kept = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
    const footer = JSON.parse(kept.footer);
    const restore = () => Object.entries(files).forEach(([k, f]) => fs.writeFileSync(f, kept[k]));
    const lines = (k) => kept[k].split('\n').slice(0, -1);
    const verdict = (k, text) => {
      restore();
      fs.writeFileSync(files[k], text);
      const v = verifySession(dir);
      return [v.ok, v.words];
    };
    assert.deepStrictEqual(verdict('raw', kept.raw)[0], true, 'intact as written');
    for (const k of ['raw', 'odu']) {
      const named = footer[k].seq; // the index of the line it names
      assert.strictEqual(named, lines(k).length - 1, `${k}: the footer names its log's last line`);
      const last = JSON.parse(lines(k)[named]);
      const edited = canonicalize({ ...last, observed_at: '2000-01-01T00:00:00.000Z' });
      const before = lines(k).slice(0, named);
      // footer-*-named-edited: the named line edited, its hash field kept
      assert.deepStrictEqual(verdict(k, [...before, edited].join('\n') + '\n')[0], false, `${k}: the named line edited`);
      // footer-*-named-cut: the same edit, the line left without its line feed, as a crash leaves a line
      const cut = verdict(k, [...before, edited].join('\n'));
      assert.deepStrictEqual([cut[0], cut[1].startsWith('Record broken')], [false, true], `${k}: the named line edited and cut short: ${cut[1]}`);
      // footer-raw-before-edited (the odù log's is K4b's): a line before the named one edited
      if (k === 'raw') assert.deepStrictEqual(verdict(k, [lines(k)[0], canonicalize({ ...JSON.parse(lines(k)[1]), observed_at: '2000-01-01T00:00:00.000Z' }), ...lines(k).slice(2)].join('\n') + '\n')[0], false, 'raw: a line before');
      // footer-*-after-appended: a whole line after the named one, sealed to it (a late delivery)
      const next = canonicalize(seal({ ...last, seq: last.seq + 1 }, last.hash));
      const late = verdict(k, kept[k] + next + '\n');
      assert.deepStrictEqual(late, [true, late[1]], `${k}: a late delivery after the footer's line`);
      assert.ok(late[1].includes('the session footer matches'), late[1]);
      // footer-*-after-cut: a line after the named one cut by a crash
      const crash = verdict(k, kept[k] + next.slice(0, 40));
      assert.deepStrictEqual(crash[0], k === 'odu', `${k}: a cut after the footer's line: ${crash[1]}`);
    }
    // footer-not-json
    restore();
    fs.writeFileSync(files.footer, '{');
    assert.deepStrictEqual([verifySession(dir).ok, verifySession(dir).words], [false, 'Record broken: the session footer is not JSON.']);
    fs.writeFileSync(files.footer, '{}');
    assert.deepStrictEqual([verifySession(dir).ok, verifySession(dir).words], [false, 'Record broken: the session footer is not a valid footer.']);
    restore();
  }),
);

it(
  'K7 tests 4 and 73 live (LD216): a phantom file claim is sealed at the closeout, high when the rescan walked the file and found it unchanged; a walk that fails ends the sweep with exit_status fail, and the claim is low; live equals replay',
  withBase((base) => {
    for (const walk of ['ok', 'fails']) {
      const sub = path.join(base, walk);
      const home = path.join(sub, 'home');
      const project = path.join(sub, 'project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.writeFileSync(path.join(project, 'src', 'a.js'), 'a\n');
      const clock = fakeClock();
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
      const p = cc(project, 'ses_k7');
      const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
      send(p.prompt('go'));
      send(p.stop('I updated src/a.js.'));
      send({ session_id: 'ses_k7', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' });
      if (walk === 'fails') fs.rmSync(project, { recursive: true, force: true }); // the root gone before the sweep: its walk throws
      for (let i = 0; i < 10; i++) {
        clock.advance(600);
        router.poll();
      }
      const dir = path.join(home, 'sessions', 'ses_k7');
      const exited = rawRecords(dir).find((m) => m.target && m.target.name === 'closeout' && m.says === 'exited');
      assert.deepStrictEqual(exited.detail, { exit_status: walk === 'ok' ? 'pass' : 'fail' }, walk);
      const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
      assert.strictEqual(live, replayFolder(dir).odu, `${walk}: live equals replay`);
      const claim = live.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.kind === 'claim' && o.conflicts.some((c) => c.kind === 'phantom_claim'));
      assert.deepStrictEqual([claim.witness_status.glove.status, claim.witness_status.sentinel.status, claim.conflicts[0].why, claim.confidence], ['saw', 'out_of_scope', 'no_event', walk === 'ok' ? 'high' : 'low'], walk);
    }
  }),
);

it(
  'K3 step 3 live (LD217): at the closeout the intake runs git status and writes a git mark only for a path git lists and the rescan marked: a hand change no live witness saw is high with git in its witness_status; a file dirty before the session gets none; no git work tree, no git marks; live equals replay',
  withBase((base) => {
    const { spawnSync } = require('child_process');
    for (const repo of [true, false]) {
      const sub = path.join(base, repo ? 'repo' : 'plain');
      const home = path.join(sub, 'home');
      const project = path.join(sub, 'project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      for (const n of ['a', 'b']) fs.writeFileSync(path.join(project, 'src', `${n}.js`), `${n}\n`);
      if (repo) {
        const git = (...args) => assert.strictEqual(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).status, 0, args.join(' '));
        git('init', '-q');
        git('add', '-A');
        git('commit', '-q', '--no-verify', '-m', 'base');
        fs.writeFileSync(path.join(project, 'src', 'a.js'), 'dirty before the session\n');
      }
      const clock = fakeClock();
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true });
      const p = cc(project, 'ses_k3');
      const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
      send(p.prompt('go'));
      send(p.stop('Nothing to do.'));
      fs.writeFileSync(path.join(project, 'src', 'b.js'), 'by hand\n'); // no hook, no Sentinel here
      send({ session_id: 'ses_k3', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'clear' });
      for (let i = 0; i < 10; i++) {
        clock.advance(600);
        router.poll();
      }
      const dir = path.join(home, 'sessions', 'ses_k3');
      const gitMarks = rawRecords(dir).filter((m) => m.source === 'git').map((m) => [m.target.path, m.says]);
      assert.deepStrictEqual(gitMarks, repo ? [['src/b.js', 'modified']] : [], `${repo}: git marks`);
      const live = fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8');
      assert.strictEqual(live, replayFolder(dir).odu, `${repo}: live equals replay`);
      const b = live.split('\n').slice(1, -1).map((l) => JSON.parse(l)).find((o) => o.target && o.target.path === 'src/b.js');
      assert.deepStrictEqual([b.witness_status.glove.status, b.witness_status.sentinel.status, b.witness_status.git ? b.witness_status.git.status : null, b.confidence, b.conflicts.map((c) => c.kind)], ['saw_nothing', 'saw_nothing', repo ? 'saw' : null, repo ? 'high' : 'medium', ['missed_live']], `${repo}`);
    }
  }),
);

runAll('opon-live');
