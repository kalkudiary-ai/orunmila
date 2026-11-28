// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/judge-swap.js — the swappable judge (Phase 6 slice BB11; brief v4 lines 127, 682; plan section 10). The judge is
 * read through one interface, chosen by name: a stricter judge plugged in by name gives its own verdicts at the closeout
 * with no file under src/opon/ changed, and nothing under src/opon/ reaches src/babalawo/ except through that
 * interface, at its two calls (the closeout and replay). Hand-built payloads in throwaway folders (brief line 761).
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll, slash } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const iface = require('../src/babalawo/interface');
const babalawo = require('../src/babalawo');
const { seal } = require('../src/verify/chain');
const { canonicalize } = require('../src/verify/canonical');

/** A stricter judge for the test: babalawo's verdicts, every Look at this made a Violation, under its own name. */
const strict = {
  name: 'strict',
  version: '0.1.0',
  loadRules: babalawo.loadRules,
  judge(input) {
    const r = babalawo.judge(input);
    if (!r.ok) return r;
    let prev = null;
    const records = r.records.map((x) => {
      const y = { ...x };
      if (y.record === 'verdict_header' || y.record === 'session_verdict') y.judge = { name: 'strict', version: '0.1.0' };
      if (y.verdict === 'look_at_this') y.verdict = 'violation';
      prev = seal(y, prev ? prev.hash : null);
      return prev;
    });
    return { ok: true, records, added: records, text: records.map((x) => canonicalize(x) + '\n').join('') };
  },
};

function closeOut(base, judge) {
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  let mono = 5000n * 1000000n;
  const clock = () => ({ mono: mono.toString(), wall: new Date(Date.UTC(2026, 10, 24) + Number(mono / 1000000n)).toISOString() });
  const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(ROOT, 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], baseline: true, judge });
  const b = { session_id: 'ses_swap', transcript_path: '/tmp/t.jsonl', cwd: project };
  const send = (x) => router.payload({ ...b, ...x }, { channel: 'command' });
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  fs.writeFileSync(path.join(project, 'src', 'hand.js'), 'by hand\n');
  send({ hook_event_name: 'Stop', last_assistant_message: 'Nothing to do.' });
  send({ hook_event_name: 'SessionEnd', reason: 'exit' });
  for (let i = 0; i < 20; i++) {
    mono += 500n * 1000000n;
    router.poll();
  }
  const dir = path.join(home, 'sessions', 'ses_swap');
  const file = path.join(dir, 'verdict.jsonl');
  return { dir, recs: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : null, errors: fs.existsSync(path.join(home, 'intake', 'errors.jsonl')) ? fs.readFileSync(path.join(home, 'intake', 'errors.jsonl'), 'utf8') : '' };
}

it('BB11: a stricter judge, registered and named, writes its own verdicts at the closeout; the default judge is babalawo', () => {
  iface.register(strict);
  const base = tmpDir();
  try {
    const mine = closeOut(path.join(base, 'a'), 'strict');
    assert.ok(mine.recs, mine.errors);
    assert.deepStrictEqual(mine.recs[0].judge, { name: 'strict', version: '0.1.0' });
    assert.ok(mine.recs.some((r) => r.verdict === 'violation') && !mine.recs.some((r) => r.verdict === 'look_at_this'), JSON.stringify(mine.recs.map((r) => r.verdict)));
    const plain = closeOut(path.join(base, 'b'), true);
    assert.deepStrictEqual(plain.recs[0].judge, { name: 'babalawo', version: babalawo.version });
    assert.ok(plain.recs.some((r) => r.verdict === 'look_at_this'), 'the default judge says Look at this where the strict one says Violation');
  } finally {
    rmrf(base);
  }
});

it('BB11: a judge named but not registered writes no verdict log, and the error log says why (guarantee 7)', () => {
  const base = tmpDir();
  try {
    const r = closeOut(base, 'nobody');
    assert.strictEqual(r.recs, null);
    const reasons = r.errors.split('\n').filter(Boolean).map((l) => JSON.parse(l).reason);
    assert.ok(reasons.some((x) => x.startsWith('no judge named "nobody" is registered')), r.errors);
  } finally {
    rmrf(base);
  }
});

it('BB11: the interface refuses a judge that does not have its shape', () => {
  assert.throws(() => iface.register({ name: 'x', version: '1' }), /judge/);
  assert.throws(() => iface.register({ ...strict, name: '' }), /name/);
  assert.throws(() => iface.register({ ...strict, name: 'babalawo' }), /babalawo/, 'the default judge cannot be replaced under its own name');
  assert.strictEqual(iface.get('babalawo').judge, babalawo.judge);
});

it('BB11, line 682: nothing under src/opon/ reaches src/babalawo/ except through the interface, at the closeout and in replay', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name))));
  walk(path.join(ROOT, 'src', 'opon'));
  const reach = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (target.startsWith(path.join(ROOT, 'src', 'babalawo'))) reach.push(`${slash(path.relative(ROOT, f))} -> ${slash(path.relative(ROOT, target))}`);
    }
  }
  assert.deepStrictEqual(reach.sort(), ['src/opon/intake/live.js -> src/babalawo/interface', 'src/opon/replay/index.js -> src/babalawo/interface']);
});

runAll('judge-swap');
