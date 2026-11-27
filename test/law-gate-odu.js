// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/law-gate-odu.js — the law gate's results in the odù record and the judge's counts (Phase 6 slice Q40, LD284; O's
 * yes to Q40, 2026-11-24; LD267 reversed). The odù's `witness_status` gets a `law_gate` entry when law-gate marks are
 * behind it, its slots carrying each check's `result` (brief v4 line 331's "key detail slots"); the judge counts the
 * checks into the session verdict (`law_gate`: checked, passed, warned, blocked, skipped, the skip rate) and gives each
 * block its own Look at this (R21, line 692) and a skip rate over 2% its own (R22, line 686), so the verdict log alone
 * carries them; the report reads them from there. Hand-built session logs (test/helpers-opon.js); made-up content.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { buildReport } = require('../src/babalawo/report');
const { compile } = require('../src/verify/schema');

const schemaOf = (f) => compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', f), 'utf8')));
const recs = (text) => text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
const checked = (ms, turn, result, findings = []) => ({ ...M.tick(ms), source: 'law_gate', agent: 'claude-code', turn, target: { kind: 'turn', id: turn }, says: 'checked', detail: { result, findings } });

/** Turns, each a prompt, a claim, its end and the law gate's check with `results[i]`. */
function session(base, results) {
  const s = makeLog(base);
  results.forEach((r, i) => {
    const t = `t${i + 1}`;
    const at = i * 1000;
    s.append(M.prompted(at, t));
    s.append(M.claimed(at + 100, t));
    s.append(M.turnEnded(at + 200, t));
    s.append(checked(at + 210, t, r, r === 'blocked' ? [{ law: 'no-claim-without-receipt', severity: 'block', quote: 'done' }] : []));
  });
  s.append(M.tick(results.length * 1000 + 20000));
  const out = replayFolder(s.dir);
  return { s, odus: recs(out.odu), verdicts: recs(out.verdict), marks: recs(fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8')) };
}

it('Q40: an odù with a law-gate check carries a law_gate witness whose slots hold the result, valid by spec/odu.schema.json', () => {
  const base = tmpDir();
  try {
    const { odus } = session(base, ['blocked']);
    const o = odus.find((x) => x.record === 'odu' && x.witness_status.law_gate);
    assert.ok(o, JSON.stringify(odus.map((x) => x.witness_status)));
    assert.strictEqual(o.witness_status.law_gate.status, 'saw');
    assert.deepStrictEqual(o.witness_status.law_gate.slots.map((x) => x.result), ['blocked']);
    assert.deepStrictEqual(schemaOf('odu.schema.json')(o), []);
    assert.ok(odus.filter((x) => x.record === 'odu' && !x.witnesses.includes('law_gate')).every((x) => !x.witness_status.law_gate), 'no law_gate entry where the law gate said nothing');
  } finally {
    rmrf(base);
  }
});

it('Q40: the judge counts the checks into the session verdict, a block is its own Look at this (R21), and the session verdict is valid', () => {
  const base = tmpDir();
  try {
    const { verdicts } = session(base, ['passed', 'blocked', 'warned']);
    const sv = verdicts.filter((v) => v.record === 'session_verdict').pop();
    assert.deepStrictEqual(sv.law_gate, { checked: 3, passed: 1, warned: 1, blocked: 1, skipped: 0, skip_rate: 0, over_ceiling: false });
    assert.deepStrictEqual(schemaOf('session-verdict.schema.json')(sv), []);
    const blocks = verdicts.filter((v) => v.record === 'verdict' && (v.rule === 'R21' || v.also.includes('R21')));
    assert.strictEqual(blocks.length, 1, JSON.stringify(verdicts.filter((v) => v.record === 'verdict').map((v) => [v.rule, v.also])));
    assert.ok(['look_at_this', 'violation'].includes(blocks[0].verdict));
    assert.notStrictEqual(sv.verdict, 'clean');
  } finally {
    rmrf(base);
  }
});

it('Q40: a skip rate over 2% makes the session at least Look at this (R22), never Incomplete (test 51)', () => {
  const base = tmpDir();
  try {
    const { verdicts } = session(base, ['passed', 'skipped']);
    const sv = verdicts.filter((v) => v.record === 'session_verdict').pop();
    assert.deepStrictEqual(sv.law_gate, { checked: 2, passed: 1, warned: 0, blocked: 0, skipped: 1, skip_rate: 50, over_ceiling: true });
    assert.strictEqual(sv.verdict === 'clean' || sv.verdict === 'incomplete', false, sv.verdict);
  } finally {
    rmrf(base);
  }
});

it("Q40: the report reads the law gate's counts and blocks from the verdict log, not from the raw marks", () => {
  const base = tmpDir();
  try {
    const { odus, verdicts, marks } = session(base, ['blocked', 'passed']);
    const withoutGate = marks.slice(1).filter((m) => m.source !== 'law_gate');
    const rep = buildReport({ header: marks[0], marks: withoutGate, odus: odus.slice(1), verdicts });
    assert.deepStrictEqual(rep.law_gate, { checked: 2, passed: 1, warned: 0, blocked: 1, skipped: 0, skip_rate: 0 });
    const f = rep.findings.filter((x) => x.kind === 'law_gate_block');
    assert.strictEqual(f.length, 1, JSON.stringify(rep.findings));
    assert.ok(f[0].sentence.startsWith('The law gate blocked turn t1'), f[0].sentence);
  } finally {
    rmrf(base);
  }
});

it("Q40: for a judgement made before the law gate's results were in the odù record, the report still counts them from the raw marks (LD267)", () => {
  const base = tmpDir();
  try {
    const { odus, verdicts, marks } = session(base, ['blocked', 'skipped']);
    const old = verdicts.map((v) => {
      if (v.record !== 'session_verdict') return v;
      const o = { ...v };
      delete o.law_gate;
      return o;
    });
    const rep = buildReport({ header: marks[0], marks: marks.slice(1), odus: odus.slice(1), verdicts: old });
    assert.deepStrictEqual(rep.law_gate, { checked: 2, passed: 0, warned: 0, blocked: 1, skipped: 1, skip_rate: 50 });
    assert.strictEqual(rep.findings.filter((x) => x.kind === 'law_gate_block').length, 1, JSON.stringify(rep.findings));
    assert.ok(rep.findings.some((x) => x.kind === 'law_gate_skips'), JSON.stringify(rep.findings));
  } finally {
    rmrf(base);
  }
});

it("SR1: an odù log written by an intake older than Q40 (no law_gate witness) gives the report the raw marks' counts, never 0 checked", () => {
  const base = tmpDir();
  try {
    const { odus, verdicts, marks } = session(base, ['blocked', 'skipped']);
    const older = odus.map((o) => {
      if (o.record !== 'odu' || !o.witness_status.law_gate) return o;
      const ws = { ...o.witness_status };
      delete ws.law_gate;
      return { ...o, witness_status: ws };
    });
    const zero = { checked: 0, passed: 0, warned: 0, blocked: 0, skipped: 0, skip_rate: 0, over_ceiling: false };
    const judged = verdicts.map((v) => (v.record === 'session_verdict' ? { ...v, law_gate: zero } : v.rule === 'R21' ? { ...v, rule: 'R0', verdict: 'clean' } : v));
    const rep = buildReport({ header: marks[0], marks: marks.slice(1), odus: older.slice(1), verdicts: judged });
    assert.deepStrictEqual(rep.law_gate, { checked: 2, passed: 0, warned: 0, blocked: 1, skipped: 1, skip_rate: 50 });
    assert.strictEqual(rep.findings.filter((x) => x.kind === 'law_gate_block').length, 1, JSON.stringify(rep.findings));
    const none = buildReport({ header: marks[0], marks: marks.slice(1).filter((m) => m.source !== 'law_gate'), odus: older.slice(1), verdicts: judged });
    assert.strictEqual(none.law_gate.checked, 0, 'no gate marks and no counts: still 0');
  } finally {
    rmrf(base);
  }
});

runAll('law-gate-odu');
