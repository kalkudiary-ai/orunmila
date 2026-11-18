'use strict';

/**
 * test/spec.js — the v1 record-format drafts in spec/ (brief v3, "The
 * contract: the record formats") and the in-house checker that reads them,
 * src/verify/schema.js (Phase 1 slice A1).
 *
 * Fixtures (test/cases/spec/*.json) are synthetic: good records, and bad ones
 * made from a good record by one patch, each naming the reason it must be
 * rejected for (the instance path and the schema keyword).
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');
const { compile, SUPPORTED } = require('../src/verify/schema');

const SPEC = path.join(ROOT, 'spec');
const CASES = path.join(__dirname, 'cases', 'spec');
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// --- JSON Pointer patches -------------------------------------------------------

function unescape(seg) {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}
function value(v) {
  // {"$repeat": "x", "times": n} stands for a long string the fixture cannot spell.
  return v && typeof v === 'object' && !Array.isArray(v) && '$repeat' in v ? v.$repeat.repeat(v.times) : v;
}
function patch(base, { set = {}, unset = [] }) {
  const doc = JSON.parse(JSON.stringify(base));
  const walk = (ptr) => {
    const segs = ptr.split('/').slice(1).map(unescape);
    const last = segs.pop();
    let o = doc;
    for (const s of segs) o = o[s];
    return [o, last];
  };
  for (const [ptr, v] of Object.entries(set)) {
    const [o, k] = walk(ptr);
    o[k] = value(v);
  }
  for (const ptr of unset) {
    const [o, k] = walk(ptr);
    delete o[k];
  }
  return doc;
}

// --- one block of tests per format -----------------------------------------------

const FORMATS = [
  { name: 'mark', schema: 'mark.schema.json', cases: 'marks.json' },
  { name: 'session header', schema: 'session-header.schema.json', cases: 'session-headers.json', sweep: true },
  { name: 'continuation', schema: 'continuation.schema.json', cases: 'continuations.json', sweep: true },
  { name: 'retention header', schema: 'retention-header.schema.json', cases: 'retention-headers.json', sweep: true },
  { name: 'retention removal', schema: 'retention-removal.schema.json', cases: 'retention-removals.json', sweep: true },
];

// --- the deletion sweep (NF85, LD79) ----------------------------------------------
// A constraint no bad fixture notices can be deleted and every test stays green. The sweep
// deletes each one in turn. It does not descend into allOf, anyOf, oneOf, not, if, then or
// else, and leaves out the root's own type, which a fixture patch cannot replace.

const SWEPT = ['type', 'enum', 'const', 'minimum', 'minLength', 'maxLength', 'pattern', '$ref', 'items', 'additionalProperties'];

function constraintSites(schema) {
  const sites = [];
  const visit = (s, at) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    for (const k of SWEPT) if (k in s && !(k === 'type' && at.length === 0)) sites.push({ at, kind: k });
    (s.required || []).forEach((_, i) => sites.push({ at, kind: 'required', i }));
    for (const [n, sub] of Object.entries(s.properties || {})) visit(sub, [...at, 'properties', n]);
    for (const [n, sub] of Object.entries(s.definitions || {})) visit(sub, [...at, 'definitions', n]);
    if (s.items && typeof s.items === 'object') visit(s.items, [...at, 'items']);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') visit(s.additionalProperties, [...at, 'additionalProperties']);
  };
  visit(schema, []);
  return sites;
}

/** True when some fixture fails under `schema`: a good one invalid, or a bad one not rejected for its reason. */
function fixturesNotice(schema, { good, bad }) {
  const check = compile(schema);
  if (Object.values(good).some((r) => check(r).length)) return true;
  return !bad.every((c) => check(patch(good[c.from], c)).some((e) => e.path === c.error.path && e.keyword === c.error.keyword));
}

