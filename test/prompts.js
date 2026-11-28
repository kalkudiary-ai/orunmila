// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/prompts.js — src/opon/gate/prompts.js: a turn's prompts come only from
 * prompt marks the Glove delivered in that turn (open question 2, decided by
 * O 2026-11-16: brief v4 line 275; review/phase1-design.md section 2, tests
 * 75-77; NF38, NF54; Phase 1 slice B9b, pure part; LD68). Not wired. Marks and
 * payloads are built here; no real data.
 */

const { assert, it, runAll } = require('./helpers');
const { promptsOf } = require('../src/opon/gate/prompts');
const { translatePayload } = require('../src/opon/intake/adapters/claude-code');

let n = 0;
const mark = (turn, says, target, detail, source = 'hook') => ({ schema_version: 1, session_id: 's1', source, agent: 'claude-code', turn, sub_agent: null, observed_at: '2026-01-01T00:00:00.000Z', mono_ns: String(++n), cause_hint: null, target, says, detail });
const prompted = (turn, text, fromHuman = true) => mark(turn, 'prompted', { kind: 'turn', id: turn }, { prompt: text, from_human: fromHuman });
const turnEnd = (turn) => mark(turn, 'ended', { kind: 'turn', id: turn }, {});
const claimed = (turn) => mark(turn, 'claimed', { kind: 'claim' }, { text: 'done' }, 'agent_claim');

it('test 75: a continuation turn has no prompt of its own and never borrows the previous one', () => {
  const marks = [prompted('t1', 'fix the bug'), claimed('t1'), turnEnd('t1'), claimed('t2'), turnEnd('t2')];
  assert.deepStrictEqual(promptsOf(marks, 't2'), { prompts: [], continuation: true, refillsBudget: false });
  assert.deepStrictEqual(promptsOf(marks, 't1'), { prompts: [{ text: 'fix the bug', from_human: true }], continuation: false, refillsBudget: true });
});

it('test 76: a Stop whose prompt hook never fired writes no prompt mark', () => {
  const out = translatePayload({ hook_event_name: 'Stop', session_id: 's1' }, { turn: 't2', observedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(out.marks.length > 0, 'the Stop is translated');
  assert.deepStrictEqual(out.marks.filter((m) => m.mark.says === 'prompted'), []);
});

it("test 77: a prompt Claude Code wrote itself is listed, from_human false, and does not refill the block budget", () => {
  const marks = [prompted('t3', '<task-notification>done</task-notification>', false), turnEnd('t3')];
  assert.deepStrictEqual(promptsOf(marks, 't3'), { prompts: [{ text: '<task-notification>done</task-notification>', from_human: false }], continuation: false, refillsBudget: false });
});

it('every prompt delivered in the turn is listed in order; one from a human refills the budget', () => {
  const marks = [prompted('t4', 'first'), prompted('t4', '<task-notification>x</task-notification>', false), prompted('t4', 'go all three')];
  const r = promptsOf(marks, 't4');
  assert.deepStrictEqual(r.prompts.map((p) => p.text), ['first', '<task-notification>x</task-notification>', 'go all three']);
  assert.strictEqual(r.refillsBudget, true);
});

it('only a Glove prompt mark about this turn counts: another source, another turn target, or no turn does not', () => {
  const marks = [
    { ...prompted('t5', 'from a claim'), source: 'agent_claim' },
    mark('t5', 'prompted', { kind: 'turn', id: 't4' }, { prompt: 'aimed at t4', from_human: true }),
    { ...prompted('t5', 'no turn'), turn: null },
  ];
  assert.deepStrictEqual(promptsOf(marks, 't5'), { prompts: [], continuation: true, refillsBudget: false });
});

runAll('prompts');
