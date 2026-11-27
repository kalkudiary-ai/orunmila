// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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
const { compile, closed, SUPPORTED } = require('../src/verify/schema');

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
  { name: 'mark', schema: 'mark.schema.json', cases: 'marks.json', sweep: true },
  { name: 'session header', schema: 'session-header.schema.json', cases: 'session-headers.json', sweep: true },
  { name: 'continuation', schema: 'continuation.schema.json', cases: 'continuations.json', sweep: true },
  { name: 'retention header', schema: 'retention-header.schema.json', cases: 'retention-headers.json', sweep: true },
  { name: 'retention removal', schema: 'retention-removal.schema.json', cases: 'retention-removals.json', sweep: true },
  { name: 'baseline entry', schema: 'baseline.schema.json', cases: 'baseline-entries.json', sweep: true },
  { name: 'session footer', schema: 'session-footer.schema.json', cases: 'session-footers.json', sweep: true },
  // BB1 (Q34, LD262; brief v4 lines 659, 684, 686): the verdict log's three records.
  { name: 'verdict header', schema: 'verdict-header.schema.json', cases: 'verdict-headers.json', sweep: true },
  { name: 'verdict', schema: 'verdict.schema.json', cases: 'verdicts.json', sweep: true },
  { name: 'session verdict', schema: 'session-verdict.schema.json', cases: 'session-verdicts.json', sweep: true },
  // PM2a (Q44 (a), LD299, LD329): the update log's two records.
  { name: 'update log header', schema: 'updates-header.schema.json', cases: 'updates-headers.json', sweep: true },
  { name: 'update', schema: 'update.schema.json', cases: 'updates.json', sweep: true },
  // SP1b (Phase 7, test 27): the quarantine log's two records, written since Phase 1 and published here.
  { name: 'quarantine header', schema: 'quarantine-header.schema.json', cases: 'quarantine-headers.json', sweep: true },
  { name: 'quarantined', schema: 'quarantine.schema.json', cases: 'quarantined.json', sweep: true },
];

// --- the deletion sweep (NF85, LD79) ----------------------------------------------
// A constraint no bad fixture notices can be deleted and every test stays green. The sweep
// deletes each one in turn, inside allOf, anyOf, oneOf, not, if, then and else too (LD83), and
// leaves out the root's own type, which a fixture patch cannot replace.

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
    for (const k of ['not', 'if', 'then', 'else']) if (s[k] && typeof s[k] === 'object') visit(s[k], [...at, k]);
    for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(s[k])) s[k].forEach((sub, i) => visit(sub, [...at, k, i]));
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
      const used = new Set();
      JSON.stringify(schema, (k, v) => (used.add(k), v));
      for (const k of ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']) if (used.has(k)) assert.ok(sites.some((s) => s.at.includes(k)), `the sweep reaches inside ${k}`);
      const unnoticed = [];
      for (const site of sites) {
        const s = JSON.parse(JSON.stringify(schema));
        let o = s;
        for (const k of site.at) o = o[k];
        const label = `/${site.at.join('/')} ${site.kind}${site.kind === 'required' ? ' ' + o.required[site.i] : ''}`;
        if (site.kind === 'required') o.required.splice(site.i, 1);
        else delete o[site.kind];
        if (!fixturesNotice(s, cases)) unnoticed.push(label);
      }
      assert.deepStrictEqual(unnoticed, []);
    });
  }
}

it('LD85: every good fixture of every format names only fields its schema declares, and the closed check catches a planted one', () => {
  for (const f of FORMATS) {
    const schema = load(path.join(SPEC, f.schema));
    const check = compile(closed(schema));
    const { good } = load(path.join(CASES, f.cases));
    for (const [name, rec] of Object.entries(good)) assert.deepStrictEqual(check(rec), [], `${f.name} ${name}`);
    const [first] = Object.values(good);
    assert.deepStrictEqual(check({ ...first, colour: 'x' }).map((e) => `${e.path} ${e.keyword}`), ['/colour additionalProperties'], f.name);
    assert.deepStrictEqual(compile(schema)({ ...first, colour: 'x' }), [], `${f.name}: the schema itself stays open (brief v3 line 209)`);
  }
});