for (const f of FORMATS) {
  const schemaFile = path.join(SPEC, f.schema);
  const casesFile = path.join(CASES, f.cases);

  it(`${f.name}: the schema compiles with the in-house checker (only keywords it implements)`, () => {
    compile(load(schemaFile));
  });

  it(`${f.name}: every good fixture is valid`, () => {
    const check = compile(load(schemaFile));
    const { good } = load(casesFile);
    assert.ok(Object.keys(good).length > 0, 'no good fixtures');
    for (const [name, rec] of Object.entries(good)) {
      const errors = check(rec);
      assert.deepStrictEqual(errors, [], `${name}: ${JSON.stringify(errors)}`);
    }
  });

  it(`${f.name}: every bad fixture is rejected for its named reason, and its base is valid`, () => {
    const check = compile(load(schemaFile));
    const { good, bad } = load(casesFile);
    assert.ok(bad.length > 0, 'no bad fixtures');
    for (const c of bad) {
      assert.ok(good[c.from], `${c.name}: unknown base ${c.from}`);
      assert.deepStrictEqual(check(good[c.from]), [], `${c.name}: base ${c.from} is not valid`);
      const errors = check(patch(good[c.from], c));
      const hit = errors.some((e) => e.path === c.error.path && e.keyword === c.error.keyword);
      assert.ok(hit, `${c.name}: want ${JSON.stringify(c.error)}, got ${JSON.stringify(errors)}`);
    }
  });

  it(`${f.name}: every property in the schema carries its wording (description) and its source ($comment)`, () => {
    const missing = [];
    const visit = (s, where) => {
      if (!s || typeof s !== 'object') return;
      for (const [k, sub] of Object.entries(s.properties || {})) {
        const at = `${where}/${k}`;
        if (sub.$ref === undefined) {
          if (typeof sub.description !== 'string' || !sub.description) missing.push(`${at}: description`);
          if (typeof sub.$comment !== 'string' || !(sub.$comment.startsWith('brief v3 line') || sub.$comment.startsWith('brief v4 line') || sub.$comment.startsWith('agent'))) {
            missing.push(`${at}: $comment`);
          }
        }
        visit(sub, at);
      }
      for (const [k, sub] of Object.entries(s.definitions || {})) visit(sub, `${where}#${k}`);
    };
    visit(load(schemaFile), '');
    assert.deepStrictEqual(missing, []);
  });

  if (f.sweep) {
    it(`${f.name}: deleting any one constraint of the schema makes a fixture fail (NF85, LD79)`, () => {
      const schema = load(schemaFile);
      const cases = load(casesFile);
      const sites = constraintSites(schema);
      assert.ok(sites.length > 0, 'no constraints found');
      const unnoticed = [];
      for (const site of sites) {
        const s = JSON.parse(JSON.stringify(schema));
        let o = s;
        for (const k of site.at) o = o[k];
        unnoticed.push(`/${site.at.join('/')} ${site.kind}${site.kind === 'required' ? ' ' + o.required[site.i] : ''}`);
        if (site.kind === 'required') o.required.splice(site.i, 1);
        else delete o[site.kind];
        if (fixturesNotice(s, cases)) unnoticed.pop();
      }
      assert.deepStrictEqual(unnoticed, []);
    });
  }
}

it("the brief's own example mark (v4 lines 215-232), with its shortened hashes written out in full, is a valid mark", () => {
  const check = compile(load(path.join(SPEC, 'mark.schema.json')));
  const full = (h) => 'sha256:' + h.repeat(64 / h.length);
  const example = {
    schema_version: 1,
    session_id: 'ses_20261030_a1b2',
    seq: 1042,
    source: 'sentinel',
    agent: 'claude-code',
    turn: null,
    sub_agent: null,
    observed_at: '2026-10-30T09:21:04.310Z',
    mono_ns: '81234567890123',
    target: { kind: 'file', path: 'src/auth.ts' },
    says: 'modified',
    detail: { size: 4211, fingerprint: full('9f2c') },
    cause_hint: null,
    prev_hash: full('7ab1'),
    hash: full('c40e'),
  };
  assert.deepStrictEqual(check(example), []);
});

// --- the checker itself ----------------------------------------------------------

it('the checker refuses a schema keyword it does not implement, so a typo cannot validate nothing', () => {
  assert.throws(() => compile({ type: 'object', requird: ['a'] }), /requird/);
  assert.throws(() => compile({ properties: { a: { patern: '^x' } } }), /patern/);
  assert.throws(() => compile({ $ref: '#/definitions/nope' }), /nope/);
  assert.throws(() => compile({ $ref: 'other.json#/x' }), /other\.json/);
});

