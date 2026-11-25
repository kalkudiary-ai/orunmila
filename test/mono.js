// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/mono.js — mono_ns as a decimal string (brief v4 line 238; spec open
 * point P1, decided by O 2026-11-16; slice S1b). A JSON number is exact only
 * up to 2^53, about 104 days of nanoseconds since boot.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');

const { monoString, nowMono } = require('../src/opon/intake/mono');
const { compile } = require('../src/verify/schema');
const markSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'mark.schema.json'), 'utf8'));
const headerSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'session-header.schema.json'), 'utf8'));

const PAST_2_53 = 2n ** 60n; // about 36 years of nanoseconds: far past the exact range of a JSON number

it('monoString: a bigint, a safe integer or a decimal string becomes the exact decimal string', () => {
  assert.strictEqual(monoString(PAST_2_53), '1152921504606846976');
  assert.strictEqual(monoString(0n), '0');
  assert.strictEqual(monoString(5000000000), '5000000000');
  assert.strictEqual(monoString('81234567890123'), '81234567890123');
});

it('monoString refuses what is not an exact non-negative integer: undefined, never a rounded value', () => {
  assert.strictEqual(monoString(2 ** 53 + 2), undefined, 'a number past 2^53 may already be rounded');
  assert.strictEqual(monoString(-1), undefined);
  assert.strictEqual(monoString(-1n), undefined);
  assert.strictEqual(monoString(1.5), undefined);
  assert.strictEqual(monoString('-1'), undefined);
  assert.strictEqual(monoString('007'), undefined, 'one spelling per value, so the hash is stable');
  assert.strictEqual(monoString('1e9'), undefined);
  assert.strictEqual(monoString(null), undefined);
});

it("nowMono: the process's monotonic clock, as a decimal string", () => {
  const a = nowMono();
  const b = nowMono();
  assert.match(a, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(b) >= BigInt(a));
});

it('the mark and session-header schemas take mono_ns as a decimal string and refuse a JSON number', () => {
  const m = compile(markSchema.properties.mono_ns);
  const h = compile(headerSchema.properties.mono_ns);
  for (const c of [m, h]) {
    assert.deepStrictEqual(c('1152921504606846976'), []);
    assert.deepStrictEqual(c(81234567890123).map((e) => e.keyword), ['type']);
    assert.deepStrictEqual(c('-1').map((e) => e.keyword), ['pattern']);
    assert.deepStrictEqual(c('007').map((e) => e.keyword), ['pattern']);
  }
});

it("intake's own stamp, the header builder and the Claude Code adapter all write the string form", () => {
  const { buildHeader } = require('../src/opon/intake/header');
  const { translatePayload } = require('../src/opon/intake/adapters/claude-code');
  const h = buildHeader({ sessionId: 's', root: ROOT, agent: { name: 'claude-code' }, orunmilaVersion: '0', codeRoot: path.join(ROOT, 'spec'), monoNs: PAST_2_53 });
  assert.strictEqual(h.mono_ns, '1152921504606846976');
  assert.match(buildHeader({ sessionId: 's', root: ROOT, agent: { name: 'claude-code' }, orunmilaVersion: '0', codeRoot: path.join(ROOT, 'spec') }).mono_ns, /^[1-9][0-9]*$/);
  const r = translatePayload({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'go' }, { turn: 't1', observedAt: '2026-11-16T00:00:00Z', monoNs: PAST_2_53 });
  assert.strictEqual(r.marks[0].mark.mono_ns, '1152921504606846976');
});

runAll('mono');
