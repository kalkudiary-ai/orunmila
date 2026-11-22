'use strict';

/**
 * test/turbo.js — scripts/turbo/, the TURBO harness: an outer driver that runs
 * Leopard slice by slice in fresh headless sessions, queues what needs O, and
 * works around it (LD108-LD112).
 *
 * No real session data: every case builds its own plan, repo or fake `claude`.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');

const plan = require('../scripts/turbo/plan');

// --- T1: the plan -------------------------------------------------------------

const S = (id, extra = {}) => ({ id, title: `slice ${id}`, phase: '2', test: `node test/${id}.js`, ...extra });

function planOf(...slices) {
  const p = plan.empty();
  for (const s of slices) plan.addSlice(p, s);
  return p;
}

it('plan: next() takes the first todo slice in list order', () => {
  const p = planOf(S('a'), S('b'));
  assert.strictEqual(plan.next(p).id, 'a');
  plan.setStatus(p, 'a', 'done');
  assert.strictEqual(plan.next(p).id, 'b');
  plan.setStatus(p, 'b', 'done');
  assert.strictEqual(plan.next(p), null);
});

it('plan: a slice waits for its depends_on, and a later independent slice goes first', () => {
  const p = planOf(S('a'), S('b', { depends_on: ['a'] }), S('c'));
  plan.queueItem(p, { slice: 'a', kind: 'merge-to-main', title: 'merge', ask: 'may I merge?' });
  // a is blocked by an open item, b depends on a, so c is the work around it.
  assert.strictEqual(plan.next(p).id, 'c');
});

it('plan: a blocking queue item blocks its slice until answered; answering unblocks it', () => {
  const p = planOf(S('a'), S('b'));
  const q = plan.queueItem(p, { slice: 'a', kind: 'push', title: 'push', ask: 'push?' });
  assert.strictEqual(q, 'Q1');
  assert.strictEqual(plan.next(p).id, 'b');
  plan.setStatus(p, 'b', 'done');
  assert.strictEqual(plan.next(p), null, 'only a blocked slice is left');
  assert.deepStrictEqual(plan.counts(p), { todo: 1, eligible: 0, blocked: 1, done: 1, dropped: 0, open_items: 1 });
  plan.answer(p, 'Q1', 'yes, push');
  assert.strictEqual(plan.next(p).id, 'a');
  assert.strictEqual(p.queue[0].status, 'answered');
  assert.strictEqual(p.queue[0].answer, 'yes, push');
});

it('plan: a non-blocking item (a phase report) blocks nothing, but marks later phases provisional', () => {
  const p = planOf(S('close2', { phase: '2', kind: 'closeout' }), S('x', { phase: '3' }), S('y', { phase: '2' }));
  plan.setStatus(p, 'close2', 'done');
  const q = plan.queueItem(p, { slice: 'close2', kind: 'phase-report', title: 'Phase 2 report', ask: 'go ahead?', blocking: false, phase: '2' });
  assert.strictEqual(plan.next(p).id, 'x');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'x')), q, 'phase 3 work rests on the unanswered phase 2 report');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'y')), null, 'same-phase work is not provisional');
  plan.answer(p, q, 'go');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'x')), null);
});

it('plan: validate() names duplicate ids, unknown dependencies, unknown items and bad statuses', () => {
  const p = plan.empty();
  p.slices.push({ id: 'a', status: 'todo', depends_on: ['nope'], blocked_by: ['Q9'] }, { id: 'a', status: 'weird', depends_on: [], blocked_by: [] });
  const errs = plan.validate(p);
  assert.ok(errs.some((e) => e.includes('duplicate slice id a')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('unknown dependency nope')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('unknown queue item Q9')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('bad status weird')), errs.join('; '));
  assert.deepStrictEqual(plan.validate(planOf(S('a'), S('b', { depends_on: ['a'] }))), []);
});

it('plan: a dependency cycle is a validation error, not a silent stall', () => {
  const p = planOf(S('a', { depends_on: ['b'] }), S('b', { depends_on: ['a'] }));
  assert.ok(plan.validate(p).some((e) => e.includes('cycle')), plan.validate(p).join('; '));
});

it('plan: addSlice refuses a duplicate id; front:true puts a slice at the head', () => {
  const p = planOf(S('a'));
  assert.throws(() => plan.addSlice(p, S('a')), /duplicate/);
  plan.addSlice(p, S('fix'), { front: true });
  assert.strictEqual(plan.next(p).id, 'fix');
});

it('plan: save() writes plan.json and approvals.md; load() reads it back; an invalid plan is not saved', () => {
  const home = tmpDir();
  try {
    const p = planOf(S('a'));
    plan.queueItem(p, { slice: 'a', kind: 'publish', title: 'npm publish 0.2.3', ask: 'publish?' });
    plan.save(home, p);
    const back = plan.load(home);
    assert.deepStrictEqual(back, p);
    const md = fs.readFileSync(path.join(home, 'approvals.md'), 'utf8');
    assert.ok(md.includes('Q1'), md);
    assert.ok(md.includes('npm publish 0.2.3'), md);
    assert.ok(md.includes('inbox.md'), 'tells O where to answer');
    back.slices.push({ id: 'a', status: 'todo', depends_on: [], blocked_by: [] });
    assert.throws(() => plan.save(home, back), /duplicate/);
    assert.deepStrictEqual(plan.load(home), p, 'the bad plan did not overwrite the good one');
  } finally {
    rmrf(home);
  }
});

it('plan: load() of a missing home gives an empty plan', () => {
  const home = path.join(tmpDir(), 'none');
  assert.deepStrictEqual(plan.load(home), plan.empty());
});

it('plan: the CLI adds, queues, answers and reports next, exit 2 on a usage error', () => {
  const home = tmpDir();
  const { run } = require('./helpers');
  try {
    const env = { TURBO_HOME: home };
    const cli = (...args) => run('scripts/turbo/plan.js', { args, env });
    assert.strictEqual(cli('add', JSON.stringify(S('a'))).status, 0);
    assert.strictEqual(cli('add', JSON.stringify(S('b'))).status, 0);
    const q = cli('queue', JSON.stringify({ slice: 'a', kind: 'push', title: 't', ask: 'push?' }));
    assert.strictEqual(q.status, 0, q.stderr);
    assert.strictEqual(q.stdout.trim(), 'Q1');
    assert.strictEqual(JSON.parse(cli('next').stdout).id, 'b');
    assert.strictEqual(cli('status', 'b', 'done', '--session', 's1', '--commit', 'abc').status, 0);
    assert.strictEqual(cli('next').stdout.trim(), 'null');
    assert.strictEqual(cli('answer', 'Q1', 'go').status, 0);
    assert.strictEqual(JSON.parse(cli('next').stdout).id, 'a');
    const b = plan.find(plan.load(home), 'b');
    assert.deepStrictEqual([b.session, b.commits], ['s1', ['abc']]);
    assert.strictEqual(cli('bogus').status, 2);
    assert.strictEqual(cli('answer', 'Q7', 'x').status, 2, 'an unknown item is a usage error');
  } finally {
    rmrf(home);
  }
});

runAll('turbo');