it('LD85: every mark the A8 adapter writes, of every kind it translates, names only fields the mark schema declares', () => {
  const { translateEvents } = require('../src/opon/intake/adapters/events-v0');
  const check = compile(closed(load(path.join(SPEC, 'mark.schema.json'))));
  const c = { ts: '2026-11-16T09:00:00.000Z', session_id: 's', turn_id: 't1', agent: 'claude-code', source: 'hook', failed: false, call_id: 'c1' };
  const events = [
    { ...c, type: 'command_run', command: 'npm test', exit_code: null, stdout_excerpt: 'ok', output_path: null },
    { ...c, call_id: 'c2', type: 'file_write', path: 'a.js', diff: '' },
    { ...c, call_id: 'c3', type: 'file_read', path: 'a.js', hash: 'a'.repeat(64), bytes: 3, read_kind: 'full' },
    { ...c, call_id: 'c4', type: 'file_read', path: 'x', read_kind: 'pattern' },
    { ...c, call_id: 'c8', type: 'file_read', path: 'a.js', hash: 'a'.repeat(64), bytes: 3, read_kind: 'range', read_range: { asked_offset: 1, asked_limit: 2, start_line: 1, lines: 2, total_lines: 9, truncated_by_token_cap: true } },
    { ...c, call_id: 'c9', agent: 'cursor', type: 'file_read', path: 'src', hash: null, bytes: null, read_kind: 'listing' },
    { ...c, call_id: 'c10', type: 'command_run', command: 'false', exit_code: 2, failed: true, stdout_excerpt: '', output_path: null },
    { ...c, call_id: 'c5', type: 'tool_call', tool_name: 'Task', input: {}, result_excerpt: 'r', result_bytes: 1 },
    { ...c, call_id: 'c6', type: 'network_call', tool_name: 'WebFetch', host: 'h.example', target: 'https://h.example/' },
    { ...c, call_id: 'c7', type: 'file_write', path: 'b.js', failed: true },
    { ...c, type: 'user_prompt', text: 'go' },
    { ...c, type: 'turn_claim', text: '', claim_unconfirmed: true },
    { ...c, type: 'turn_end' },
    { ...c, type: 'git_state', branch: 'main', head_sha: 'b'.repeat(40) },
    { ts: '2026-11-16T09:00:01.000Z', session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: '/w/a.js', rel_path: 'a.js', change_kind: 'modify', hash_before: 'c'.repeat(64), hash_after: 'd'.repeat(64), binary: false, diff: '-a\n+b\n', failed: false },
  ];
  const { marks, rejects } = translateEvents(events, { sessionId: 's' });
  assert.deepStrictEqual(rejects, []);
  assert.strictEqual(marks.length, events.length - 1, 'the git record joins its command');
  const sealed = (m) => ({ ...m, seq: 1, mono_ns: '1', prev_hash: 'sha256:' + '0'.repeat(64), hash: 'sha256:' + '0'.repeat(64) });
  for (const { mark } of marks) assert.deepStrictEqual(check(sealed(mark)), [], `${mark.source} ${mark.says}`);
});

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

it('DOC3 (LD340): spec/README.md lists every file in spec/ in its table, and no longer says nothing reads them or that they do not ship', () => {
  const readme = fs.readFileSync(path.join(SPEC, 'README.md'), 'utf8');
  const files = fs.readdirSync(SPEC).filter((f) => f !== 'README.md').sort();
  const missing = files.filter((f) => !readme.includes('| `' + f + '` |'));
  assert.deepStrictEqual(missing, [], 'each spec file has its row');
  for (const stale of ['Nothing writes or reads these formats yet', 'The verdict record comes later', 'is not in the npm package yet']) assert.ok(!readme.includes(stale), stale);
});

// SP1 (Phase 7; brief v4 lines 703-709): the spec as a standalone document a developer who has never seen Orunmila's
// code could implement from: v1, not a draft; every field in plain words; the versioning rule; openly licensed and
// marked as staying open in every future version.
it('SP1: spec/FIELDS.md is exactly what scripts/spec-fields.js makes from the schemas, so it cannot drift from them', () => {
  const { fieldsMarkdown } = require('../scripts/spec-fields');
  const file = path.join(SPEC, 'FIELDS.md');
  assert.ok(fs.existsSync(file), 'spec/FIELDS.md');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), fieldsMarkdown(SPEC));
});

