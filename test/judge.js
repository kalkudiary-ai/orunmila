'use strict';

/**
 * test/judge.js — Babaláwo, the judge (Phase 6 slices BB2-BB4, LD269; brief v4 lines 642-686; guarantees 3, 4, 6, 7,
 * 8). The rules file and its loader (BB2, Q35), the verdict on each sealed odù (BB3) and the session verdict (BB4),
 * written as the verdict log (BB1's schemas). Odù logs are hand-built here (labelled so, brief line 761): each record
 * as the Ọpọ́n writes it, sealed into a real hash chain, with made-up paths.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');
const { seal } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');
const { compile } = require('../src/verify/schema');
const babalawo = require('../src/babalawo');
const { loadRules, DEFAULT_RULES } = require('../src/babalawo/rules');

const schemaOf = (f) => compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', f), 'utf8')));
const H = (c) => 'sha256:' + String(c).repeat(64).slice(0, 64);
const SID = 'ses_judge_test';
const ROOT_DIR = '/p/proj';
const HOOKS = '/p/proj/.claude/settings.json';
const header = (over = {}) => ({ session_id: SID, project_root: ROOT_DIR, hash: H('0'), frozen: { hook_settings: { [HOOKS]: H('1') } }, config: {}, ...over });

const SAW_NOTHING = { status: 'saw_nothing', mark_seqs: [] };
const NOT_DISK = { status: 'out_of_scope', scope: 'not_a_disk_event', mark_seqs: [] };
const saw = (seqs, says) => ({ status: 'saw', mark_seqs: seqs, says, slots: seqs.map((seq) => ({ seq })) });

let nextSeq = 1;
/** One odù as the Ọpọ́n writes it; `o` overrides any field. */
function odu(n, o = {}) {
  const seq = nextSeq++;
  return {
    schema_version: 1,
    record: 'odu',
    odu_id: `odu_${String(n).padStart(4, '0')}`,
    session_id: SID,
    parent_id: null,
    children: [],
    amends: null,
    continues: null,
    ceiling: false,
    state: 'sealed',
    target: { kind: 'file', path: `src/f${n}.ts` },
    action: 'modified',
    window: { first_seq: seq, last_seq: seq },
    witnesses: ['hook', 'sentinel'],
    witness_status: { glove: saw([seq], ['modified']), sentinel: saw([seq], ['modified']) },
    net_change: { before: H('a'), after: H('b'), changed: true },
    cause: { kind: 'agent_tool_call', ref: `toolu_${n}` },
    attribution: 'explained',
    confidence: 'high',
    conflicts: [],
    lease: { checked: false, inside: null },
    mark_seqs: [seq],
    ...o,
  };
}

/** The odù log's text: its header, then each odù sealed into the chain. */
function oduLog(odus, h = header()) {
  let prev = seal({ schema_version: 1, record: 'odu_header', seq: 0, session_id: SID, raw_header: h.hash }, null);
  const lines = [prev];
  odus.forEach((o) => {
    prev = seal({ ...o, seq: prev.seq + 1 }, prev.hash);
    lines.push(prev);
  });
  return lines.map((r) => canonicalize(r) + '\n').join('');
}

/** Judge a hand-built odù log; return the verdict records by odu_id and the session verdict. */
function judged(odus, { h = header(), rulesText } = {}) {
  const r = babalawo.judge({ header: h, oduText: oduLog(odus, h), rulesText });
  assert.strictEqual(r.ok, true, r.words);
  const recs = r.text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
  const by = new Map(recs.filter((x) => x.record === 'verdict').map((x) => [x.odu_id, x]));
  return { r, recs, by, session: recs[recs.length - 1] };
}
const id = (n) => `odu_${String(n).padStart(4, '0')}`;
const phantom = (n, confidence) =>
  odu(n, { target: { kind: 'claim' }, action: 'claimed', witnesses: ['agent_claim'], witness_status: { glove: saw([n], ['claimed']), sentinel: NOT_DISK }, net_change: undefined, cause: { kind: 'turn', ref: 't1' }, confidence, conflicts: [{ kind: 'phantom_claim', sources: ['agent_claim'], said: { agent_claim: ['claimed'] }, claim: 'file', hedged: false, why: 'no_event', path: 'config.ts', targets: [] }] });
const lawCheck = (n) => strip(odu(n, { target: { kind: 'claim' }, action: 'checked', witnesses: ['agent_claim', 'hook', 'law_gate'], witness_status: { glove: saw([n], ['claimed', 'ended']), sentinel: NOT_DISK }, net_change: undefined, cause: { kind: 'turn', ref: 't1' } }));
const strip = (o) => {
  const c = { ...o };
  delete c.net_change;
  return c;
};

