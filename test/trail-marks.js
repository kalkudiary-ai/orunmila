// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/trail-marks.js — `trail --json` from the intake's session logs, both
 * witnesses on every row (slice B7, LD149; brief v4 lines 747-749; tests 47,
 * 64; NF25). Sessions are written through the real router into throwaway
 * homes; made-up paths and contents only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll, run, slash } = require('./helpers');
const crypto = require('crypto');
const { createRouter } = require('../src/opon/intake/router');
const { nowMono } = require('../src/opon/intake/mono');
const { trailFromSessionFolder } = require('../src/trail/from-marks');
const { renderTrailJson } = require('../src/render/trail-json');

function session() {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const outside = fs.realpathSync(tmpDir());
  let ms = 0;
  // A clock that moves 10 ms a call, so the record's order is its time order.
  const base = Date.now();
  const clock = () => {
    ms += 10;
    return { mono: String(BigInt(nowMono()) + BigInt(ms) * 1000000n), wall: new Date(base + ms).toISOString() };
  };
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: 't', installKey: crypto.randomBytes(32), hookSettingsFor: () => [] });
  const send = (p) => router.payload({ session_id: 'm1', cwd: root, ...p }, { channel: 'command' });
  return { home, root, outside, router, send, clock, done: () => (router.stop('over'), rmrf(home), rmrf(root), rmrf(outside)) };
}

function build() {
  const t = session();
  const a = path.join(t.root, 'src', 'a.js');
  const far = path.join(t.outside, 'notes.txt');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.writeFileSync(a, 'one\n');
  fs.writeFileSync(far, 'x\n');
  t.send({ hook_event_name: 'UserPromptSubmit', prompt: 'edit a' });
  t.send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: a }, tool_use_id: 'r1' });
  t.send({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: a }, tool_use_id: 'r1', tool_response: { type: 'text', file: { numLines: 2, startLine: 1, totalLines: 2 } } });
  t.send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: a }, tool_use_id: 'e1' });
  fs.writeFileSync(a, 'one\ntwo\n');
  t.send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: a }, tool_use_id: 'e1', tool_response: {} });
  t.send({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: far }, tool_use_id: 'w1' });
  fs.writeFileSync(far, 'y\n');
  t.send({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: far }, tool_use_id: 'w1', tool_response: {} });
  t.send({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b1', tool_response: { stdout: 'ok', stderr: '' } });
  t.send({ hook_event_name: 'Stop', last_assistant_message: 'Edited src/a.js.' });
  return t;
}

/** Append Sentinel marks to the session log through the router's own path (an intake with sentinel: true would). */
function addSentinel(t, rel, extra = {}) {
  const log = require('../src/opon/ledger/session-log').openSessionLog(path.join(t.home, 'sessions', 'm1'));
  const now = t.clock();
  const r = log.append({ schema_version: 1, session_id: 'm1', source: 'sentinel', agent: null, turn: null, sub_agent: null, observed_at: now.wall, mono_ns: now.mono, target: { kind: 'file', path: rel }, says: 'modified', detail: { root: t.root, size: 8, fingerprint_before: 'sha256:' + '1'.repeat(64), fingerprint: 'sha256:' + '2'.repeat(64), lines_added: 1, lines_removed: 0, ...extra }, cause_hint: null });
  assert.ok(r.ok, JSON.stringify(r));
}

it('test 64: a Glove write the Sentinel also saw shows both on its row; one outside the watched folder says the Sentinel is out of scope; no row is dropped', () => {
  const t = build();
  try {
    t.router.stop('written');
    addSentinel(t, 'src/a.js');
    const trail = trailFromSessionFolder(path.join(t.home, 'sessions', 'm1'));
    const rows = trail.turns.flatMap((x) => x.trail);
    const hookEdit = rows.find((r) => r.type === 'file_write' && r.source === 'hook' && r.path === 'src/a.js');
    const disk = rows.find((r) => r.source === 'fs-sentinel' && r.path === 'src/a.js');
    const far = rows.find((r) => r.type === 'file_write' && r.source === 'hook' && r.path === slash(path.join(t.outside, 'notes.txt'))); // recorded with `/` on every OS
    assert.ok(hookEdit && disk && far, JSON.stringify(rows.map((r) => [r.type, r.source, r.path])));
    assert.deepStrictEqual(hookEdit.witnesses, { glove: { status: 'saw' }, sentinel: { status: 'saw' } });
    assert.deepStrictEqual(disk.witnesses, { glove: { status: 'saw' }, sentinel: { status: 'saw' } });
    assert.deepStrictEqual(far.witnesses, { glove: { status: 'saw' }, sentinel: { status: 'out_of_scope', scope: 'outside_root' } });
    const cmd = rows.find((r) => r.type === 'command_run');
    assert.deepStrictEqual(cmd.witnesses, { glove: { status: 'saw' }, sentinel: { status: 'out_of_scope', scope: 'not_a_disk_event' } });
    assert.strictEqual(trail.sentinel_active, true);
  } finally {
    t.done();
  }
});

it("NF25: a Sentinel write after the turn's last hook event stays in that turn; a disk change nobody's hook made says the Glove saw nothing", () => {
  const t = build();
  try {
    t.router.stop('written');
    addSentinel(t, 'src/late.js'); // after the Stop: no hook event follows it
    const trail = trailFromSessionFolder(path.join(t.home, 'sessions', 'm1'));
    const rows = trail.turns.flatMap((x) => x.trail);
    const late = rows.find((r) => r.path === 'src/late.js');
    assert.ok(late, 'the late Sentinel row is kept');
    assert.deepStrictEqual(late.witnesses, { glove: { status: 'saw_nothing' }, sentinel: { status: 'saw' } });
  } finally {
    t.done();
  }
});

it("test 47: the trail from marks has today's shape: every key today's rows, turns, artifacts and totals carry", () => {
  const t = build();
  try {
    t.router.stop('written');
    addSentinel(t, 'src/a.js');
    const trail = JSON.parse(renderTrailJson(trailFromSessionFolder(path.join(t.home, 'sessions', 'm1')), { factsOnly: true }));
    assert.deepStrictEqual(Object.keys(trail).sort(), ['artifacts', 'facts_only', 'generated_at', 'schema_version', 'sentinel_active', 'session_id', 'totals', 'turns']);
    assert.deepStrictEqual(Object.keys(trail.turns[0]).sort(), ['artifacts', 'prompt', 'trail', 'turn_id']);
    assert.strictEqual(trail.turns[0].prompt, 'edit a');
    for (const r of trail.turns[0].trail) for (const k of ['key', 'type', 'channel', 'ts', 'source', 'failed', 'call_id', 'witnesses']) assert.ok(k in r, `${k} in ${JSON.stringify(r)}`);
    const read = trail.turns[0].trail.find((r) => r.type === 'file_read');
    assert.strictEqual(read.channel, 'read');
    assert.ok(/^[0-9a-f]{64}$/.test(read.hash), 'the fingerprint as today: hex');
    const cmd = trail.turns[0].trail.find((r) => r.type === 'command_run');
    assert.strictEqual(cmd.command, 'npm test');
    assert.strictEqual(cmd.channel, 'command');
    assert.deepStrictEqual(Object.keys(trail.totals).sort(), ['artifacts', 'touches', 'turns']);
  } finally {
    t.done();
  }
});

it('B7 CLI: trail --json --marks --session reads the session folder from the intake', () => {
  const t = build();
  try {
    t.router.stop('written');
    const r = run('bin/orunmila.js', { args: ['trail', '--json', '--facts-only', '--marks', '--session', 'm1'], env: { ORUNMILA_HOME: t.home } });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.session_id, 'm1');
    assert.strictEqual(out.facts_only, true);
    assert.ok(out.turns[0].trail.every((x) => x.witnesses));
    const none = run('bin/orunmila.js', { args: ['trail', '--json', '--marks', '--session', 'nope'], env: { ORUNMILA_HOME: t.home } });
    assert.strictEqual(none.status, 1);
    assert.ok(/no session log/.test(none.stdout + none.stderr), none.stdout + none.stderr);
  } finally {
    t.done();
  }
});