it('SP1: every property of every schema, at every depth, in shared shapes and in conditional rules, has its row in FIELDS.md with its wording', () => {
  const { fieldsMarkdown } = require('../scripts/spec-fields');
  // This walk is the test's own, not the generator's: a field the generator missed is missed here only if both miss it.
  // A path is the property names from the schema's root (`a.b`), `[]` for a list's items, a shared shape by its name.
  // Properties inside `if` and `not` are conditions, not fields; one with no wording restates a field described elsewhere.
  function each(node, prefix, out) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [name, sub] of Object.entries(node.properties || {})) {
      const p = prefix ? `${prefix}.${name}` : name;
      out.push({ p, d: sub && sub.description });
      each(sub, p, out);
    }
    if (node.items) each(node.items, `${prefix}[]`, out);
    for (const [name, sub] of Object.entries(node.definitions || {})) each(sub, name, out);
    for (const k of ['allOf', 'anyOf', 'oneOf']) for (const sub of node[k] || []) each(sub, prefix, out);
    for (const k of ['then', 'else']) each(node[k], prefix, out);
  }
  let described = 0;
  let restated = 0;
  for (const f of fs.readdirSync(SPEC).filter((x) => x.endsWith('.schema.json')).sort()) {
    const md = fieldsMarkdown(SPEC).split('\n## ').find((s) => s.includes(`(\`${f}\`)`));
    assert.ok(md, `${f} has its section`);
    const out = [];
    each(load(path.join(SPEC, f)), '', out);
    for (const { p, d } of out) {
      assert.ok(md.includes(`| \`${p}\` |`), `${f}: ${p} has a row`);
      if (d) {
        described++;
        assert.ok(md.includes(d.replace(/\n/g, ' ').replace(/\|/g, '\\|')), `${f}: ${p} has its wording`);
      } else restated++;
    }
  }
  assert.ok(described >= 300, `${described} described properties, ${restated} restated`);
});

it('SP1: the spec is v1, not a draft: no title, heading or status in spec/ says draft', () => {
  for (const f of fs.readdirSync(SPEC).sort()) {
    const text = fs.readFileSync(path.join(SPEC, f), 'utf8');
    if (f.endsWith('.schema.json')) assert.ok(!/draft/i.test(load(path.join(SPEC, f)).title), `${f} title`);
    else assert.ok(!/\(draft\)|Status: draft/i.test(text), f);
  }
});

it('SP1: the README states the versioning rule, the licence of the text, and that the formats stay open in every future version', () => {
  const readme = fs.readFileSync(path.join(SPEC, 'README.md'), 'utf8');
  for (const line of [
    'Fields may be added in a later version of a format; a field is never renamed, removed or given another meaning without a new `schema_version`.',
    'The text of this specification and its schema files are licensed under the Apache License 2.0, like the code (`LICENSE` at the repository root).',
    'These formats and the verifier stay open in every future version of Orunmila: never paid, gated or closed.',
  ]) assert.ok(readme.includes(line), line);
  assert.ok(readme.includes('| `FIELDS.md` |') && readme.includes('`hash-chain.md`'), 'the reading order names FIELDS.md and hash-chain.md');
});

it('SP2 test 27: a session record a developer wrote from spec/ alone is intact by verify, and one changed byte breaks it', () => {
  const { verifySession } = require('../src/verify/session');
  const { tmpDir, rmrf } = require('./helpers');
  const src = path.join(CASES, 'hand-written', 'ses_handwritten_1');
  const v = verifySession(src);
  assert.strictEqual(v.ok, true, v.words);
  assert.strictEqual(v.words, 'Record intact: 7 marks, 1 quarantined input, 1 kept file, unbroken; the baseline snapshot of 2 entries matches the header.');
  const copy = path.join(tmpDir(), 'ses_handwritten_1');
  try {
    fs.cpSync(src, copy, { recursive: true });
    const raw = path.join(copy, 'raw.jsonl');
    fs.writeFileSync(raw, fs.readFileSync(raw, 'utf8').replace('"Helo\\" is now', '"Helx\\" is now'));
    assert.strictEqual(verifySession(copy).words, 'Record broken at line 7 of the raw log: this line was changed after it was written.');
  } finally {
    rmrf(path.dirname(copy));
  }
});

runAll('spec');
