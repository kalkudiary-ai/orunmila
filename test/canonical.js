// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/canonical.js — src/verify/canonical.js, RFC 8785 (JSON Canonicalization
 * Scheme) for the hash chain (brief v3 line 247; Phase 1 slice A2).
 *
 * test/cases/canonical/rfc8785.json holds the RFC's own examples, lifted from
 * its text by line range (the file names the lines and the RFC's sha256).
 */

const { assert, fs, path, it, runAll } = require('./helpers');
const { canonicalize, canonicalBytes } = require('../src/verify/canonical');

const RFC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'canonical', 'rfc8785.json'), 'utf8'));
const double = (hex) => Buffer.from(hex, 'hex').readDoubleBE(0);

it('RFC 8785 Appendix B: every number sample serialises exactly as the table says (26 rows)', () => {
  const rows = RFC.appendix_b_table_1.rows;
  assert.strictEqual(rows.length, 26);
  let checked = 0;
  for (const r of rows) {
    if (r.json === null) continue;
    assert.strictEqual(canonicalize(double(r.ieee754)), r.json, `${r.ieee754} (${r.comment})`);
    checked++;
  }
  assert.strictEqual(checked, 24);
});

it('RFC 8785 Appendix B: NaN and Infinity are errors, never serialised', () => {
  const errs = RFC.appendix_b_table_1.rows.filter((r) => r.json === null);
  assert.deepStrictEqual(errs.map((r) => r.ieee754), ['7fffffffffffffff', '7ff0000000000000']);
  for (const r of errs) assert.throws(() => canonicalize(double(r.ieee754)), /NaN|Infinity|finite/);
  assert.throws(() => canonicalize(-Infinity), /finite/);
  assert.throws(() => canonicalize({ a: [Number.NaN] }), /finite/);
});

it('RFC 8785 sections 3.2.2 to 3.2.4: the sample canonicalises to the exact UTF-8 bytes printed in the RFC', () => {
  const got = canonicalBytes(JSON.parse(RFC.section_3_2_2_input.json_text));
  const want = Buffer.from(RFC.section_3_2_4_utf8_hex.bytes.join(''), 'hex');
  assert.strictEqual(want.length, 118);
  assert.ok(Buffer.isBuffer(got));
  assert.strictEqual(got.toString('hex'), want.toString('hex'));
});

it('RFC 8785 section 3.2.3: properties sort by UTF-16 code units, in the RFC\'s order', () => {
  const out = canonicalize(JSON.parse(RFC.section_3_2_3_sort.json_text));
  // Read the order from the text: JSON.parse would move the integer-like key "1" first.
  const at = RFC.section_3_2_3_sort.expected_value_order.map((label) => out.indexOf(JSON.stringify(label)));
  assert.ok(at.every((p) => p > 0), JSON.stringify(at));
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, `labels out of order in ${out}`);
  // UTF-16, not code point order: U+1F600 (surrogates D83D...) sorts before U+FB33.
  assert.ok(out.indexOf('\u{1F600}') < out.indexOf('דּ'));
});

it('sorting is recursive into objects and arrays; array order is kept; no whitespace', () => {
  const out = canonicalize({ b: [{ z: 1, a: 2 }, 3], a: { y: null, x: true } });
  assert.strictEqual(out, '{"a":{"x":true,"y":null},"b":[{"a":2,"z":1},3]}');
  assert.strictEqual(canonicalize(['b', 'a']), '["b","a"]');
  assert.strictEqual(canonicalize({}), '{}');
  assert.strictEqual(canonicalize([]), '[]');
  assert.strictEqual(canonicalize(''), '""');
  assert.strictEqual(canonicalize({ '': 1, a: 2, aa: 3, ab: 4 }), '{"":1,"a":2,"aa":3,"ab":4}');
});

it('strings: control characters as lowercase \\u escapes or the five short forms; everything else as is', () => {
  assert.strictEqual(canonicalize('\u0000\u001f\b\t\n\f\r'), '"\\u0000\\u001f\\b\\t\\n\\f\\r"');
  assert.strictEqual(canonicalize('"\\/'), '"\\"\\\\/"');
  assert.strictEqual(canonicalize('\u007f\u0080 \u{1F600}'), '"\u007f\u0080 \u{1F600}"');
  assert.strictEqual(canonicalBytes('€').toString('hex'), '22e282ac22');
});

it('a lone surrogate, in a value or a property name, is an error (RFC 8785 section 3.2.2.2)', () => {
  assert.throws(() => canonicalize('\udead'), /surrogate/);
  assert.throws(() => canonicalize('a\ud83d'), /surrogate/);
  assert.throws(() => canonicalize('\ude00b'), /surrogate/);
  assert.throws(() => canonicalize({ ['\ud800']: 1 }), /surrogate/);
  assert.strictEqual(canonicalize('😀'), '"\u{1F600}"');
});

it('anything JSON cannot hold is an error, never silently dropped or converted', () => {
  for (const bad of [undefined, () => 1, Symbol('s'), 10n, new Date(0), new Map(), /x/, { a: undefined }, [undefined]]) {
    assert.throws(() => canonicalize(bad), TypeError, String(bad));
  }
  assert.strictEqual(canonicalize(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
  assert.strictEqual(canonicalize(-0), '0');
});

runAll('canonical');