it('F32 (brief v4 line 747): on a home with only the session log, the kept commands read it or name what does, never an empty answer', () => {
  const t = build();
  try {
    t.router.stop('written');
    const dir = path.join(t.home, 'sessions', 'm1');
    fs.writeFileSync(path.join(dir, 'odu.jsonl'), require('../src/opon/replay').replayFolder(dir).odu);
    // spawnSync, not run(): run() keeps no stderr when the command exits 0, and the notices on stderr are the point.
    const cli = (...args) => {
      const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'orunmila.js'), ...args], { cwd: t.root, env: { ...process.env, ORUNMILA_HOME: t.home }, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    // trail --json, with and without --session: the session log's rows, and a notice on stderr so stdout stays JSON.
    for (const args of [['trail', '--json', '--session', 'm1'], ['trail', '--json']]) {
      const r = cli(...args);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.session_id, 'm1', args.join(' '));
      assert.ok(out.totals.touches > 0, `${args.join(' ')}: ${JSON.stringify(out.totals)}`);
      assert.ok(/Read from the session log/.test(r.stderr), r.stderr);
    }
    // The page and the old page: the session log's trail, with the same notice.
    for (const cmd of ['trail', 'html']) {
      const page = path.join(t.root, `${cmd}.html`);
      const r = cli(cmd, '--session', 'm1', '--out', page);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(/Read from the session log/.test(r.stdout), `${cmd}: ${r.stdout}`);
      assert.ok(fs.readFileSync(page, 'utf8').includes('src/a.js'), `${cmd}: the page shows the session's rows`);
    }
    // json: the verdicts' feedback, in the same 1.0 shape.
    const j = cli('json', '--session', 'm1');
    assert.strictEqual(j.status, 0, j.stderr);
    const fb = JSON.parse(j.stdout);
    assert.strictEqual(fb.schema_version, '1.0');
    // The old path never carries this source (test/feedback-verdicts.js, BB9); this session is never closed, so its
    // claims are not judged and its turns stay empty here (on a real closed session, 7d8fe95a, the fallback gave 5).
    assert.strictEqual(fb.source, 'verdict_log', 'from the verdicts, not the empty old path');
    assert.ok(/the verdicts' feedback/.test(j.stderr), j.stderr);
    // status counts the session logs.
    const s = cli('status');
    assert.ok(/Session logs \(the intake's\): 1 /.test(s.stdout), s.stdout);
    // The rest name the command that reads the session log.
    assert.ok(cli('report', '--session', 'm1').stdout.includes('orunmila report --verdicts --session m1'));
    assert.ok(cli('laws', '--check', '--session', 'm1').stdout.includes('orunmila report --verdicts --session m1'));
    assert.ok(/ORUNMILA_FEEDBACK_FROM_VERDICTS=1 orunmila json --session m1/.test(cli('feedback', '--session', 'm1', '--dir', path.join(t.root, 'fb')).stderr));
    assert.ok(/1 session log .* not counted here/.test(cli('stats').stdout));
  } finally {
    t.done();
  }
});

runAll('trail-marks');
