'use strict';

/**
 * test/tamper-log.js — the tamper-evident log (Phase 6 slices TE1, TE3, TE4; guarantee 9 as O amended it, LD257, Q31: "Let
 * the log log tamper and edits ... if an agent deletes and rewrites, it should log the delete, what was deleted and what
 * was rewritten"; tests 17 and 31 as TE4 rewrites them). As the agent's own user (the same account here), each change to
 * the raw log that Orunmila did not make: an append, a cut, an edit, a delete, a move, a delete then a rewrite. Each is
 * recorded with what changed, the log is put back, `verify` passes and names it, and the judge calls it a Violation of R4.
 * Hand-built session logs (test/helpers-opon.js); made-up content.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { verifySession } = require('../src/verify/session');
const { replayFolder } = require('../src/opon/replay');

const raw = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8');
const lines = (dir) => raw(dir).split('\n').slice(0, -1).map((l) => JSON.parse(l));

/** A guarded log with three marks; `change` tampers with it as the agent could; then the guard looks. */
function tampered(change) {
  const base = tmpDir();
  const s = makeLog(base, {}, { guard: { shadowDir: path.join(base, 'keep') } });
  s.append(M.prompted(0));
  s.append(M.read(100, 'r1', 'src/a.ts'));
  s.append(M.turnEnded(200));
  const file = path.join(s.dir, 'raw.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  change(file, before);
  const found = s.log.guard();
  return { base, s, file, before, found };
}

const CASES = [
  ['appended', (f) => fs.appendFileSync(f, '{"forged":"a line the agent wrote"}\n'), { added: 'a line the agent wrote' }],
  ['cut', (f, b) => fs.writeFileSync(f, b.split('\n').slice(0, 2).join('\n') + '\n'), { removed: '"says":"read"' }],
  ['edited', (f, b) => fs.writeFileSync(f, b.replace('"says":"read"', '"says":"exited"')), { removed: '"says":"read"', added: '"says":"exited"' }],
  ['deleted', (f) => fs.unlinkSync(f), { removed: '"says":"prompted"' }],
  ['moved', (f) => fs.renameSync(f, f + '.elsewhere'), { removed: '"says":"prompted"' }],
  ['deleted then rewritten', (f) => (fs.unlinkSync(f), fs.writeFileSync(f, '{"rewritten":"by the agent"}\n')), { removed: '"says":"prompted"', added: 'by the agent' }],
];

for (const [name, change, words] of CASES) {
  it(`TE1, TE4: the raw log ${name} by something other than Orunmila is recorded with what changed, put back, and verify passes naming it`, () => {
    const t = tampered(change);
    try {
      assert.strictEqual(t.found.length, 1, JSON.stringify(t.found));
      const after = lines(t.s.dir);
      assert.strictEqual(raw(t.s.dir).startsWith(t.before), true, 'the log is put back: every line Orunmila wrote, unchanged');
      const m = after[after.length - 1];
      assert.deepStrictEqual([m.says, m.source, m.detail.what, m.detail.restored, m.target.path], ['tampered', 'process', 'log_location', true, t.file]);
      const expectChange = name === 'moved' || name === 'deleted' ? 'deleted' : name === 'deleted then rewritten' ? 'edited' : name;
      assert.strictEqual(m.detail.change, expectChange);
      if (words.added) assert.ok(String(m.detail.added).includes(words.added), JSON.stringify(m.detail));
      if (words.removed) assert.ok(String(m.detail.removed).includes(words.removed), JSON.stringify(m.detail));
      const v = verifySession(t.s.dir);
      assert.strictEqual(v.ok, true, v.words);
      assert.ok(v.words.includes(`the raw log was ${expectChange} by something other than Orunmila and put back (line ${m.seq + 1} of the raw log)`), v.words);
      // Q41 (O, 2026-11-24): the tamper mark's detail fields are the spec's own, so verify names none as undeclared.
      assert.deepStrictEqual(v.undeclared, [], JSON.stringify(v.undeclared));
      // Time moves on after the mark (stamped on the machine's clock, this fixture's own being made up), so its odù seals.
      t.s.append({ ...M.tick(0), mono_ns: String(BigInt(m.mono_ns) + 10000000000n) });
      const r = replayFolder(t.s.dir);
      const verdicts = r.verdict.split('\n').slice(0, -1).map((l) => JSON.parse(l));
      const odus = r.odu.split('\n').slice(0, -1).map((l) => JSON.parse(l));
      const odu = odus.find((o) => o.action === 'tampered');
      assert.ok(odu, 'the tampering reaches the odù log');
      const verdict = verdicts.find((x) => x.odu_id === odu.odu_id);
      assert.deepStrictEqual([verdict.verdict, verdict.rule], ['violation', 'R4']);
    } finally {
      rmrf(t.base);
    }
  });
}

it('TE1: a log nobody touched gives nothing, its times touched with the bytes unchanged gives nothing, and a guard-less log is not guarded', () => {
  const t = tampered(() => {});
  try {
    assert.deepStrictEqual(t.found, []);
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(t.file, now, now);
    assert.deepStrictEqual(t.s.log.guard(), [], 'same bytes: no change to record');
  } finally {
    rmrf(t.base);
  }
  const base = tmpDir();
  try {
    const s = makeLog(base);
    s.append(M.prompted(0));
    fs.appendFileSync(path.join(s.dir, 'raw.jsonl'), 'x\n');
    assert.deepStrictEqual(s.log.guard(), [], 'no guard asked for: nothing watched (off by default)');
  } finally {
    rmrf(base);
  }
});

it('TE1: a change found at the next append is recorded before the new mark, which follows the put-back log', () => {
  const t = tampered(() => {});
  try {
    fs.appendFileSync(t.file, '{"forged":true}\n');
    t.s.append(M.tick(5000));
    const after = lines(t.s.dir);
    assert.deepStrictEqual(after.slice(-2).map((m) => m.says), ['tampered', 'tick']);
    assert.strictEqual(verifySession(t.s.dir).ok, true);
  } finally {
    rmrf(t.base);
  }
});

it("TE1: when Orunmila's own copy was changed too, the log is not put back from it, and the mark says so", () => {
  const t = tampered(() => {});
  try {
    const keep = fs.readdirSync(path.join(t.base, 'keep'), { recursive: true }).map(String).find((f) => f.endsWith('raw.jsonl'));
    fs.appendFileSync(path.join(t.base, 'keep', keep), 'x\n');
    fs.appendFileSync(t.file, 'x\n');
    const found = t.s.log.guard();
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].restored, false);
  } finally {
    rmrf(t.base);
  }
});

