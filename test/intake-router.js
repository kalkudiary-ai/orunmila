'use strict';

/**
 * test/intake-router.js — the intake's router: raw Claude Code hook payloads in,
 * marks in each session's log (Phase 1 slice B1d; brief v4 station 1; design
 * D-I 4.3; tests 14, 28, 54, 62, 63, 75, 76, 84 at the router; LD122-LD124).
 * Payloads are hand-built in the shapes Claude Code sends; the project and
 * Orunmila's home are throwaway folders. Nothing here reads recorded data.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const { verifySessionLog } = require('../src/opon/ledger/session-log');
const { isCaseInsensitive } = require('../src/opon/intake/paths');

const MS = 1000000n;
const KEY = Buffer.alloc(32, 7);
const SRC = path.join(__dirname, '..', 'src');

function fakeClock() {
  let mono = 5000n * MS;
  let wall = Date.UTC(2026, 10, 22, 9, 0, 0, 0);
  const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
  clock.advance = (ms) => {
    mono += BigInt(ms) * MS;
    wall += ms;
  };
  return clock;
}

/** A router over a throwaway home and project; `opts` override its options. */
function withRouter(fn, opts = {}) {
  return () => {
    const base = tmpDir();
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const clock = fakeClock();
    const make = (more = {}) =>
      createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], ...opts, ...more });
    try {
      fn({ router: make(), make, home, project, clock, dir: (id) => path.join(home, 'sessions', id) });
    } finally {
      rmrf(base);
    }
  };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);
const raw = (dir) => lines(path.join(dir, 'raw.jsonl'));
const marks = (dir) => raw(dir).slice(1);
const outcomes = (dir) => marks(dir).filter((m) => m.says !== 'started'); // a PreToolUse writes a started mark (NF17)

function cc(project, sid = 'ses_r1') {
  const base = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  return {
    start: () => ({ ...base, hook_event_name: 'SessionStart', source: 'startup' }),
    prompt: (prompt) => ({ ...base, hook_event_name: 'UserPromptSubmit', prompt }),
    pre: (tool_name, tool_input, id) => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: id }),
    post: (tool_name, tool_input, tool_response, id) => ({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: id }),
    fail: (tool_name, tool_input, error, id) => ({ ...base, hook_event_name: 'PostToolUseFailure', tool_name, tool_input, error, tool_use_id: id }),
    stop: (text) => ({ ...base, hook_event_name: 'Stop', last_assistant_message: text }),
    end: () => ({ ...base, hook_event_name: 'SessionEnd', reason: 'clear' }),
  };
}

