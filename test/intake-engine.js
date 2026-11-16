'use strict';

/**
 * test/intake-engine.js — the intake's core engine (Phase 1 slice B1, built
 * unwired before the 0.2.3 cut; brief v4 lines 343, 360; design D-I 4.3;
 * test 53). The engine is pure: the test gives it a fake clock and real
 * session logs in a throwaway folder. Fixtures are synthetic.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { createIntake } = require('../src/opon/intake/engine');
const { createSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const SID = HEADERS.good.header.session_id;
const MS = 1000000n;

const strip = (r) => {
  const o = JSON.parse(JSON.stringify(r));
  delete o.seq;
  delete o.prev_hash;
  delete o.hash;
  return o;
};
const mark = (name) => {
  const m = strip(SPEC.good[name]);
  delete m.mono_ns; // arrival time: the intake stamps it from its clock
  return m;
};
const rawLines = (dir) => fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));

/** A fake clock starting at 1 s of mono time; advance(ms) moves both clocks. */
function fakeClock() {
  let mono = 1000n * MS;
  let wall = Date.UTC(2026, 10, 16, 12, 0, 0, 0);
  const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
  clock.advance = (ms) => {
    mono += BigInt(ms) * MS;
    wall += ms;
  };
  return clock;
}

/** An intake whose logs live in a throwaway folder, one per session id. */
function withIntake(fn) {
  return () => {
    const base = tmpDir();
    const dirs = new Map();
    const openLog = (sessionId) => {
      const dir = path.join(base, sessionId);
      dirs.set(sessionId, dir);
      return createSessionLog(dir, { ...strip(HEADERS.good.header), session_id: sessionId });
    };
    const clock = fakeClock();
    try {
      fn({ intake: createIntake({ openLog, clock }), clock, dir: (id) => dirs.get(id) });
    } finally {
      rmrf(base);
    }
  };
}

const ticks = (dir) => rawLines(dir).filter((r) => r.says === 'tick');

it(
  'test 53: a session idle for 10 minutes gets a tick after every 500 ms with nothing written, and the log verifies',
  withIntake(({ intake, clock, dir }) => {
    assert.strictEqual(intake.receive(mark('hook_started')).ok, true);
    for (let t = 0; t < 600000; t += 100) {
      clock.advance(100);
      intake.poll();
    }
    assert.strictEqual(ticks(dir(SID)).length, 1200);
    assert.strictEqual(verifySessionLog(dir(SID)).ok, true);
  }),
);

it(
  'test 53: a busy session, a mark every 100 ms for 10 s, gets no tick',
  withIntake(({ intake, clock, dir }) => {
    for (let t = 0; t < 10000; t += 100) {
      assert.strictEqual(intake.receive(mark('hook_started')).ok, true);
      clock.advance(100);
      assert.strictEqual(intake.poll(), 0);
    }
    assert.strictEqual(ticks(dir(SID)).length, 0);
  }),
);

it(
  'silence is measured from the last mark written: ticks at 500 and 1,000 ms, then a mark at 1,200 ms moves the next to 1,700 ms',
  withIntake(({ intake, clock, dir }) => {
    intake.receive(mark('hook_started'));
    const at = [];
    for (let t = 100; t <= 2000; t += 100) {
      clock.advance(100);
      if (t === 1200) intake.receive(mark('hook_started'));
      if (intake.poll()) at.push(t);
    }
    assert.deepStrictEqual(at, [500, 1000, 1700]);
    assert.strictEqual(ticks(dir(SID)).length, 3);
  }),
);

it(
  'a tick is a process mark with no turn, no target and no cause, stamped from the intake clock',
  withIntake(({ intake, clock, dir }) => {
    intake.receive(mark('hook_started'));
    clock.advance(500);
    const now = clock();
    assert.strictEqual(intake.poll(), 1);
    const t = ticks(dir(SID))[0];
    assert.deepStrictEqual(
      [t.source, t.says, t.turn, t.target, t.cause_hint, t.agent, t.sub_agent, t.mono_ns, t.observed_at],
      ['process', 'tick', null, null, null, null, null, now.mono, now.wall],
    );
  }),
);

it(
  'a mark with no mono_ns is stamped with the intake clock at arrival, and says so; one that has it keeps it',
  withIntake(({ intake, clock, dir }) => {
    clock.advance(250);
    const now = clock();
    intake.receive(mark('hook_started'));
    intake.receive(strip(SPEC.good.hook_started));
    const [a, b] = rawLines(dir(SID)).slice(1);
    assert.deepStrictEqual([a.mono_ns, a.detail.stamped_by], [now.mono, 'intake']);
    assert.deepStrictEqual([b.mono_ns, b.detail.stamped_by], [SPEC.good.hook_started.mono_ns, undefined]);
  }),
);

it(
  'a session the intake has not seen gets no tick; the caller\'s mark object is not changed',
  withIntake(({ intake, clock }) => {
    clock.advance(5000);
    assert.strictEqual(intake.poll(), 0);
    const m = mark('hook_started');
    const before = JSON.stringify(m);
    intake.receive(m);
    assert.strictEqual(JSON.stringify(m), before);
  }),
);

it(
  'a mark that names no session cannot be routed: refused with a reason, nothing written anywhere',
  withIntake(({ intake }) => {
    const m = mark('hook_started');
    delete m.session_id;
    const r = intake.receive(m);
    assert.strictEqual(r.ok, false);
    assert.ok(/session/.test(r.reason), r.reason);
    assert.strictEqual(intake.poll(), 0);
  }),
);

runAll('intake-engine');