it('TE1 in the intake: with the guard asked for, a change to a held session\'s raw log is found at the next heartbeat; without it, nothing is watched', () => {
  const { createRouter } = require('../src/opon/intake/router');
  const ROOT = path.join(__dirname, '..');
  for (const guard of [true, false]) {
    const home = tmpDir();
    const project = tmpDir();
    try {
      let mono = 5000n * 1000000n;
      const clock = () => ({ mono: mono.toString(), wall: new Date(Date.UTC(2026, 10, 24) + Number(mono / 1000000n)).toISOString() });
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(ROOT, 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], guard });
      router.payload({ session_id: 'ses_g', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
      // Ended: an ended session never ticks (LD55), so only the heartbeat's own look can find the change.
      router.payload({ session_id: 'ses_g', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'SessionEnd', reason: 'exit' }, { channel: 'command' });
      const file = path.join(home, 'sessions', 'ses_g', 'raw.jsonl');
      fs.appendFileSync(file, '{"forged":true}\n');
      mono += 600n * 1000000n;
      router.poll();
      const recs = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
      if (guard) {
        assert.ok(recs.every((l) => l !== '{"forged":true}'), 'put back (the tamper mark quotes the line; no line is it)');
        assert.ok(recs.map((l) => JSON.parse(l)).some((m) => m.says === 'tampered' && m.detail.change === 'appended'), recs.join('\n'));
      } else assert.ok(recs.includes('{"forged":true}'), 'off: nothing watched, nothing put back');
      router.stop('over');
    } finally {
      rmrf(home);
      rmrf(project);
    }
  }
});

/** TE1's rest (LD285): a session through a live router with the guard, the live Ọpọ́n and the judge, to its closeout. */
function guardedSession() {
  const { createRouter } = require('../src/opon/intake/router');
  const base = tmpDir();
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  let mono = 5000n * 1000000n;
  const clock = () => ({ mono: mono.toString(), wall: new Date(Date.UTC(2026, 10, 24) + Number(mono / 1000000n)).toISOString() });
  const advance = (ms) => (mono += BigInt(ms) * 1000000n);
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], baseline: true, judge: true, guard: true });
  const b = { session_id: 'ses_guard_all', transcript_path: '/tmp/t.jsonl', cwd: project };
  const send = (x) => router.payload({ ...b, ...x }, { channel: 'command' });
  const fresh = path.join(project, 'src', 'new.js');
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'make it' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: fresh, content: 'a\n' }, tool_use_id: 'w1' });
  fs.writeFileSync(fresh, 'a\n');
  send({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: fresh, content: 'a\n' }, tool_response: {}, tool_use_id: 'w1' });
  send({ hook_event_name: 'Stop', last_assistant_message: 'I wrote src/new.js.' });
  send({ hook_event_name: 'SessionEnd', reason: 'exit' });
  const polls = (n) => {
    for (let i = 0; i < n; i++) {
      advance(500);
      router.poll();
    }
  };
  polls(20);
  const dir = path.join(home, 'sessions', 'ses_guard_all');
  return { base, dir, router, polls };
}
const tampers = (dir) => lines(dir).filter((m) => m.says === 'tampered' && m.detail.what === 'log_location');