it(
  'first contact (SessionStart) makes the session log with its header in Orunmila\'s home, outside the project, and writes no mark',
  withRouter(({ router, project, dir }) => {
    const r = router.payload(cc(project).start(), { channel: 'command' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const [header, ...rest] = raw(dir('ses_r1'));
    assert.deepStrictEqual([header.record, header.session_id, header.project_root, header.agent.name], ['session_header', 'ses_r1', fs.realpathSync(project), 'claude-code']);
    assert.deepStrictEqual(rest, []);
    assert.strictEqual(verifySessionLog(dir('ses_r1')).ok, true);
  }),
);

it(
  'test 63: two prompts, three tool calls and a claim share one turn, then its end; a continuation with no prompt is a new turn with no prompted mark (test 75)',
  withRouter(({ router, project, dir }) => {
    const p = cc(project);
    const send = (x) => assert.strictEqual(router.payload(x, { channel: 'command' }).ok, true, x.hook_event_name);
    send(p.prompt('fix it'));
    send(p.prompt('also the docs'));
    for (const id of ['a', 'b', 'c']) {
      send(p.pre('Bash', { command: 'true' }, id));
      send(p.post('Bash', { command: 'true' }, { stdout: '', stderr: '' }, id));
    }
    send(p.stop('Done.'));
    send(p.pre('Bash', { command: 'true' }, 'd'));
    const ms = marks(dir('ses_r1'));
    const t1 = ms.filter((m) => m.turn === 't1');
    assert.deepStrictEqual(t1.map((m) => m.says), ['prompted', 'prompted', 'started', 'exited', 'started', 'exited', 'started', 'exited', 'claimed', 'ended']);
    const t2 = ms.filter((m) => m.turn === 't2');
    assert.deepStrictEqual(t2.map((m) => m.says), ['started']);
    assert.strictEqual(verifySessionLog(dir('ses_r1')).ok, true);
  }),
);

it(
  'test 76: a Stop for a turn whose prompt hook never fired writes no prompted mark',
  withRouter(({ router, project, dir }) => {
    router.payload(cc(project).stop('ok'), { channel: 'command' });
    assert.deepStrictEqual(marks(dir('ses_r1')).map((m) => [m.turn, m.says]), [['t1', 'claimed'], ['t1', 'ended']]);
  }),
);

it(
  'a write: before measured at PreToolUse, after at PostToolUse: created with its diff kept, then modified with both fingerprints; no PreToolUse leaves the before-state null',
  withRouter(({ router, project, dir }) => {
    const p = cc(project);
    const file = path.join(project, 'src', 'n.js');
    router.payload(p.pre('Write', { file_path: file, content: 'a\n' }, 'w1'));
    fs.writeFileSync(file, 'a\n');
    assert.strictEqual(router.payload(p.post('Write', { file_path: file, content: 'a\n' }, {}, 'w1')).ok, true);
    router.payload(p.pre('Edit', { file_path: file }, 'w2'));
    fs.writeFileSync(file, 'b\nc\n');
    router.payload(p.post('Edit', { file_path: file }, {}, 'w2'));
    fs.writeFileSync(file, 'd\n');
    router.payload(p.post('Edit', { file_path: file }, {}, 'w3'));
    const [created, modified, blind] = outcomes(dir('ses_r1'));
    assert.deepStrictEqual([created.says, created.target, 'fingerprint_before' in created.detail, created.detail.lines_added], ['created', { kind: 'file', path: 'src/n.js' }, false, 1]);
    const kept = fs.readFileSync(path.join(dir('ses_r1'), 'files', created.detail.diff_ref.slice(7)), 'utf8');
    assert.ok(kept.includes('+a'), kept);
    assert.deepStrictEqual([modified.says, modified.detail.fingerprint_before, modified.detail.fingerprint, modified.detail.lines_added, modified.detail.lines_removed], ['modified', created.detail.fingerprint, modified.detail.fingerprint, 2, 1]);
    assert.notStrictEqual(modified.detail.fingerprint, created.detail.fingerprint);
    assert.deepStrictEqual([blind.says, blind.detail.fingerprint_before, blind.detail.lines_added, 'diff_ref' in blind.detail], ['modified', null, null, false]);
    assert.strictEqual(verifySessionLog(dir('ses_r1')).ok, true);
  }),
);

it(
  'test 55: a read carries the size and fingerprint of the whole file at hook time, and the extent its result states',
  withRouter(({ router, project, dir }) => {
    const file = path.join(project, 'src', 'r.js');
    fs.writeFileSync(file, '1\n2\n3\n');
    router.payload(cc(project).post('Read', { file_path: file, offset: 1, limit: 1 }, { type: 'text', file: { numLines: 1, startLine: 1, totalLines: 3 } }, 'r1'));
    const [m] = marks(dir('ses_r1'));
    assert.deepStrictEqual([m.says, m.detail.read_kind, m.detail.size, m.detail.read_range.total_lines], ['read', 'range', 6, 3]);
    assert.match(m.detail.fingerprint, /^sha256:/);
  }),
);

it(
  'test 14: two spellings of one file are one target; a path outside the project keeps its real path, outside: true',
  withRouter(({ router, project, dir }) => {
    fs.writeFileSync(path.join(project, 'src', 'A.ts'), 'x\n');
    const p = cc(project);
    router.payload(p.post('Read', { file_path: './src/A.ts' }, {}, 'r1'));
    router.payload(p.post('Read', { file_path: path.join(project, 'src', 'A.ts') }, {}, 'r2'));
    const out = path.join(path.dirname(project), 'elsewhere.txt');
    fs.writeFileSync(out, 'y\n');
    router.payload(p.post('Read', { file_path: out }, {}, 'r3'));
    const [a, b, o] = marks(dir('ses_r1'));
    const want = isCaseInsensitive(project) ? 'src/a.ts' : 'src/A.ts';
    assert.deepStrictEqual([a.target.path, b.target.path], [want, want]);
    assert.deepStrictEqual(o.target, { kind: 'file', path: fs.realpathSync(out), outside: true });
  }),
);

it(
  'test 54, mark side: a .env change is recorded with a keyed fingerprint and no diff, and its values reach no file in the session folder',
  withRouter(({ router, project, dir }) => {
    const env = path.join(project, '.env');
    fs.writeFileSync(env, 'API_TOKEN=first-secret-value-123\n');
    const p = cc(project);
    router.payload(p.start());
    router.payload(p.pre('Edit', { file_path: env }, 'e1'));
    fs.writeFileSync(env, 'API_TOKEN=second-secret-value-456\n');
    router.payload(p.post('Edit', { file_path: env }, {}, 'e1'));
    const [m] = outcomes(dir('ses_r1'));
    assert.deepStrictEqual([m.says, 'diff_ref' in m.detail], ['modified', false]);
    assert.match(m.detail.fingerprint, /^hmac-sha256:/);
    assert.match(m.detail.fingerprint_before, /^hmac-sha256:/);
    const all = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(fs.readFileSync(path.join(d, e.name), 'utf8'))));
    walk(dir('ses_r1'));
    for (const text of all) for (const v of ['first-secret-value-123', 'second-secret-value-456']) assert.ok(!text.includes(v), 'a .env value reached the session folder');
  }),
);

