'use strict';

/**
 * test/overlap.js — which sessions were active in a folder at a time, told
 * from the session logs alone (brief v4 lines 344, 404-405, 602; decision
 * LD63 under O's D15: no mark field). Records are built here; no real data.
 */

const { assert, it, runAll } = require('./helpers');

const { spanOf, concurrent } = require('../src/opon/intake/overlap');

const ROOT_A = '/work/a';
const ROOT_B = '/work/b';

const header = (id, root, mono) => ({ schema_version: 1, record: 'session_header', session_id: id, seq: 0, observed_at: '2026-01-01T00:00:00.000Z', mono_ns: String(mono), project_root: root });
const mark = (id, seq, mono, says = 'tick', target = null) => ({ schema_version: 1, session_id: id, seq, source: 'process', observed_at: '2026-01-01T00:00:01.000Z', mono_ns: String(mono), says, target });
const endMark = (id, seq, mono) => ({ ...mark(id, seq, mono, 'ended', { kind: 'session', id }), source: 'hook', turn: null });

it('spanOf: a session runs from its header to its last record, in its project root', () => {
  const s = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 150), mark('s1', 2, 900)]);
  assert.deepStrictEqual(s, { id: 's1', root: ROOT_A, from: '100', to: '900', ended: false });
});

it("spanOf: the session's end mark ends the span; a late mark after it does not extend it", () => {
  const s = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 150), endMark('s1', 2, 400), mark('s1', 3, 950)]);
  assert.deepStrictEqual(s, { id: 's1', root: ROOT_A, from: '100', to: '400', ended: true });
});

it('spanOf: an ended mark about something other than the session does not end it', () => {
  const s = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 300, 'ended', { kind: 'turn', id: 't1' }), mark('s1', 2, 700)]);
  assert.deepStrictEqual(s, { id: 's1', root: ROOT_A, from: '100', to: '700', ended: false });
});

it('spanOf: a continuation record (a log in parts, no times) is skipped', () => {
  const cont = { schema_version: 1, record: 'continuation', session_id: 's1', log: 'raw', part: 2, seq: 2, cut: { line: 3, bytes: 10, fingerprint: 'x' } };
  const s = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 200), cont, mark('s1', 3, 600)]);
  assert.deepStrictEqual(s, { id: 's1', root: ROOT_A, from: '100', to: '600', ended: false });
  const last = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 200), cont]);
  assert.deepStrictEqual(last, { id: 's1', root: ROOT_A, from: '100', to: '200', ended: false }, 'a continuation as the last record');
});

it('spanOf refuses records that do not start with a session header', () => {
  assert.throws(() => spanOf([mark('s1', 1, 200)]), /session header/);
  assert.throws(() => spanOf([]), /session header/);
});

it('concurrent: names every session active in the folder at that time, sorted, both ends included', () => {
  const spans = [
    spanOf([header('s2', ROOT_A, 100), mark('s2', 1, 500)]),
    spanOf([header('s1', ROOT_A, 300), mark('s1', 1, 800)]),
    spanOf([header('s3', ROOT_A, 600), mark('s3', 1, 900)]),
  ];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '400'), ['s1', 's2']);
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '500'), ['s1', 's2'], 'the last record is still active');
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '300'), ['s1', 's2'], 'the header is already active');
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '501'), ['s1']);
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '99'), []);
});

it('concurrent: a session in another folder is never named', () => {
  const spans = [spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 900)]), spanOf([header('s2', ROOT_B, 100), mark('s2', 1, 900)])];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '500'), ['s1']);
  assert.deepStrictEqual(concurrent(spans, ROOT_B, '500'), ['s2']);
});

it('concurrent: an ended session is not active after its end mark', () => {
  const spans = [spanOf([header('s1', ROOT_A, 100), endMark('s1', 1, 400), mark('s1', 2, 950)]), spanOf([header('s2', ROOT_A, 100), mark('s2', 1, 950)])];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '900'), ['s2']);
});

