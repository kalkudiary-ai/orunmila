'use strict';

/**
 * test/gate-from-marks.js — the law gate's receipts and prompts from the
 * intake's marks, behind ORUNMILA_GATE_FROM_MARKS=1 (slice B9, LD148; open
 * questions 2 and 3 as O decided them, brief v4 lines 276-277; tests 75, 78-81;
 * NF26, NF69). Made-up paths and prose only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { buildReceipts, receiptStrength } = require('../src/laws/evaluate');
const { buildReceiptsFromMarks } = require('../src/opon/gate/receipts');
const { turnFromMarks } = require('../src/opon/gate/turn-marks');
const { createRouter } = require('../src/opon/intake/router');
const { nowMono } = require('../src/opon/intake/mono');

const mark = (says, target, detail, extra = {}) => ({ source: 'hook', says, target, detail, turn: 't1', ...extra });
const file = (p) => ({ kind: 'path', value: path.basename(p), raw: p }); // as assert-extractor gives a path

it("test 78 (NF26): the turn's only read of a file failed: no receipt from marks (today's events give a full one)", () => {
  const marks = [mark('started', { kind: 'file', path: 'src/x.js' }, { tool: 'Read' }), mark('ended', { kind: 'file', path: 'src/x.js' }, { tool: 'Read', exit_status: 'fail' })];
  assert.strictEqual(receiptStrength(file('src/x.js'), buildReceiptsFromMarks(marks)), 'none');
  assert.strictEqual(receiptStrength(file('src/x.js'), buildReceipts([{ type: 'file_read', path: 'src/x.js', read_kind: 'full', failed: true }])), 'full', 'NF26 as today');
  // A read mark that did not pass (no adapter writes one today: a failed call ends `ended`) is no receipt either.
  const odd = [mark('read', { kind: 'file', path: 'src/w.js' }, { tool: 'Read', exit_status: 'fail', read_kind: 'full' })];
  assert.strictEqual(receiptStrength(file('src/w.js'), buildReceiptsFromMarks(odd)), 'none');
});

it("test 79 (NF69): the turn's only edit of a file failed: no receipt from marks (today's events give a full one)", () => {
  const marks = [mark('ended', { kind: 'file', path: 'src/y.js' }, { tool: 'Edit', exit_status: 'fail' })];
  assert.strictEqual(receiptStrength(file('src/y.js'), buildReceiptsFromMarks(marks)), 'none');
  assert.strictEqual(receiptStrength(file('src/y.js'), buildReceipts([{ type: 'file_write', path: 'src/y.js', failed: true }])), 'full', 'NF69 as today');
});

it('test 80: a read with an offset and a limit (read_kind range) is a full receipt; so is one the adapter cannot measure (null)', () => {
  const r = buildReceiptsFromMarks([
    mark('read', { kind: 'file', path: 'src/a.js' }, { tool: 'Read', exit_status: 'pass', read_kind: 'range' }),
    mark('read', { kind: 'file', path: 'src/b.js' }, { tool: 'Read', exit_status: 'pass', read_kind: null }),
  ]);
  assert.strictEqual(receiptStrength(file('src/a.js'), r), 'full');
  assert.strictEqual(receiptStrength(file('src/b.js'), r), 'full');
});

it('test 81: a folder listing is a weak receipt for the files in it, never a full one; a search is weak for its folder', () => {
  const r = buildReceiptsFromMarks([
    mark('read', { kind: 'dir', path: 'src' }, { tool: 'LS', exit_status: 'pass', read_kind: 'listing' }),
    mark('read', { kind: 'dir', path: 'lib' }, { tool: 'Grep', exit_status: 'pass', read_kind: 'pattern', pattern: 'TODO' }),
  ]);
  assert.strictEqual(receiptStrength(file('src/c.js'), r), 'weak');
  assert.strictEqual(receiptStrength(file('lib/d.js'), r), 'weak');
  assert.strictEqual(receiptStrength(file('other/e.js'), r), 'none');
});

it('B9: commands from marks: a pass is a passing command, a fail a failed one with its code, a pipe or an unknown status proves nothing', () => {
  const cmd = (text, d) => mark('exited', { kind: 'command', text }, { tool: 'Bash', output_excerpt: '', ...d });
  const r = buildReceiptsFromMarks([
    cmd('npm test', { exit_status: 'pass' }),
    cmd('npm run lint', { exit_status: 'fail', exit_code: 2 }),
    cmd('npm test | tail -3', { exit_status: 'pass' }),
    cmd('sleep 100', { exit_status: 'unknown', background: true }),
    mark('read', { kind: 'file', path: 'src/z.js' }, { tool: 'Read', exit_status: 'pass', read_kind: 'full' }, { source: 'sentinel' }),
  ]);
  assert.deepStrictEqual(r.passingCommands.map((c) => c.command), ['npm test']);
  assert.deepStrictEqual(r.failedCommands, [{ command: 'npm run lint', exit_code: 2 }]);
  assert.deepStrictEqual(r.unreliableCommands.map((c) => c.command), ['npm test | tail -3', 'sleep 100']);
  assert.strictEqual(receiptStrength(file('src/z.js'), r), 'none', 'only the Glove gives receipts');
});

it("test 75 (gate half): a turn's prompt text is its own prompt marks' only; a continuation has none", () => {
  const marks = [
    mark('prompted', { kind: 'turn', id: 't1' }, { prompt: 'first', from_human: true }),
    mark('ended', { kind: 'turn', id: 't1' }, {}),
    mark('read', { kind: 'file', path: 'a' }, { exit_status: 'pass', read_kind: 'full' }, { turn: 't2' }),
  ];
  const t = turnFromMarks(marks);
  assert.strictEqual(t.turn, 't2');
  assert.strictEqual(t.promptText, '');
  assert.strictEqual(t.continuation, true);
  assert.strictEqual(t.marks.length, 1);
  assert.strictEqual(turnFromMarks(marks.slice(0, 1)).promptText, 'first');
});

it("B9 gate: with ORUNMILA_GATE_FROM_MARKS=1 the gate judges the turn's marks in the intake's log: a claim on a file whose only read failed has no receipt", () => {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const saved = { ORUNMILA_HOME: process.env.ORUNMILA_HOME, ORUNMILA_GATE_FROM_MARKS: process.env.ORUNMILA_GATE_FROM_MARKS, ORUNMILA_LAWS: process.env.ORUNMILA_LAWS };
  try {
    process.env.ORUNMILA_HOME = home;
    delete process.env.ORUNMILA_LAWS;
    const router = createRouter({ home, clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: 't', installKey: crypto.randomBytes(32), hookSettingsFor: () => [] });
    const send = (p) => router.payload({ session_id: 'g1', cwd: root, ...p }, { channel: 'command' });
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'check it' });
    send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/x.js') }, tool_use_id: 'c1' });
    send({ hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/x.js') }, tool_use_id: 'c1', error: 'File does not exist.' });
    router.stop('over');
    const { runGate } = require('../src/laws/gate');
    const { getAdapter } = require('../src/capture/agents');
    const judge = () => {
      let check = null;
      runGate({ session_id: 'g1', hook_event_name: 'Stop', last_assistant_message: 'src/x.js contains no TODO markers.' }, getAdapter('claude-code'), { root, onCheck: (c) => (check = c) });
      return check;
    };
    process.env.ORUNMILA_GATE_FROM_MARKS = '1';
    const on = judge();
    const unreceipted = on.findings.flatMap((f) => (f.evidence && f.evidence.unreceipted_targets) || []);
    assert.ok(unreceipted.includes('src/x.js'), JSON.stringify(on.findings.map((f) => [f.law_id, f.evidence])));
    // A read that worked is a receipt in the marks, which only the flag reads (the event log here is empty).
    const r2 = createRouter({ home, clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }), checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: 't', installKey: crypto.randomBytes(32), hookSettingsFor: () => [] });
    const send2 = (p) => r2.payload({ session_id: 'g2', cwd: root, ...p }, { channel: 'command' });
    send2({ hook_event_name: 'UserPromptSubmit', prompt: 'check it' });
    send2({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/x.js') }, tool_use_id: 'c2', tool_response: { type: 'text', file: { numLines: 1, startLine: 1, totalLines: 1 } } });
    r2.stop('over');
    const judge2 = () => {
      let check = null;
      runGate({ session_id: 'g2', hook_event_name: 'Stop', last_assistant_message: 'src/x.js contains no TODO markers.' }, getAdapter('claude-code'), { root, onCheck: (c) => (check = c) });
      return check.findings.flatMap((f) => (f.evidence && f.evidence.unreceipted_targets) || []);
    };
    assert.ok(!judge2().includes('src/x.js'), 'flag on: the read in the marks is a receipt');
    delete process.env.ORUNMILA_GATE_FROM_MARKS;
    assert.ok(judge2().includes('src/x.js'), 'flag off: the gate reads the event log, as before');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmrf(home);
    rmrf(root);
  }
});

runAll('gate-from-marks');