it("TE1's rest (LD285): with the guard, the live Ọpọ́n and the judge, Orunmila's own writes to the odù and verdict logs are never taken for tampering, and the odù log equals replay's", () => {
  const t = guardedSession();
  try {
    assert.ok(fs.existsSync(path.join(t.dir, 'verdict.jsonl')), 'the closeout wrote a verdict log');
    assert.deepStrictEqual(tampers(t.dir), []);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'odu.jsonl'), 'utf8'), replayFolder(t.dir).odu, 'nothing put back over its own lines');
    t.router.stop('over');
  } finally {
    rmrf(t.base);
  }
});

for (const [log, change] of [
  ['odu', (f) => fs.appendFileSync(f, '{"forged":"an odù the agent wrote"}\n')],
  ['verdict', (f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"violation"', '"clean"').replace('"look_at_this"', '"clean"'))],
]) {
  it(`TE1's rest (LD285): the ${log} log changed by something other than Orunmila is recorded and put back at the next heartbeat`, () => {
    const t = guardedSession();
    try {
      const file = path.join(t.dir, `${log}.jsonl`);
      const before = fs.readFileSync(file, 'utf8');
      change(file);
      assert.notStrictEqual(fs.readFileSync(file, 'utf8'), before, 'the test changed it');
      t.polls(2);
      assert.ok(fs.readFileSync(file, 'utf8').startsWith(before), 'put back: every line Orunmila wrote, unchanged');
      const found = tampers(t.dir).filter((m) => m.target.path === file);
      assert.strictEqual(found.length, 1, JSON.stringify(tampers(t.dir)));
      assert.strictEqual(found[0].detail.restored, true);
      t.router.stop('over');
    } finally {
      rmrf(t.base);
    }
  });
}

it("TE1's rest (LD285): a session resumed after its closeout (a new prompt) is swept and judged again: Orunmila's second write to its verdict log is its own", () => {
  const t = guardedSession();
  try {
    const before = fs.readFileSync(path.join(t.dir, 'verdict.jsonl'), 'utf8');
    const b = { session_id: 'ses_guard_all', transcript_path: '/tmp/t.jsonl', cwd: lines(t.dir)[0].project_root };
    t.router.payload({ ...b, hook_event_name: 'UserPromptSubmit', prompt: 'and again' }, { channel: 'command' });
    t.router.payload({ ...b, hook_event_name: 'Stop', last_assistant_message: 'Nothing more.' }, { channel: 'command' });
    t.router.payload({ ...b, hook_event_name: 'SessionEnd', reason: 'exit' }, { channel: 'command' });
    t.polls(20);
    const after = fs.readFileSync(path.join(t.dir, 'verdict.jsonl'), 'utf8');
    assert.ok(after.length > before.length && after.startsWith(before), 'the second closeout appended to the verdict log');
    assert.deepStrictEqual(tampers(t.dir), []);
    t.router.stop('over');
  } finally {
    rmrf(t.base);
  }
});

it("TE1's rest (LD285): after a restart the reopened session's odù log is guarded too", () => {
  const { createRouter } = require('../src/opon/intake/router');
  const t = guardedSession();
  try {
    t.router.stop('restart');
    const home = path.dirname(path.dirname(t.dir));
    let mono = 9000n * 1000000n;
    const clock = () => ({ mono: mono.toString(), wall: new Date(Date.UTC(2026, 10, 24) + Number(mono / 1000000n)).toISOString() });
    const r2 = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], baseline: true, judge: true, guard: true });
    r2.resume();
    mono += 500n * 1000000n;
    r2.poll();
    assert.deepStrictEqual(tampers(t.dir), [], 'its own resume is no tampering');
    const file = path.join(t.dir, 'odu.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '{"forged":true}\n');
    mono += 500n * 1000000n;
    r2.poll();
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(before) && !fs.readFileSync(file, 'utf8').includes('"forged":true}\n'), 'put back');
    assert.strictEqual(tampers(t.dir).filter((m) => m.target.path === file).length, 1);
    r2.stop('over');
  } finally {
    rmrf(t.base);
  }
});

runAll('tamper-log');
