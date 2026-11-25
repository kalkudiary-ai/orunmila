// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/judge-live.js — the verdict log in the closeout, in replay and by `orunmila judge` (Phase 6 slice BB6; brief v4
 * lines 453-454, 684; plan section 5). Behind ORUNMILA_JUDGE_LIVE=1 (the router's `judge` option), off by default:
 * with it off nothing is written and the footer's verdict is null; with it on the closeout judges the sealed odù log,
 * writes verdict.jsonl beside the other two logs and names its last line in the footer, and replay of the raw log gives
 * the same verdict log byte for byte (guarantee 3). The rules file's text is copied into the header at session start
 * (config.rules, Q34), so a later edit changes nothing. Hand-built payloads in throwaway folders (brief line 761).
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const { replayFolder } = require('../src/opon/replay');
const { verifyText } = require('../src/verify/chain');
const { DEFAULT_RULES } = require('../src/babalawo/rules');

const MS = 1000000n;
const KEY = Buffer.alloc(32, 7);
const SRC = path.join(__dirname, '..', 'src');
function fakeClock() {
  let mono = 5000n * MS;
  let wall = Date.UTC(2026, 10, 24, 1, 0, 0, 0);
  const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
  clock.advance = (ms) => {
    mono += BigInt(ms) * MS;
    wall += ms;
  };
  return clock;
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);

/** A session through a live router to its closeout: a prompt, a Write, a hand edit, a Stop, a SessionEnd, then polls past the lag grace. */
function closedSession(base, { judge, rules = null, sid = 'ses_judge_live', hole = 0, idle = 0, step = 500, weaken = false }) {
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'hand.js'), 'old\n');
  const spec = path.join(project, 'test', 'a.test.js');
  const before = "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n";
  const after = "it('adds', () => {\n  add(1, 2);\n});\n";
  if (weaken) {
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, before);
  }
  if (rules !== null) {
    fs.mkdirSync(path.join(project, '.orunmila'), { recursive: true });
    fs.writeFileSync(path.join(project, '.orunmila', 'rules'), rules);
  }
  const clock = fakeClock();
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, judge });
  const b = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  const send = (x) => assert.strictEqual(router.payload({ ...b, ...x }, { channel: 'command' }).ok, true, x.hook_event_name);
  const fresh = path.join(project, 'src', 'new.js');
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'make it' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: fresh, content: 'a\n' }, tool_use_id: 'w1' });
  fs.writeFileSync(fresh, 'a\n');
  send({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: fresh, content: 'a\n' }, tool_response: {}, tool_use_id: 'w1' });
  if (hole) clock.advance(hole); // BB5a: time passes with no poll, so no tick: a hole in the heartbeat while the session is held
  for (let t = 0; t < idle; t += 500) {
    clock.advance(500); // BB5a: idle and polled: a tick each 500 ms, pauses under the lag grace
    router.poll();
  }
  if (weaken) {
    // MR2 (LD317): the agent edits a test file and removes its assertion: R27, from the diff kept beside the log
    const edit = { file_path: spec, old_string: '  expect(add(1, 2)).toBe(3);', new_string: '  add(1, 2);' };
    send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit, tool_use_id: 'e9' });
    fs.writeFileSync(spec, after);
    send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: edit, tool_response: {}, tool_use_id: 'e9' });
  }
  fs.writeFileSync(path.join(project, 'src', 'hand.js'), 'by hand\n'); // nobody's tool call: the closeout's rescan finds it
  send({ hook_event_name: 'Stop', last_assistant_message: 'I wrote src/new.js.' });
  send({ hook_event_name: 'SessionEnd', reason: 'exit' });
  for (let i = 0; i < 20; i++) {
    clock.advance(step);
    router.poll();
  }
  return { dir: path.join(home, 'sessions', sid), project, home };
}

it('BB6: with the judge off (the default), no verdict log is written and the footer names none', () => {
  const base = tmpDir();
  try {
    const { dir } = closedSession(base, { judge: false });
    const footer = JSON.parse(fs.readFileSync(path.join(dir, 'footer.json'), 'utf8'));
    assert.strictEqual(fs.existsSync(path.join(dir, 'verdict.jsonl')), false);
    assert.strictEqual(footer.verdict, null);
    assert.strictEqual(lines(path.join(dir, 'raw.jsonl'))[0].config.rules, undefined, 'no rules copied into the header with the judge off');
  } finally {
    rmrf(base);
  }
});

it('BB6: with the judge on, the closeout writes the verdict log, the footer names its last line, and replay gives the same log byte for byte', () => {
  const base = tmpDir();
  try {
    const { dir } = closedSession(base, { judge: true });
    const text = fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8');
    assert.strictEqual(verifyText(text).ok, true, 'hash-chained (guarantee 4)');
    const recs = text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
    const last = recs[recs.length - 1];
    const footer = JSON.parse(fs.readFileSync(path.join(dir, 'footer.json'), 'utf8'));
    assert.deepStrictEqual(footer.verdict, { seq: last.seq, hash: last.hash });
    assert.strictEqual(last.record, 'session_verdict');
    const odus = lines(path.join(dir, 'odu.jsonl')).filter((o) => o.record === 'odu');
    assert.strictEqual(recs.filter((r) => r.record === 'verdict').length, odus.length, 'one verdict per sealed odù (line 662)');
    const r = replayFolder(dir);
    assert.strictEqual(r.ok, true, r.words);
    assert.strictEqual(r.verdict, text, 'live equals replay (guarantee 3)');
  } finally {
    rmrf(base);
  }
});