it('the checker: types, integers, null, enum, const', () => {
  const c = compile({ type: 'object', properties: { n: { type: 'integer' }, m: { type: ['string', 'null'] }, e: { enum: [1, 'a', null] }, k: { const: { a: [1] } } } });
  assert.deepStrictEqual(c({ n: 2, m: null, e: null, k: { a: [1] } }), []);
  assert.deepStrictEqual(c({ n: 2.5 }).map((e) => e.keyword), ['type']);
  assert.deepStrictEqual(c({ m: 3 }).map((e) => `${e.path} ${e.keyword}`), ['/m type']);
  assert.deepStrictEqual(c({ e: 2 }).map((e) => e.keyword), ['enum']);
  assert.deepStrictEqual(c({ k: { a: [2] } }).map((e) => e.keyword), ['const']);
  assert.deepStrictEqual(c([]).map((e) => e.keyword), ['type'], 'an array is not an object');
  assert.deepStrictEqual(c(null).map((e) => e.keyword), ['type'], 'null is not an object');
  assert.deepStrictEqual(compile({ type: 'number' })(Number.NaN).map((e) => e.keyword), ['type'], 'NaN is not a JSON number');
});

it('the checker: required, additionalProperties, items, strings and numbers', () => {
  const c = compile({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string', minLength: 2, maxLength: 3, pattern: '^a' }, n: { minimum: 0 }, l: { type: 'array', items: { type: 'integer' } } },
    additionalProperties: false,
  });
  assert.deepStrictEqual(c({ a: 'ab', n: 0, l: [1, 2] }), []);
  assert.deepStrictEqual(c({}).map((e) => `${e.path} ${e.keyword}`), ['/a required']);
  assert.deepStrictEqual(c({ a: 'a' }).map((e) => e.keyword), ['minLength']);
  assert.deepStrictEqual(c({ a: 'abcd' }).map((e) => e.keyword), ['maxLength']);
  assert.deepStrictEqual(c({ a: 'bb' }).map((e) => e.keyword), ['pattern']);
  assert.deepStrictEqual(c({ a: 'ab', n: -1 }).map((e) => e.keyword), ['minimum']);
  assert.deepStrictEqual(c({ a: 'ab', l: [1, 'x'] }).map((e) => `${e.path} ${e.keyword}`), ['/l/1 type']);
  assert.deepStrictEqual(c({ a: 'ab', z: 1 }).map((e) => `${e.path} ${e.keyword}`), ['/z additionalProperties']);
  const open = compile({ type: 'object', additionalProperties: { type: 'integer' } });
  assert.deepStrictEqual(open({ x: 1 }), []);
  assert.deepStrictEqual(open({ x: 'y' }).map((e) => `${e.path} ${e.keyword}`), ['/x type']);
  assert.deepStrictEqual(compile({ minLength: 2 })('\u{1F600}').map((e) => e.keyword), ['minLength'], 'length counts code points');
});

it('the checker: allOf, anyOf, oneOf, not, if/then/else and $ref', () => {
  const c = compile({
    definitions: { pos: { type: 'integer', minimum: 1 } },
    allOf: [{ if: { properties: { k: { const: 'a' } }, required: ['k'] }, then: { required: ['a'] }, else: { required: ['b'] } }],
    properties: { p: { $ref: '#/definitions/pos' }, x: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, o: { oneOf: [{ type: 'integer' }, { minimum: 0 }] }, n: { not: { const: 0 } } },
  });
  assert.deepStrictEqual(c({ k: 'a', a: 1 }), []);
  assert.deepStrictEqual(c({ k: 'a' }).map((e) => `${e.path} ${e.keyword}`), ['/a required']);
  assert.deepStrictEqual(c({ k: 'z' }).map((e) => `${e.path} ${e.keyword}`), ['/b required']);
  assert.deepStrictEqual(c({ b: 1, p: 0 }).map((e) => `${e.path} ${e.keyword}`), ['/p minimum']);
  assert.deepStrictEqual(c({ b: 1, x: true }).map((e) => e.keyword), ['anyOf']);
  assert.deepStrictEqual(c({ b: 1, o: 1 }).map((e) => e.keyword), ['oneOf'], 'both branches match');
  assert.deepStrictEqual(c({ b: 1, o: -1.5 }).map((e) => e.keyword), ['oneOf'], 'no branch matches');
  assert.deepStrictEqual(c({ b: 1, o: 2.5 }), []);
  assert.deepStrictEqual(c({ b: 1, n: 0 }).map((e) => `${e.path} ${e.keyword}`), ['/n not']);
  assert.ok(SUPPORTED.includes('if') && !SUPPORTED.includes('format'));
});

runAll('spec');