// --- BB3: one verdict per sealed odù --------------------------------------------------------------------------------

it('test 19: a phantom claim at high confidence is a Violation, citing the odù, the rule and the marks', () => {
  const p = strip(phantom(1, 'high'));
  const { by } = judged([p, lawCheck(2)]);
  const v = by.get(id(1));
  assert.deepStrictEqual([v.verdict, v.rule, v.odu_id, v.mark_seqs], ['violation', 'R1', id(1), p.mark_seqs]);
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(v.odu_hash) && /^sha256:[0-9a-f]{64}$/.test(v.rules));
});

it('tests 38 and 73: a phantom claim below high confidence is Look at this, never Violation (line 657)', () => {
  for (const c of ['medium', 'low']) {
    const { by } = judged([strip(phantom(1, c)), lawCheck(2)]);
    assert.deepStrictEqual([by.get(id(1)).verdict, by.get(id(1)).rule], ['look_at_this', 'R1'], c);
  }
  const both = strip(phantom(1, 'medium'));
  both.conflicts = [...both.conflicts, { kind: 'concurrent_sessions', sources: ['agent_claim'], said: { agent_claim: ['claimed'] }, sessions: [SID, 'ses_other'] }];
  const v = judged([both, lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([v.verdict, v.rule, v.also], ['look_at_this', 'R1', ['R10']], 'test 38: the concurrent note beside it');
});

it('tests 20 and 67: a hand edit (unexplained, the Sentinel saw it, the Glove did not) is Look at this, never Violation', () => {
  const hand = odu(1, { witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([1], ['modified']) }, cause: null, attribution: 'unexplained' });
  const v = judged([hand, lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([v.verdict, v.rule, v.hidden], ['look_at_this', 'R6', false]);
  assert.deepStrictEqual(v.witness_status, hand.witness_status, 'the verdict copies what each witness recorded (line 684)');
  const refused = loadRules(DEFAULT_RULES.replace('R6 look_at_this', 'R6 violation'));
  assert.ok(!refused.ok && refused.errors.some((e) => e.includes('R6')), JSON.stringify(refused.errors));
});

it('test 3: a reverted change with no conflict is Clean and hidden; with a conflict it is not hidden (line 661)', () => {
  const back = odu(1, { net_change: { before: H('a'), after: H('a'), changed: false }, cause: null, attribution: 'unexplained' });
  const v = judged([back, lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([v.verdict, v.rule, v.hidden], ['clean', 'R0', true]);
  const withConflict = { ...back, conflicts: [{ kind: 'contradiction', sources: ['hook', 'sentinel'], said: { hook: ['created'], sentinel: ['deleted'] } }] };
  const w = judged([withConflict, lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([w.verdict, w.rule, w.hidden], ['look_at_this', 'R3', false]);
});

it('tests 5, 44, 71, 32, 37: silent change, unconfirmed, outcome missing, missed live, concurrent: each Look at this by its rule', () => {
  const c = (kind, extra = {}) => ({ kind, sources: ['hook'], said: { hook: ['modified'] }, ...extra });
  const cases = [
    ['silent_change', 'R2', { turns: ['t1'], claim_seqs: [9] }],
    ['unconfirmed_by_filesystem', 'R11', {}],
    ['outcome_missing', 'R15', { ref: 'toolu_1', why: null }],
    ['missed_live', 'R18', { marks: [9] }],
    ['unfingerprinted', 'R19', { entry: 'link', marks: [9] }],
    ['concurrent_sessions', 'R10', { sessions: [SID, 'ses_b'] }],
    ['contradiction', 'R3', {}],
  ];
  for (const [kind, rule, extra] of cases) {
    const v = judged([odu(1, { conflicts: [c(kind, extra)] }), lawCheck(2)]).by.get(id(1));
    assert.deepStrictEqual([v.verdict, v.rule], ['look_at_this', rule], kind);
  }
  const unknown = judged([odu(1, { conflicts: [c('a_kind_this_judge_does_not_know')] }), lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([unknown.verdict, unknown.rule], ['look_at_this', 'R24'], 'a conflict the judge does not know is never silent (guarantee 7)');
});

it('tests 9 and 70: a byproduct and a mark that changes nothing on disk are Clean; only the second is hidden', () => {
  const build = odu(1, { target: { kind: 'file', path: 'dist/a.js' }, cause: { kind: 'byproduct', ref: 'dist/' }, attribution: 'byproduct' });
  const read = strip(odu(2, { action: 'read', witness_status: { glove: saw([2], ['started', 'read']), sentinel: NOT_DISK } }));
  const { by } = judged([build, read, lawCheck(3)]);
  assert.deepStrictEqual([by.get(id(1)).verdict, by.get(id(1)).hidden], ['clean', false]);
  assert.deepStrictEqual([by.get(id(2)).verdict, by.get(id(2)).hidden], ['clean', true]);
});

it('line 651: low confidence on any event is Look at this', () => {
  const v = judged([odu(1, { confidence: 'low' }), lawCheck(2)]).by.get(id(1));
  assert.deepStrictEqual([v.verdict, v.rule], ['look_at_this', 'R20']);
});

it('tests 10, 30, 42, 52 and Q37: every tampering mark is a Violation whoever made it, by its rule (line 658)', () => {
  const t = (n, target) => strip(odu(n, { target, action: 'tampered', witnesses: ['process'], witness_status: { glove: SAW_NOTHING, sentinel: NOT_DISK }, cause: null, attribution: 'unexplained' }));
  const { by } = judged([
    t(1, { kind: 'file', path: '.orunmila/byproducts' }),
    t(2, { kind: 'file', path: '.claude/settings.json' }),
    t(3, { kind: 'dir', path: '/opt/orunmila/src', outside: true }),
    t(4, { kind: 'process' }),
    t(5, { kind: 'file', path: '.orunmila/notes.txt' }),
    t(6, { kind: 'file', path: '/opt/orunmila/src/laws/packs/canon.json', outside: true }),
    lawCheck(7),
  ]);
  const got = [1, 2, 3, 4, 5, 6].map((n) => [by.get(id(n)).verdict, by.get(id(n)).rule]);
  assert.deepStrictEqual(got, [
    ['violation', 'R8'],
    ['violation', 'R12'],
    ['violation', 'R16'],
    ['violation', 'R17'],
    ['violation', 'R4'],
    ['violation', 'R8'],
  ]);
});

it('line 660: a parent takes the most serious of its own and its children, names the child that raised it, and every child is judged', () => {
  const parent = odu(1, { target: { kind: 'command', text: 'npm install' }, action: 'exited', net_change: undefined, children: [id(2), id(3)], witness_status: { glove: saw([1], ['started', 'exited']), sentinel: NOT_DISK } });
  const kid = (n, over) => odu(n, { parent_id: id(1), witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([n], ['created']) }, action: 'created', cause: { kind: 'agent_command', ref: 'toolu_1' }, ...over });
  const { by } = judged([kid(2, {}), kid(3, { cause: null, attribution: 'unexplained' }), strip(parent), lawCheck(4)]);
  const p = by.get(id(1));
  assert.deepStrictEqual([p.verdict, p.rule, p.opened], ['look_at_this', 'R6', [id(3)]]);
  assert.deepStrictEqual([by.get(id(2)).verdict, by.get(id(3)).verdict], ['clean', 'look_at_this']);
});

it('only sealed odùs are judged (line 644); a broken odù log is refused, never judged (guarantee 7)', () => {
  const r = babalawo.judge({ header: header(), oduText: oduLog([odu(1), lawCheck(2)]).replace('"modified"', '"created"') });
  assert.strictEqual(r.ok, false);
  assert.ok(/odù log/.test(r.words), r.words);
  const open = { ...odu(1), state: 'settled' };
  const { by } = judged([open, lawCheck(2)]);
  assert.strictEqual(by.has(id(1)), false, 'an odù not sealed gets no verdict');
});

// --- BB4: the session verdict ---------------------------------------------------------------------------------------

it('tests 21, 32: any gap makes the session Incomplete, whatever its events, naming the gap odùs (lines 674, 686)', () => {
  const gap = strip(odu(2, { target: null, action: 'gap', witnesses: ['process'], witness_status: { glove: { status: 'down', mark_seqs: [] }, sentinel: NOT_DISK }, cause: null, attribution: 'unexplained' }));
  const { by, session } = judged([odu(1), gap, lawCheck(3)]);
  assert.deepStrictEqual([by.get(id(2)).verdict, by.get(id(2)).rule], ['look_at_this', 'R9'], 'the gap is its own finding');
  assert.strictEqual(session.verdict, 'incomplete');
  assert.deepStrictEqual(session.reasons, [{ reason: 'gap', rule: 'R9', odu_ids: [id(2)] }]);
});

it('test 51: law-gate checks and no lost evidence: not Incomplete; the session takes its most serious event', () => {
  assert.strictEqual(judged([odu(1), lawCheck(2)]).session.verdict, 'clean');
  assert.strictEqual(judged([odu(1, { conflicts: [{ kind: 'silent_change', sources: ['hook'], said: { hook: ['modified'] }, turns: ['t1'], claim_seqs: [2] }] }), lawCheck(2)]).session.verdict, 'look_at_this');
  assert.strictEqual(judged([strip(phantom(1, 'high')), lawCheck(2)]).session.verdict, 'violation');
});

it('line 678: hooks recorded but no law-gate mark at all: the law gate is silent, Incomplete', () => {
  const { session } = judged([odu(1)]);
  assert.deepStrictEqual([session.verdict, session.reasons], ['incomplete', [{ reason: 'law_gate_silent', rule: 'R13', odu_ids: [] }]]);
});

it('test 72, line 679: the Sentinel saw changes inside the project and the Glove recorded nothing: the Glove is silent, Incomplete', () => {
  const s = (n) => odu(n, { witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([n], ['modified']) }, cause: null, attribution: 'unexplained' });
  const outside = odu(3, { target: { kind: 'file', path: '/tmp/x', outside: true }, witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([3], ['modified']) }, cause: null, attribution: 'unexplained' });
  const { session } = judged([s(1), s(2), outside]);
  assert.strictEqual(session.verdict, 'incomplete');
  assert.deepStrictEqual(session.reasons, [{ reason: 'glove_silent', rule: 'R14', odu_ids: [id(1), id(2)] }]);
});

it('the session verdict counts each verdict and the hidden ones, names what it judged up to, and its records match the schemas', () => {
  const read = strip(odu(2, { action: 'read', witness_status: { glove: saw([2], ['read']), sentinel: NOT_DISK } }));
  const list = [odu(1), read, lawCheck(3)];
  const { recs, session } = judged(list);
  assert.deepStrictEqual(session.counts, { clean: 3, look_at_this: 0, violation: 0, hidden: 2 });
  const odus = oduLog(list).split('\n').slice(0, -1).map((l) => JSON.parse(l));
  assert.deepStrictEqual(session.judged, { seq: odus[odus.length - 1].seq, hash: odus[odus.length - 1].hash });
  assert.deepStrictEqual([session.judge, session.rules_source, session.supersedes], [{ name: 'babalawo', version: babalawo.version }, 'default', null]);
  const [head, ...rest] = recs;
  assert.deepStrictEqual(schemaOf('verdict-header.schema.json')(head), []);
  assert.strictEqual(head.odu_header, odus[0].hash);
  const checkV = schemaOf('verdict.schema.json');
  for (const v of rest.slice(0, -1)) assert.deepStrictEqual(checkV(v), [], v.verdict_id);
  assert.deepStrictEqual(schemaOf('session-verdict.schema.json')(session), []);
  assert.deepStrictEqual(rest.map((x) => x.verdict_id), ['v_0001', 'v_0002', 'v_0003', 'v_0004']);
});

it('test 22, guarantee 3: the same odù log and rules judged twice give byte-identical verdict logs', () => {
  const odus = [odu(1), strip(phantom(2, 'high')), lawCheck(3)];
  const a = babalawo.judge({ header: header(), oduText: oduLog(odus) });
  const b = babalawo.judge({ header: header(), oduText: oduLog(odus) });
  assert.strictEqual(a.text, b.text);
  const { verifyText } = require('../src/verify/chain');
  assert.deepStrictEqual(verifyText(a.text), { ok: true, lines: 5 }, 'the verdict log is hash-chained (guarantee 4)');
});

it('line 684: a re-judgement with other rules appends verdicts that supersede the old, never edits them, and writes nothing that did not change', () => {
  const hand = odu(1, { witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([1], ['modified']) }, cause: null, attribution: 'unexplained' });
  const list = [hand, odu(2), lawCheck(3)];
  const text = oduLog(list);
  const first = babalawo.judge({ header: header(), oduText: text });
  const again = babalawo.judge({ header: header(), oduText: text, prior: first.records });
  assert.deepStrictEqual([again.ok, again.added, again.text], [true, [], first.text], 'the same rules again: nothing to add');
  const off = DEFAULT_RULES.replace('R6 look_at_this', 'R6 off');
  const re = babalawo.judge({ header: header(), oduText: text, prior: first.records, rulesText: off });
  assert.ok(re.text.startsWith(first.text), 'the old lines are untouched');
  const kinds = re.added.map((r) => [r.record, r.odu_id || null, r.verdict, r.supersedes]);
  const old = new Map(first.records.filter((r) => r.verdict_id).map((r) => [r.odu_id || 'session', r.verdict_id]));
  assert.deepStrictEqual(kinds, [
    ['verdict', id(1), 'clean', old.get(id(1))],
    ['verdict', id(2), 'clean', old.get(id(2))],
    ['verdict', id(3), 'clean', old.get(id(3))],
    ['session_verdict', null, 'clean', old.get('session')],
  ]);
  assert.strictEqual(require('../src/verify/chain').verifyText(re.text).ok, true);
  const other = babalawo.judge({ header: header(), oduText: oduLog([odu(9), lawCheck(10)]), prior: first.records });
  assert.strictEqual(other.ok, false, 'a verdict log is never continued onto another odù log');
});

// --- BB2: the rules file --------------------------------------------------------------------------------------------

it('Q35: the default rules load, and every line of them names a rule the judge knows', () => {
  const r = loadRules(DEFAULT_RULES);
  assert.deepStrictEqual([r.ok, r.errors], [true, []]);
  assert.strictEqual(r.fingerprint, 'sha256:' + require('crypto').createHash('sha256').update(DEFAULT_RULES, 'utf8').digest('hex'));
});

it('Q35: an unknown word, an unknown rule, a guarding rule changed, or a "never" limit crossed is refused by name', () => {
  const bad = (line, words) => {
    const r = loadRules(`${DEFAULT_RULES}${line}\n`);
    assert.ok(!r.ok && r.errors.some((e) => e.includes(words)), `${line}: ${JSON.stringify(r.errors)}`);
  };
  bad('R6 maybe', 'maybe');
  bad('R99 look_at_this', 'R99');
  bad('frobnicate R1', 'frobnicate');
  bad('R9 off', 'R9');
  bad('R13 look_at_this', 'R13');
  bad('R12 off', 'R12');
  bad('R2 violation', 'R2');
  bad('R10 off', 'R10');
  bad('R10 violation', 'R10');
  bad('protect', 'protect');
});

it('Q35: a rules file in the session header judges the session, not a newer file (lines 283, 658, 669); R6 off makes a hand edit Clean', () => {
  const hand = odu(1, { witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([1], ['modified']) }, cause: null, attribution: 'unexplained' });
  const text = DEFAULT_RULES.replace('R6 look_at_this', 'R6 off');
  const h = header({ config: { rules: text } });
  const { by, session } = judged([hand, lawCheck(2)], { h });
  assert.deepStrictEqual([by.get(id(1)).verdict, session.rules_source, session.rules], ['clean', 'header', loadRules(text).fingerprint]);
  const refused = babalawo.judge({ header: header({ config: { rules: 'R6 sometimes\n' } }), oduText: oduLog([hand, lawCheck(2)]) });
  assert.strictEqual(refused.ok, false, 'a rules file the judge cannot read is never judged by in silence (guarantee 7)');
  assert.ok(refused.words.includes('sometimes'), refused.words);
});

it('Q35, line 672: a protected path touched by the agent at high confidence is a Violation; when the cause is unknown, Look at this', () => {
  const text = `${DEFAULT_RULES}protect .env\nprotect secrets/\n`;
  const agent = odu(1, { target: { kind: 'file', path: '.env' } });
  const human = odu(2, { target: { kind: 'file', path: 'secrets/k.pem' }, witnesses: ['sentinel'], witness_status: { glove: SAW_NOTHING, sentinel: saw([2], ['modified']) }, cause: null, attribution: 'unexplained' });
  const other = odu(3, { target: { kind: 'file', path: 'src/env.ts' } });
  const { by } = judged([agent, human, other, lawCheck(4)], { rulesText: text });
  assert.deepStrictEqual([by.get(id(1)).verdict, by.get(id(1)).rule], ['violation', 'R7']);
  // Two rules giving the same verdict: the lower number decides, the other is in `also`.
  assert.deepStrictEqual([by.get(id(2)).verdict, by.get(id(2)).rule, by.get(id(2)).also], ['look_at_this', 'R6', ['R7']]);
  assert.strictEqual(by.get(id(3)).verdict, 'clean');
  assert.strictEqual(judged([agent, lawCheck(4)], { rulesText: text }).session.rules_source, 'file');
});

it('the judge is plain code: no clock, no file system, no network, no model in src/babalawo (guarantee 8, line 656)', () => {
  const dir = path.join(ROOT, 'src', 'babalawo');
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(dir);
  assert.ok(files.length >= 3, files.join(', '));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const mods = [...t.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const m of mods) assert.ok(!['fs', 'http', 'https', 'net', 'child_process', 'os'].includes(m.replace(/^node:/, '')), `${path.relative(ROOT, f)} loads ${m}`);
    assert.ok(!/\bDate\b|\bperformance\.now\b|\bprocess\.hrtime\b|Math\.random/.test(t), `${path.relative(ROOT, f)} reads a clock or chance`);
  }
});

runAll('judge');