it('MR2 (LD317): the closeout judges R27 from the diff kept beside the log, and replay gives the same verdict log byte for byte', () => {
  const base = tmpDir();
  try {
    const { dir } = closedSession(base, { judge: true, weaken: true });
    const text = fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8');
    const recs = text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
    const r27 = recs.filter((v) => v.record === 'verdict' && (v.rule === 'R27' || v.also.includes('R27')));
    assert.strictEqual(r27.length, 1, JSON.stringify(recs.filter((v) => v.record === 'verdict').map((v) => [v.rule, v.also])));
    assert.strictEqual(replayFolder(dir).verdict, text, 'live equals replay (guarantee 3)');
  } finally {
    rmrf(base);
  }
});

it("Q34, lines 283 and 669: the rules file's text at session start is in the header and judges the session; an edit after it changes nothing", () => {
  const base = tmpDir();
  try {
    const mine = DEFAULT_RULES.replace('R6 look_at_this', 'R6 off');
    const { dir, project } = closedSession(base, { judge: true, rules: mine });
    assert.strictEqual(lines(path.join(dir, 'raw.jsonl'))[0].config.rules, mine);
    fs.writeFileSync(path.join(project, '.orunmila', 'rules'), DEFAULT_RULES); // changed after: the header's copy still judges
    const session = lines(path.join(dir, 'verdict.jsonl')).pop();
    assert.strictEqual(session.rules_source, 'header');
    assert.strictEqual(replayFolder(dir).verdict, fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8'));
  } finally {
    rmrf(base);
  }
});

it('BB6, line 684: `orunmila judge` re-judges with a rules file named, appending verdicts that supersede, never editing; verify still passes', () => {
  const base = tmpDir();
  try {
    const { dir, home } = closedSession(base, { judge: true });
    const before = fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8');
    const rulesFile = path.join(base, 'strict-rules');
    fs.writeFileSync(rulesFile, DEFAULT_RULES.replace('R6 look_at_this', 'R6 off'));
    const env = { ORUNMILA_HOME: home };
    const r = run('bin/orunmila.js', { args: ['judge', '--session', 'ses_judge_live', '--rules', rulesFile], env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const after = fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8');
    assert.ok(after.startsWith(before) && after.length > before.length, 'appended, the old lines untouched');
    const added = after.slice(before.length).split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.ok(added.every((x) => x.supersedes !== null), 'each new verdict supersedes an old one');
    assert.strictEqual(added[added.length - 1].rules_source, 'file');
    assert.ok(/judged/i.test(r.stdout), r.stdout);
    const again = run('bin/orunmila.js', { args: ['judge', '--session', 'ses_judge_live', '--rules', rulesFile], env });
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8'), after, 'the same rules again add nothing');
    const bad = run('bin/orunmila.js', { args: ['judge', '--session', 'ses_judge_live', '--rules', path.join(base, 'missing')], env });
    assert.strictEqual(bad.status, 1, 'a rules file that cannot be read is refused');
    const v = run('bin/orunmila.js', { args: ['verify', dir], env });
    assert.strictEqual(v.status, 0, v.stdout + v.stderr);
  } finally {
    rmrf(base);
  }
});

it("BB5a (lines 670, 686): a hole in the heartbeat while the session was held becomes a gap at the closeout, so the record is Incomplete; with the judge's flag off nothing is added", () => {
  const base = tmpDir();
  try {
    const { dir } = closedSession(path.join(base, 'on'), { judge: true, hole: 5000 });
    const raw = lines(path.join(dir, 'raw.jsonl'));
    const gaps = raw.filter((m) => m.says === 'gap');
    assert.strictEqual(gaps.length, 1, JSON.stringify(gaps));
    const g = gaps[0];
    const before = raw.find((m) => m.mono_ns === g.detail.since.mono_ns);
    const after = raw.find((m) => m.mono_ns === g.detail.until.mono_ns && m.seq > before.seq);
    assert.ok(before && after && BigInt(after.mono_ns) - BigInt(before.mono_ns) === 5000n * 1000000n, JSON.stringify(g.detail));
    assert.ok(/no record for 5000 ms while the intake held this session/.test(g.detail.lost), g.detail.lost);
    const session = lines(path.join(dir, 'verdict.jsonl')).pop();
    assert.strictEqual(session.verdict, 'incomplete');
    assert.ok(session.reasons.some((r) => r.reason === 'gap' && r.rule === 'R9'), JSON.stringify(session.reasons));
    assert.strictEqual(replayFolder(dir).verdict, fs.readFileSync(path.join(dir, 'verdict.jsonl'), 'utf8'), 'live equals replay');
    const off = closedSession(path.join(base, 'off'), { judge: false, hole: 5000 });
    assert.deepStrictEqual(lines(path.join(off.dir, 'raw.jsonl')).filter((m) => m.says === 'gap'), [], 'flag off: no heartbeat gap');
    // Ticks every 500 ms while idle, and the closeout 3.5 s after the end (polls 700 ms apart): neither is a hole.
    const none = closedSession(path.join(base, 'none'), { judge: true, idle: 2000, step: 700 });
    const noneRaw = lines(path.join(none.dir, 'raw.jsonl'));
    assert.ok(noneRaw.filter((m) => m.says === 'tick').length >= 3, 'ticks while idle');
    assert.deepStrictEqual(noneRaw.filter((m) => m.says === 'gap'), [], 'no hole, no gap; the quiet after the end is no hole');
  } finally {
    rmrf(base);
  }
});

/** LD286: a session closed out, resumed with a new prompt and a file claim, then quiet until the intake releases it. */
function resumedThenQuiet(base, { judge }) {
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const clock = fakeClock();
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, judge, releaseMs: 10000 });
  const b = { session_id: 'ses_quiet', transcript_path: '/tmp/t.jsonl', cwd: project };
  const send = (x) => assert.strictEqual(router.payload({ ...b, ...x }, { channel: 'command' }).ok, true, x.hook_event_name);
  const polls = (n) => {
    for (let i = 0; i < n; i++) {
      clock.advance(500);
      router.poll();
    }
  };
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'first' });
  send({ hook_event_name: 'Stop', last_assistant_message: 'Nothing changed.' });
  send({ hook_event_name: 'SessionEnd', reason: 'exit' });
  polls(10); // the first closeout, a lag grace after the end
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'resumed' }); // LD249: resumed after its closeout
  send({ hook_event_name: 'Stop', last_assistant_message: 'I updated src/other.js.' }); // a file claim: it waits for the next closeout's rescan
  polls(30); // no SessionEnd (the agent's process died): quiet past releaseMs, so the intake releases it
  return { dir: path.join(home, 'sessions', 'ses_quiet'), router };
}

