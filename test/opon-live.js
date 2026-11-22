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
  'L1c LD200 (5), lines 402-405: live, a session sharing the folder counts as active while it is held and stops at its end mark: a command\'s child change in B is credited when A ended before it, and is unexplained with concurrent_sessions while A runs',
  withBase((base) => {
    const { createLive } = require('../src/opon/intake/live');
    const { as } = require('./helpers-opon');
    const run = (aEnds) => {
      const spans = [];
      const live = createLive({ spans, key: KEY, clock: () => ({ mono: '0', wall: '2026-11-23T00:00:00.000Z' }), receive: () => {}, error: (r) => assert.fail(r) });
      const sub = path.join(base, aEnds ? 'ended' : 'running');
      fs.mkdirSync(sub);
      const la = makeLog(sub, {}, { sessionId: 'ses_a' });
      const lb = makeLog(sub, {}, { sessionId: 'ses_b', root: la.root });
      const A = live.open(la.dir, { ...la.header, hash: 'sha256:' + 'a'.repeat(64) }, null);
      const B = live.open(lb.dir, { ...lb.header, hash: 'sha256:' + 'b'.repeat(64) }, null);
      let seq = 0;
      if (aEnds) live.feed(A, { ...as('ses_a', M.sessionEnded(100)), seq: 1 });
      for (const m of [M.started(200, 'c1', { kind: 'command', text: 'make' }, 'Bash'), M.disk(300, 'src/made.ts'), M.exited(400, 'c1', 'make'), M.turnEnded(400), M.tick(12000)]) live.feed(B, { ...as('ses_b', m), seq: ++seq });
      const odus = fs.readFileSync(path.join(lb.dir, 'odu.jsonl'), 'utf8').split('\n').slice(1, -1).map((l) => JSON.parse(l));
      return { spans, made: odus.find((o) => o.target && o.target.path === 'src/made.ts') };
    };
    const ended = run(true);
    assert.deepStrictEqual(ended.spans.find((s) => s.id === 'ses_a').ended, true);
    assert.deepStrictEqual([ended.made.witness_status.glove.status, ended.made.witness_status.sentinel.status, ended.made.attribution, ended.made.cause, ended.made.conflicts], ['saw_nothing', 'saw', 'explained', { kind: 'agent_command', ref: 'c1' }, []]);
    const running = run(false);
    assert.deepStrictEqual([running.made.witness_status.glove.status, running.made.witness_status.sentinel.status, running.made.attribution, running.made.conflicts.map((c) => [c.kind, c.sessions])], ['saw_nothing', 'saw', 'unexplained', [['concurrent_sessions', ['ses_a', 'ses_b']]]]);
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

runAll('opon-live');