it(
  'test 62, mark side: a file over the diff size limit is created with no_diff too_large and no fingerprint_before',
  withRouter(
    ({ router, project, dir }) => {
      const file = path.join(project, 'big.txt');
      const p = cc(project);
      router.payload(p.pre('Write', { file_path: file }, 'w1'));
      fs.writeFileSync(file, 'z'.repeat(200) + '\n');
      router.payload(p.post('Write', { file_path: file }, {}, 'w1'));
      const [m] = outcomes(dir('ses_r1'));
      assert.deepStrictEqual([m.says, m.detail.no_diff, 'fingerprint_before' in m.detail, m.detail.size], ['created', 'too_large', false, 201]);
    },
    { config: { diff_size_limit_bytes: 100 } },
  ),
);

it(
  'NF30: a changed text file whose diff comes back empty (no diff program) is a gap naming what was lost, never silence',
  withRouter(
    ({ router, project, dir }) => {
      const file = path.join(project, 'g.txt');
      const p = cc(project);
      router.payload(p.pre('Write', { file_path: file }, 'w1'));
      fs.writeFileSync(file, 'q\n');
      router.payload(p.post('Write', { file_path: file }, {}, 'w1'));
      const ms = outcomes(dir('ses_r1'));
      assert.deepStrictEqual(ms.map((m) => m.says), ['created', 'gap']);
      assert.deepStrictEqual([ms[1].source, ms[1].target], ['process', { kind: 'file', path: 'g.txt' }]);
      assert.ok(ms[1].detail.lost.includes('diff'), ms[1].detail.lost);
    },
    { diff: () => '' },
  ),
);

it(
  'test 28, LD124: a payload the adapter cannot translate goes to the quarantine log with its reason, nothing in the raw log',
  withRouter(({ router, project, dir }) => {
    router.payload(cc(project).start());
    const r = router.payload({ session_id: 'ses_r1', cwd: project, hook_event_name: 'Notification', message: 'hi' });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(marks(dir('ses_r1')), []);
    const q = lines(path.join(dir('ses_r1'), 'quarantine.jsonl')).slice(1);
    assert.strictEqual(q.length, 1);
    assert.ok(q[0].received.includes('no translation for hook event Notification'), q[0].received);
  }),
);

