// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/chain.js — src/verify/chain.js, the hash chain of spec/hash-chain.md
 * (brief v3 line 247; Phase 1 slice A3a). Records come from the spec fixtures
 * (synthetic).
 */

const { assert, fs, path, it, runAll } = require('./helpers');
const { hashRecord, seal, verifyText } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));

/** A sealed log: the good header, then four good marks renumbered 1..4. */
function buildLog() {
  const recs = [];
  const strip = (r) => {
    const o = { ...r };
    delete o.hash;
    delete o.prev_hash;
    return o;
  };
  recs.push(seal(strip(HEADERS.good.header), null));
  ['hook_started', 'hook_exited_fail', 'sentinel_modified', 'hook_read_range'].forEach((name, i) => {
    recs.push(seal({ ...strip(SPEC.good[name]), seq: i + 1 }, recs[recs.length - 1].hash));
  });
  return recs;
}
const text = (recs) => recs.map((r) => canonicalize(r) + '\n').join('');
const lines = (recs) => text(recs).split('\n').slice(0, -1);
const join = (ls) => ls.map((l) => l + '\n').join('');

it('hashRecord: the exact bytes hashed match an independent SHA-256 (Python hashlib) of the hand-written canonical text', () => {
  const header = { session_id: 'ses_x', seq: 0, schema_version: 1, record: 'session_header', prev_hash: null };
  assert.strictEqual(hashRecord(header), 'sha256:2f286be543fa9862bebcbfe834c9e0eda11aa2d07c34d03f16bb922f00cd97d6');
  const mark = { t: '€', seq: 1, prev_hash: 'sha256:' + '0'.repeat(64), n: [1, 2, 3] };
  assert.strictEqual(hashRecord(mark), 'sha256:3b9ae776a92c892d38a3c0d444927f725a074eb07334dc68434b2b1b2e7eec4d');
  // The record's own hash member is never part of what is hashed.
  assert.strictEqual(hashRecord({ ...mark, hash: 'sha256:' + 'f'.repeat(64) }), hashRecord(mark));
});

it('seal links each record to the one before; an untouched log verifies, with its line count', () => {
  const recs = buildLog();
  assert.strictEqual(recs[0].prev_hash, null);
  for (let i = 1; i < recs.length; i++) assert.strictEqual(recs[i].prev_hash, recs[i - 1].hash);
  assert.deepStrictEqual(verifyText(text(recs)), { ok: true, lines: 5 });
});

it('a field edited in line 3, written back canonically: "line 3 was changed after it was written"', () => {
  const ls = lines(buildLog());
  const r = JSON.parse(ls[2]);
  r.detail.exit_status = 'pass';
  ls[2] = canonicalize(r);
  assert.deepStrictEqual(verifyText(join(ls)), { ok: false, line: 3, reason: 'changed', checked: 2 });
});

it('line 3 edited and its hash recomputed: line 4 no longer follows it', () => {
  const recs = buildLog();
  const edited = { ...recs[2], detail: { ...recs[2].detail, exit_status: 'pass' } };
  delete edited.hash;
  recs[2] = seal(edited, recs[1].hash);
  assert.deepStrictEqual(verifyText(text(recs)), { ok: false, line: 4, reason: 'does not follow', checked: 3 });
});

it('line 3 deleted: the line now at 3 does not follow line 2', () => {
  const ls = lines(buildLog());
  ls.splice(2, 1);
  assert.deepStrictEqual(verifyText(join(ls)), { ok: false, line: 3, reason: 'does not follow', checked: 2 });
});

it('lines 2 and 3 swapped: line 2 does not follow line 1', () => {
  const ls = lines(buildLog());
  [ls[1], ls[2]] = [ls[2], ls[1]];
  assert.deepStrictEqual(verifyText(join(ls)), { ok: false, line: 2, reason: 'does not follow', checked: 1 });
});

it('a line respelt with the same data (whitespace, key order, an escape) is not canonical', () => {
  const ls = lines(buildLog());
  const variants = [
    JSON.stringify(JSON.parse(ls[1]), null, 1).replace(/\n/g, ''),
    ls[1].replace('{', '{ '),
    JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(ls[1])).reverse())),
  ];
  for (const v of variants) {
    const copy = [...ls];
    copy[1] = v;
    assert.deepStrictEqual(verifyText(join(copy)), { ok: false, line: 2, reason: 'not canonical', checked: 1 }, v);
  }
});

