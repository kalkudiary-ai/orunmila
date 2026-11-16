'use strict';

/**
 * test/adapter-law-gate.js — the law gate's checks as `checked` marks (Phase 1
 * slice A8, law-gate adapter; brief v3 lines 199, 242, 575; test 61; NF16).
 * Input is the gate's own decision pieces (evaluateTurn's findings, whether it
 * blocked, whether the block budget was spent, or why it skipped).
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { translateCheck } = require('../src/opon/intake/adapters/law-gate');
const { createSessionLog } = require('../src/opon/ledger/session-log');

const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const SID = HEADERS.good.header.session_id;
const at = { sessionId: SID, agent: 'claude-code', turn: 't7', observedAt: '2026-11-16T11:00:00.000Z' };
const finding = (law_id, severity, text) => ({ law_id, severity, message: 'm', remedy: 'r', evidence: { text } });

it('test 61: a check that passes, one that warns, one that blocks and one that skips: one checked mark each, naming the turn, with result, laws and quoted text', () => {
  const cases = [
    [{ findings: [] }, 'passed', []],
    [{ findings: [finding('no-uncertainty-as-fact', 'warn', 'It is definitely fixed.')] }, 'warned', [{ law: 'no-uncertainty-as-fact', severity: 'warn', quote: 'It is definitely fixed.' }]],
    [{ findings: [finding('no-green-without-command', 'block', 'All tests pass.')], blocked: true }, 'blocked', [{ law: 'no-green-without-command', severity: 'block', quote: 'All tests pass.' }]],
    [{ skipped: 'could not confirm the current turn' }, 'skipped', []],
  ];
  for (const [check, result, findings] of cases) {
    const r = translateCheck({ ...at, check });
    assert.deepStrictEqual(r.rejects, [], result);
    const m = r.mark;
    assert.deepStrictEqual([m.source, m.says, m.turn, m.target], ['law_gate', 'checked', 't7', { kind: 'turn', id: 't7' }], result);
    assert.strictEqual(m.detail.result, result);
    assert.deepStrictEqual(m.detail.findings, findings, result);
  }
  assert.strictEqual(translateCheck({ ...at, check: { skipped: 'could not confirm the current turn' } }).mark.detail.reason, 'could not confirm the current turn');
});

it('a blocking finding the budget no longer lets block is warned, with budget_exhausted: never silent', () => {
  const m = translateCheck({ ...at, check: { findings: [finding('no-green-without-command', 'block', 'Done, tests green.')], blocked: false, exhausted: true } }).mark;
  assert.strictEqual(m.detail.result, 'warned');
  assert.strictEqual(m.detail.budget_exhausted, true);
});

it('a finding with no sentence quotes null, never an invented quote', () => {
  const m = translateCheck({ ...at, check: { findings: [{ law_id: 'x', severity: 'warn', evidence: {} }] } }).mark;
  assert.deepStrictEqual(m.detail.findings, [{ law: 'x', severity: 'warn', quote: null }]);
});

it('inconsistent input is rejected with a reason: blocked with no blocking finding, no turn, a check that is none of the four', () => {
  assert.ok(translateCheck({ ...at, check: { findings: [finding('a', 'warn', 'x')], blocked: true } }).rejects[0].reason.includes('blocked'));
  assert.ok(translateCheck({ ...at, turn: null, check: { findings: [] } }).rejects[0].reason.includes('turn'));
  assert.ok(translateCheck({ ...at, check: null }).rejects[0].reason.includes('check'));
});

it('every check mark is accepted by the session log, and a quoted secret is redacted there', () => {
  const dir = tmpDir();
  try {
    const h = JSON.parse(JSON.stringify(HEADERS.good.header));
    delete h.seq;
    delete h.prev_hash;
    delete h.hash;
    const log = createSessionLog(path.join(dir, 's'), h);
    const key = 'ghp_' + 'b'.repeat(36);
    for (const check of [{ findings: [] }, { findings: [finding('no-green-without-command', 'block', `pushed with ${key}`)], blocked: true }, { skipped: 'could not confirm the current turn' }]) {
      const res = log.append(translateCheck({ ...at, check }).mark);
      assert.strictEqual(res.ok, true, JSON.stringify(res));
    }
    assert.ok(!fs.readFileSync(path.join(dir, 's', 'raw.jsonl'), 'utf8').includes(key));
  } finally {
    rmrf(dir);
  }
});

runAll('adapter-law-gate');