it(
  'LD124, NF3: a payload naming no session, or one unsafe as a folder name, goes to the intake\'s error log, never only printed',
  withRouter(({ router, project, home }) => {
    assert.strictEqual(router.payload({ cwd: project, hook_event_name: 'Stop' }).ok, false);
    assert.strictEqual(router.payload({ session_id: '../x', cwd: project, hook_event_name: 'Stop' }).ok, false);
    const errs = lines(path.join(home, 'intake', 'errors.jsonl'));
    assert.strictEqual(errs.length, 2);
    assert.ok(errs[1].reason.includes('unsafe session id'), errs[1].reason);
    assert.ok(!fs.existsSync(path.join(home, 'x')), 'nothing was written outside the sessions folder');
  }),
);

it(
  'LD123: a session with no payload for releaseMs is released with a note and no more ticks; a later payload holds it again with its turns and pin',
  withRouter(
    ({ router, project, clock, dir, home }) => {
      const p = cc(project);
      assert.strictEqual(router.payload(p.prompt('go'), { channel: 'http', pid: 4242 }).ok, true);
      clock.advance(1500);
      router.poll();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'intake', 'held.json'), 'utf8')), ['ses_r1']);
      clock.advance(1000);
      router.poll();
      const note = marks(dir('ses_r1')).find((m) => m.says === 'exited');
      assert.ok(note && note.detail.reason.startsWith('released'), JSON.stringify(marks(dir('ses_r1'))));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'intake', 'held.json'), 'utf8')), []);
      const before = marks(dir('ses_r1')).length;
      clock.advance(5000);
      router.poll();
      assert.strictEqual(marks(dir('ses_r1')).length, before, 'no tick after the release');
      const foreign = router.payload(p.pre('Bash', { command: 'x' }, 'f1'), { channel: 'http', pid: 999 });
      assert.strictEqual(foreign.ok, false, 'the pin survives the release');
      router.payload(p.pre('Bash', { command: 'x' }, 'f2'), { channel: 'http', pid: 4242 });
      const last = marks(dir('ses_r1')).pop();
      assert.deepStrictEqual([last.says, last.turn], ['started', 't1'], 'the open turn continues');
      assert.strictEqual(verifySessionLog(dir('ses_r1')).ok, true);
    },
    { releaseMs: 2000 },
  ),
);

it(
  'test 84 at the router: after a crash, a new router resumes the sessions held: one gap for the downtime, and the turn count continues',
  withRouter(({ router, make, project, clock, dir }) => {
    const p = cc(project);
    router.payload(p.prompt('one'));
    router.payload(p.stop('done'));
    clock.advance(60000);
    const again = make();
    const r = again.resume();
    assert.deepStrictEqual(r.gaps.map((g) => g.id), ['ses_r1']);
    again.payload(p.prompt('two'));
    const ms = marks(dir('ses_r1'));
    assert.deepStrictEqual(ms.slice(-2).map((m) => [m.says, m.turn]), [['gap', null], ['prompted', 't2']]);
    assert.strictEqual(verifySessionLog(dir('ses_r1')).ok, true);
  }),
);

it(
  'SessionEnd ends the session: no turn, and it is not ticked or resumed',
  withRouter(({ router, make, project, clock, dir }) => {
    const p = cc(project);
    router.payload(p.prompt('go'));
    router.payload(p.end());
    const end = marks(dir('ses_r1')).pop();
    assert.deepStrictEqual([end.says, end.turn, end.target.kind], ['ended', null, 'session']);
    clock.advance(5000);
    assert.strictEqual(router.poll(), 0);
    assert.deepStrictEqual(make().resume().gaps, []);
  }),
);

runAll('intake-router');