it("LD286 (LD249's open point): a resumed session that never ends again is closed out when the intake releases it, so its waiting claims are sealed and judged; with the judge's flag off, as before", () => {
  const base = tmpDir();
  try {
    const { dir } = resumedThenQuiet(path.join(base, 'on'), { judge: true });
    const raw = lines(path.join(dir, 'raw.jsonl'));
    const closeouts = raw.filter((m) => m.says === 'exited' && m.target && m.target.name === 'closeout');
    assert.strictEqual(closeouts.length, 2, 'a second closeout, at the release');
    const release = raw.find((m) => m.says === 'exited' && m.target && m.target.name === 'intake');
    assert.ok(release && release.seq > closeouts[1].seq, 'the closeout comes before the release note');
    const resumedAt = raw.filter((m) => m.says === 'prompted').pop().seq;
    assert.ok(raw.some((m) => m.says === 'tick' && m.seq > resumedAt && m.seq < closeouts[1].seq), 'the resumed session ticks again while held');
    const claim = raw.filter((m) => m.says === 'claimed').pop();
    const odus = lines(path.join(dir, 'odu.jsonl')).filter((o) => o.record === 'odu');
    const held = odus.find((o) => o.target && o.target.kind === 'claim' && o.mark_seqs.includes(claim.seq)); // the claim's own odù (the turn's holds it too)
    assert.ok(held, "the resumed turn's claim is in a sealed odù");
    assert.ok(held.conflicts.some((c) => c.kind === 'phantom_claim'), JSON.stringify(held.conflicts));
    const footer = JSON.parse(fs.readFileSync(path.join(dir, 'footer.json'), 'utf8'));
    assert.strictEqual(footer.raw.seq, closeouts[1].seq, 'the footer names the latest closeout');
    assert.ok(lines(path.join(dir, 'verdict.jsonl')).some((v) => v.record === 'verdict' && v.odu_id === held.odu_id), 'judged');
    assert.strictEqual(replayFolder(dir).odu, fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8'), 'live equals replay');
    const off = resumedThenQuiet(path.join(base, 'off'), { judge: false });
    const offRaw = lines(path.join(off.dir, 'raw.jsonl'));
    assert.strictEqual(offRaw.filter((m) => m.says === 'exited' && m.target && m.target.name === 'closeout').length, 1, 'flag off: no closeout at the release');
    const offClaim = offRaw.filter((m) => m.says === 'claimed').pop();
    assert.ok(!lines(path.join(off.dir, 'odu.jsonl')).some((o) => o.record === 'odu' && o.target && o.target.kind === 'claim' && o.mark_seqs.includes(offClaim.seq)), "flag off: the claim still waits (LD249's open point)");
  } finally {
    rmrf(base);
  }
});

runAll('judge-live');