it('a line that is not a JSON object, a blank line, a carriage return, or no final line feed: not canonical', () => {
  const ls = lines(buildLog());
  const cases = [
    [[ls[0], 'not json', ls[1]], 2],
    [[ls[0], '[1,2]', ls[1]], 2],
    [[ls[0], '', ls[1]], 2],
  ];
  for (const [c, at] of cases) assert.strictEqual(verifyText(join(c)).line, at, JSON.stringify(c[1]));
  assert.deepStrictEqual(verifyText(ls.map((l) => l + '\r\n').join('')), { ok: false, line: 1, reason: 'not canonical', checked: 0 });
  assert.deepStrictEqual(verifyText(ls.join('\n')), { ok: false, line: 5, reason: 'not canonical', checked: 4, cut: true }, 'no final line feed: cut, as a crash leaves it (LD57)');
});

it('the header must start the chain: a prev_hash on line 1 does not follow; seq must count 0, 1, 2, ...', () => {
  const recs = buildLog();
  const h = { ...recs[0], prev_hash: 'sha256:' + 'a'.repeat(64) };
  delete h.hash;
  recs[0] = seal(h, h.prev_hash);
  assert.deepStrictEqual(verifyText(text(recs)), { ok: false, line: 1, reason: 'does not follow', checked: 0 });
  // A seq gap with a correctly rebuilt chain is still caught.
  const g = buildLog();
  const rebuilt = [g[0]];
  g.slice(1).forEach((r, i) => {
    const o = { ...r, seq: i === 2 ? 9 : r.seq };
    delete o.hash;
    rebuilt.push(seal(o, rebuilt[rebuilt.length - 1].hash));
  });
  assert.deepStrictEqual(verifyText(text(rebuilt)), { ok: false, line: 4, reason: 'out of sequence', checked: 3 });
});

it('only the first broken line is named', () => {
  const ls = lines(buildLog());
  ls[1] = ls[1].replace('{', '{ ');
  ls[3] = 'garbage';
  assert.strictEqual(verifyText(join(ls)).line, 2);
});

it('known limit (spec/hash-chain.md): a log cut short at the end still verifies; the footer is what shows it', () => {
  const ls = lines(buildLog());
  assert.deepStrictEqual(verifyText(join(ls.slice(0, 3))), { ok: true, lines: 3 });
  assert.deepStrictEqual(verifyText(''), { ok: false, line: 1, reason: 'missing', checked: 0 });
});

it('LR2b (LD252): verifyBuffer, which reads a log a line at a time, gives verifyText\'s answer on every case of this suite, from the start and as a later part, with the records of the lines that held', () => {
  const { verifyBuffer } = require('../src/verify/chain');
  const good = buildLog();
  const ls = lines(good);
  const edited = [...ls];
  edited[2] = canonicalize({ ...JSON.parse(ls[2]), seq: 99 });
  const rehashed = buildLog();
  rehashed[2] = seal({ ...rehashed[2], detail: { ...rehashed[2].detail, tool: 'Other' } }, rehashed[1].hash);
  const header = { ...good[0], prev_hash: 'sha256:' + 'a'.repeat(64) };
  delete header.hash;
  const gap = [good[0]];
  good.slice(1).forEach((r, i) => {
    const o = { ...r, seq: i === 2 ? 9 : r.seq };
    delete o.hash;
    gap.push(seal(o, gap[gap.length - 1].hash));
  });
  const cases = [
    text(good), join(edited), text(rehashed), join([ls[0], ls[1], ls[3], ls[4]]), join([ls[0], ls[2], ls[1], ls[3]]),
    join([ls[0], ls[1].replace('{', '{ ')]), join([ls[0], '[]']), join([ls[0], '', ls[1]]), join([ls[0] + '\r']), join(ls).slice(0, -1),
    join(ls).slice(0, -20), text([seal(header, header.prev_hash), ...good.slice(1)]), text(gap), join(ls.slice(0, 3)), '',
  ];
  const later = { prevHash: good[1].hash, seq: 2 }; // a part that continues after line 2 (LD57)
  for (const [i, t] of cases.entries()) {
    for (const start of [undefined, later, { prevHash: null, seq: 0 }]) {
      const want = verifyText(t, start);
      const { records, ...got } = verifyBuffer(Buffer.from(t, 'utf8'), start);
      assert.deepStrictEqual(got, want, `case ${i}, start ${JSON.stringify(start)}`);
      const held = want.ok ? want.lines : want.checked;
      assert.deepStrictEqual(records, t.split('\n').slice(0, held).map((l) => JSON.parse(l)), `case ${i}: records`);
    }
  }
  const tail = verifyBuffer(Buffer.from(join(ls.slice(2)), 'utf8'), later); // lines 3.. as a later part: it holds
  assert.deepStrictEqual([tail.ok, tail.lines], [true, 3]);
});

runAll('chain');