it('concurrent: mono_ns compares as an integer, never as text', () => {
  const spans = [spanOf([header('s1', ROOT_A, 999), mark('s1', 1, 1000)]), spanOf([header('s2', ROOT_A, 5), mark('s2', 1, 20)])];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '1000'), ['s1']);
  assert.deepStrictEqual(concurrent(spans, ROOT_A, 10n), ['s2'], 'a bigint time is accepted');
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '100'), []);
});

it('spanOf: an ended mark with a null target does not end the session', () => {
  const s = spanOf([header('s1', ROOT_A, 100), mark('s1', 1, 300, 'ended', null), mark('s1', 2, 700)]);
  assert.deepStrictEqual(s, { id: 's1', root: ROOT_A, from: '100', to: '700', ended: false });
});

it('concurrent: mono_ns past 2^53 stays exact', () => {
  // 2^53 + 1 has no exact float: as a Number it reads as 2^53.
  const spans = [spanOf([header('s1', ROOT_A, '9007199254740993')])];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '9007199254740992'), [], 'one nanosecond before the header');
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '9007199254740993'), ['s1']);
});

it("concurrent: a folder whose name extends another's is a different folder", () => {
  const spans = [spanOf([header('s1', '/work/a', 100), mark('s1', 1, 900)]), spanOf([header('s2', '/work/ab', 100), mark('s2', 1, 900)])];
  assert.deepStrictEqual(concurrent(spans, '/work/a', '500'), ['s1']);
  assert.deepStrictEqual(concurrent(spans, '/work/ab', '500'), ['s2']);
});

it('concurrent: a session in a subfolder and one in its parent watch the same files, so both are named (NF80)', () => {
  const at = (id, root) => spanOf([header(id, root, 100), mark(id, 1, 900)]);
  const spans = [at('s1', '/work/a'), at('s2', '/work/a/sub'), at('s3', '/work/ab'), at('s4', '/work/b'), at('s5', '/work/a/sub/deep')];
  assert.deepStrictEqual(concurrent(spans, '/work/a', '500'), ['s1', 's2', 's5'], 'the parent names every session below it');
  assert.deepStrictEqual(concurrent(spans, '/work/a/sub', '500'), ['s1', 's2', 's5'], 'a subfolder names its parent and its own subfolders');
  assert.deepStrictEqual(concurrent(spans, '/work/a/sub/deep', '500'), ['s1', 's2', 's5']);
  assert.deepStrictEqual(concurrent(spans, '/work/ab', '500'), ['s3'], 'a name that extends another is still a different folder');
  assert.deepStrictEqual(concurrent(spans, '/work/a/', '500'), ['s1', 's2', 's5'], 'a trailing separator names the same folder');
  assert.deepStrictEqual(concurrent([at('r', '/'), at('s1', '/work/a')], '/work/a', '500'), ['r', 's1'], 'the file system root holds every folder');
});

it('concurrent: Windows roots nest by whole folder names too (NF80)', () => {
  const at = (id, root) => spanOf([header(id, root, 100), mark(id, 1, 900)]);
  const spans = [at('w1', 'C:\\work\\a'), at('w2', 'C:\\work\\a\\sub'), at('w3', 'C:\\work\\ab'), at('w4', 'C:\\')];
  assert.deepStrictEqual(concurrent(spans, 'C:\\work\\a', '500'), ['w1', 'w2', 'w4']);
  assert.deepStrictEqual(concurrent(spans, 'C:\\work\\ab', '500'), ['w3', 'w4']);
  assert.deepStrictEqual(concurrent(spans, 'D:\\work\\a', '500'), [], 'another drive is another folder');
});

it('concurrent: a header-only session is active only at its start', () => {
  const spans = [spanOf([header('s1', ROOT_A, 100)])];
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '100'), ['s1']);
  assert.deepStrictEqual(concurrent(spans, ROOT_A, '101'), []);
});

runAll('overlap');
