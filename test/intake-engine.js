// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/intake-engine.js — the intake's core engine (Phase 1 slice B1, built
 * unwired before the 0.2.3 cut; brief v4 lines 343, 360; design D-I 4.3;
 * test 53). The engine is pure: the test gives it a fake clock and real
 * session logs in a throwaway folder. Fixtures are synthetic.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { createIntake } = require('../src/opon/intake/engine');
const { createSessionLog, openSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');

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

/** A sender check that accepts every process (the wiring's real one reads the pid's program, LD58). */
const ANY = () => true;

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
      fn({ intake: createIntake({ openLog, clock, checkSender: ANY }), clock, dir: (id) => dirs.get(id) });
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

// --- B1b: pinning and the wrong sender (test 82; decisions I-2, I-3) -----------------

const HTTP = (pid) => ({ channel: 'http', pid });

it(
  'test 82: a payload for a pinned session from another process is a tampered mark (foreign_sender), never the session\'s own mark',
  withIntake(({ intake, dir }) => {
    assert.strictEqual(intake.receive(mark('hook_started'), HTTP(100)).ok, true);
    assert.strictEqual(intake.receive(mark('hook_started'), HTTP(100)).ok, true);
    const forged = { ...mark('hook_started'), cause_hint: 'toolu_forged' };
    const r = intake.receive(forged, HTTP(200));
    assert.strictEqual(r.ok, false);
    assert.ok(/another process/.test(r.reason), r.reason);
    const rows = rawLines(dir(SID)).slice(1);
    assert.deepStrictEqual(rows.map((x) => x.says), ['started', 'started', 'tampered']);
    const t = rows[2];
    assert.deepStrictEqual([t.source, t.turn, t.target, t.detail.what, t.detail.sender_pid, t.detail.pinned_pid], ['process', null, { kind: 'process' }, 'foreign_sender', 200, 100]);
    assert.ok(t.detail.received.includes('toolu_forged'), 'the payload is kept as evidence, as text');
    assert.ok(!rows.some((x) => x.cause_hint === 'toolu_forged'), 'never written as a mark of the session');
    assert.strictEqual(verifySessionLog(dir(SID)).ok, true);
  }),
);

it(
  'decision I-3: Glove marks say how they reached intake (detail.channel); a command-hook mark is never refused by the pin',
  withIntake(({ intake, dir }) => {
    intake.receive(mark('hook_started'), HTTP(100));
    assert.strictEqual(intake.receive(mark('hook_started'), { channel: 'command', pid: 999 }).ok, true);
    intake.receive(mark('claim'), HTTP(100));
    const rows = rawLines(dir(SID)).slice(1);
    assert.deepStrictEqual(rows.map((x) => x.detail.channel), ['http', 'command', 'http']);
  }),
);

it(
  'only Glove marks are labelled with a channel; a mark sent with no channel is not labelled, and nothing pins without a pid',
  withIntake(({ intake, dir }) => {
    const s = mark('sentinel_modified');
    delete s.detail.diff_ref; // no file kept beside the log for it here
    assert.strictEqual(intake.receive(s, HTTP(100)).ok, true);
    intake.receive(mark('hook_started'));
    intake.receive(mark('hook_started'), { channel: 'http' });
    assert.strictEqual(intake.receive(mark('hook_started'), HTTP(300)).ok, true, 'the first payload with a pid pins');
    assert.strictEqual(intake.receive(mark('hook_started'), HTTP(301)).ok, false);
    const rows = rawLines(dir(SID)).slice(1);
    assert.deepStrictEqual(rows.map((x) => x.detail.channel), [undefined, undefined, 'http', 'http', undefined]);
  }),
);

it(
  'pins are per session: one process may serve two sessions, and session B\'s pin does not refuse session A\'s sender',
  withIntake(({ intake, dir }) => {
    const other = (m) => ({ ...m, session_id: 'ses_test_0002' });
    intake.receive(mark('hook_started'), HTTP(100));
    intake.receive(other(mark('hook_started')), HTTP(500));
    assert.strictEqual(intake.receive(mark('hook_started'), HTTP(100)).ok, true);
    assert.strictEqual(intake.receive(other(mark('hook_started')), HTTP(500)).ok, true);
    assert.strictEqual(intake.receive(other(mark('hook_started')), HTTP(100)).ok, false);
    assert.strictEqual(rawLines(dir('ses_test_0002')).filter((x) => x.says === 'tampered').length, 1);
    assert.strictEqual(rawLines(dir(SID)).filter((x) => x.says === 'tampered').length, 0);
  }),
);

// --- B1c-2: the restart gap (test 84; design D-I 4.7) -----------------------------

const B = 'ses_test_0002';
const inSession = (m, id) => ({ ...m, session_id: id });
const noNewLog = () => {
  throw new Error('a resumed session is never created anew');
};

/**
 * Two sessions served: both tick at 600 ms, B gets a mark at 700 ms, and only A
 * ticks at 1,100 ms. The intake's last record is A's tick; B's own is older.
 */
function serveTwo(intake, clock) {
  intake.receive(mark('hook_started'));
  intake.receive(inSession(mark('hook_started'), B));
  clock.advance(600);
  intake.poll();
  clock.advance(100);
  intake.receive(inSession(mark('hook_started'), B));
  clock.advance(400);
  assert.strictEqual(intake.poll(), 1);
  return clock();
}

it(
  'test 84: intake stopped for a while mid-session: on restart, one gap in each session it was serving, from its last record to now, naming them all; the logs verify',
  withIntake(({ intake, clock, dir }) => {
    const before = serveTwo(intake, clock);
    clock.advance(60000);
    const now = clock();
    const again = createIntake({ checkSender: ANY, openLog: noNewLog, clock });
    const r = again.resume([SID, B].map((id) => ({ id, log: openSessionLog(dir(id)) })));
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.gaps.map((g) => g.id), [SID, B]);
    for (const id of [SID, B]) {
      const rows = rawLines(dir(id));
      const gaps = rows.filter((x) => x.says === 'gap');
      assert.strictEqual(gaps.length, 1, `one gap in ${id}`);
      const g = gaps[0];
      assert.strictEqual(g, rows[rows.length - 1]);
      assert.deepStrictEqual([g.source, g.turn, g.target, g.agent, g.cause_hint, g.mono_ns, g.observed_at], ['process', null, null, null, null, now.mono, now.wall]);
      assert.deepStrictEqual(g.detail.since, { mono_ns: before.mono, observed_at: before.wall }, 'the intake\'s last record, in any session');
      assert.deepStrictEqual(g.detail.until, { mono_ns: now.mono, observed_at: now.wall });
      assert.deepStrictEqual(g.detail.sessions, [SID, B].sort());
      assert.ok(g.detail.lost.includes(before.wall) && g.detail.lost.includes(now.wall), g.detail.lost);
      assert.strictEqual(g.detail.clock_reset, undefined);
      assert.strictEqual(r.gaps.find((x) => x.id === id).seq, g.seq);
      const v = verifySessionLog(dir(id));
      assert.strictEqual(v.ok, true, v.words);
    }
  }),
);

it(
  'after a resume the intake carries on: marks continue the reopened logs, idle sessions tick, and nothing is created anew',
  withIntake(({ intake, clock, dir }) => {
    serveTwo(intake, clock);
    clock.advance(5000);
    const again = createIntake({ checkSender: ANY, openLog: noNewLog, clock });
    again.resume([SID, B].map((id) => ({ id, log: openSessionLog(dir(id)) })));
    const gapSeq = rawLines(dir(SID)).length - 1;
    assert.deepStrictEqual(again.receive(mark('hook_started')), { ok: true, seq: gapSeq + 1 });
    clock.advance(500);
    assert.strictEqual(again.poll(), 2);
    for (const id of [SID, B]) assert.strictEqual(verifySessionLog(dir(id)).ok, true, id);
  }),
);

it(
  'resume comes first and names each session once: refused after a mark, refused for a repeated session; an empty resume writes nothing',
  withIntake(({ intake, clock, dir }) => {
    intake.receive(mark('hook_started'));
    assert.throws(() => intake.resume([{ id: SID, log: openSessionLog(dir(SID)) }]), /first/);
    const again = createIntake({ checkSender: ANY, openLog: noNewLog, clock });
    assert.throws(() => again.resume([SID, SID].map((id) => ({ id, log: openSessionLog(dir(id)) }))), /twice/);
    assert.deepStrictEqual(createIntake({ checkSender: ANY, openLog: noNewLog, clock }).resume([]), { gaps: [], failed: [], skipped: [] });
    assert.strictEqual(rawLines(dir(SID)).filter((x) => x.says === 'gap').length, 0);
  }),
);

it(
  'a restart after the machine rebooted (the clock now reads below the last record) still writes the gap, and says the clocks reset',
  withIntake(({ intake, clock, dir }) => {
    const before = serveTwo(intake, clock);
    const rebooted = () => ({ mono: '5000', wall: '2026-11-16T13:00:00.000Z' });
    const r = createIntake({ checkSender: ANY, openLog: noNewLog, clock: rebooted }).resume([SID, B].map((id) => ({ id, log: openSessionLog(dir(id)) })));
    assert.strictEqual(r.gaps.length, 2);
    for (const id of [SID, B]) {
      const g = rawLines(dir(id)).filter((x) => x.says === 'gap')[0];
      assert.deepStrictEqual([g.detail.clock_reset, g.detail.since.mono_ns, g.detail.until.mono_ns], [true, before.mono, '5000']);
      assert.strictEqual(verifySessionLog(dir(id)).ok, true, id);
    }
  }),
);

it(
  'a gap a log refuses is reported with its reason, never dropped silently; the other sessions still get theirs',
  withIntake(({ intake, clock, dir }) => {
    serveTwo(intake, clock);
    clock.advance(1000);
    const refusing = { last: () => ({ seq: 3, mono_ns: '1', observed_at: '2026-11-16T12:00:00.000Z' }), ended: () => false, pin: () => null, append: () => ({ ok: false, reasons: ['disk full'] }) };
    const r = createIntake({ checkSender: ANY, openLog: noNewLog, clock }).resume([
      { id: SID, log: openSessionLog(dir(SID)) },
      { id: B, log: refusing },
    ]);
    assert.deepStrictEqual(r.failed, [{ id: B, reason: 'disk full' }]);
    assert.deepStrictEqual(r.gaps.map((g) => g.id), [SID]);
  }),
);

// --- B1d-2: the session's end (LD55) ---------------------------------------------

const ended = (id) => inSession(mark('hook_session_ended'), id);

it(
  'LD55: an ended session gets no tick; a mark that still arrives for it is written, never refused',
  withIntake(({ intake, clock, dir }) => {
    intake.receive(mark('hook_started'));
    assert.strictEqual(intake.receive(ended(SID)).ok, true);
    for (let t = 0; t < 2000; t += 100) {
      clock.advance(100);
      assert.strictEqual(intake.poll(), 0);
    }
    assert.strictEqual(intake.receive(mark('hook_started')).ok, true, 'a late mark lands');
    clock.advance(1000);
    assert.strictEqual(intake.poll(), 0, 'and does not start the ticks again');
    assert.deepStrictEqual(rawLines(dir(SID)).slice(1).map((x) => x.says), ['started', 'ended', 'started']);
  }),
);

it(
  'LD55: on restart, a session that ended gets no gap and is named in no other gap; a late mark for it still lands in its log, and it never ticks',
  withIntake(({ intake, clock, dir }) => {
    serveTwo(intake, clock);
    intake.receive(ended(B));
    clock.advance(30000);
    const again = createIntake({ checkSender: ANY, openLog: noNewLog, clock });
    const r = again.resume([SID, B].map((id) => ({ id, log: openSessionLog(dir(id)) })));
    assert.deepStrictEqual(r.gaps.map((g) => g.id), [SID]);
    assert.deepStrictEqual(r.skipped, [{ id: B, reason: 'the session ended' }]);
    const g = rawLines(dir(SID)).filter((x) => x.says === 'gap')[0];
    assert.deepStrictEqual(g.detail.sessions, [SID]);
    assert.strictEqual(rawLines(dir(B)).filter((x) => x.says === 'gap').length, 0);
    assert.strictEqual(again.receive(inSession(mark('hook_started'), B)).ok, true);
    clock.advance(1000);
    assert.strictEqual(again.poll(), 1, 'only the live session ticks');
    for (const id of [SID, B]) assert.strictEqual(verifySessionLog(dir(id)).ok, true, id);
  }),
);

// --- B1e: the closing note on a planned stop (LD56) --------------------------------

it(
  'LD56: a planned stop writes one closing note into each session not yet ended, then accepts nothing and ticks nothing; a second stop writes nothing',
  withIntake(({ intake, clock, dir }) => {
    serveTwo(intake, clock);
    intake.receive(ended(B));
    clock.advance(200);
    const now = clock();
    const r = intake.stop('a stop signal');
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.notes.map((n) => n.id), [SID]);
    const rows = rawLines(dir(SID));
    const n = rows[rows.length - 1];
    assert.strictEqual(r.notes[0].seq, n.seq);
    assert.deepStrictEqual(
      [n.source, n.says, n.turn, n.target, n.detail, n.mono_ns, n.observed_at],
      ['process', 'exited', null, { kind: 'process', name: 'intake' }, { exit_status: 'pass', reason: 'a stop signal' }, now.mono, now.wall],
    );
    assert.strictEqual(rawLines(dir(B)).filter((x) => x.says === 'exited').length, 0, 'an ended session gets no note');
    const late = intake.receive(mark('hook_started'));
    assert.strictEqual(late.ok, false);
    assert.ok(/stopped/.test(late.reason), late.reason);
    clock.advance(5000);
    assert.strictEqual(intake.poll(), 0);
    assert.deepStrictEqual(intake.stop('again'), { notes: [], failed: [] });
    assert.strictEqual(rawLines(dir(SID)).length, rows.length, 'nothing written after the note');
    for (const id of [SID, B]) assert.strictEqual(verifySessionLog(dir(id)).ok, true, id);
  }),
);

it(
  'LD56: after a planned stop, the restart gap starts at the closing note, the intake\'s last write',
  withIntake(({ intake, clock, dir }) => {
    serveTwo(intake, clock);
    clock.advance(300);
    const at = clock();
    intake.stop('a stop signal');
    clock.advance(60000);
    createIntake({ checkSender: ANY, openLog: noNewLog, clock }).resume([SID, B].map((id) => ({ id, log: openSessionLog(dir(id)) })));
    for (const id of [SID, B]) {
      const g = rawLines(dir(id)).filter((x) => x.says === 'gap')[0];
      assert.deepStrictEqual(g.detail.since, { mono_ns: at.mono, observed_at: at.wall }, id);
    }
  }),
);

it('LD56: a closing note a log refuses is reported with its reason, never dropped silently', () => {
  const refusing = { append: () => ({ ok: false, reasons: ['disk full'] }), last: () => null, ended: () => false };
  const intake = createIntake({ checkSender: ANY, openLog: () => refusing, clock: fakeClock() });
  intake.receive(mark('hook_started'));
  assert.deepStrictEqual(intake.stop('a stop signal'), { notes: [], failed: [{ id: SID, reason: 'disk full' }] });
});

// --- B1f: the pin kept in the record (LD58) ---------------------------------------

it(
  'LD58: the mark that pins a session carries the sender\'s pid, written by intake alone; no later mark does, and a sender_pid a source wrote itself is removed',
  withIntake(({ intake, dir }) => {
    const forged = (m) => ({ ...m, detail: { ...m.detail, sender_pid: 999 } });
    intake.receive(forged(mark('hook_started')), { channel: 'command', pid: 5 });
    intake.receive(forged(mark('hook_started')), HTTP(100));
    intake.receive(forged(mark('hook_started')), HTTP(100));
    const rows = rawLines(dir(SID)).slice(1);
    assert.deepStrictEqual(rows.map((x) => x.detail.sender_pid), [undefined, 100, undefined]);
  }),
);

it(
  'LD58: a restarted intake re-pins from the record: the pinned sender is accepted, another is tampered with the old pin named',
  withIntake(({ intake, clock, dir }) => {
    intake.receive(mark('hook_started'), HTTP(100));
    clock.advance(5000);
    const again = createIntake({ checkSender: ANY, openLog: noNewLog, clock });
    again.resume([{ id: SID, log: openSessionLog(dir(SID)) }]);
    const r = again.receive(mark('hook_started'), HTTP(200));
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(again.receive(mark('hook_started'), HTTP(100)).ok, true);
    const t = rawLines(dir(SID)).filter((x) => x.says === 'tampered');
    assert.deepStrictEqual(t.map((x) => [x.detail.sender_pid, x.detail.pinned_pid]), [[200, 100]]);
  }),
);

it(
  'LD58: a first sender the check refuses (not the agent\'s program) pins nothing and is recorded as tampered with no pinned_pid; the agent\'s own sender then pins',
  () => {
    const base = tmpDir();
    try {
      const seen = [];
      const checkSender = (pid, m) => {
        seen.push([pid, m.session_id]);
        return pid === 100;
      };
      const openLog = (id) => createSessionLog(path.join(base, id), { ...strip(HEADERS.good.header), session_id: id });
      const intake = createIntake({ openLog, clock: fakeClock(), checkSender });
      const r = intake.receive(mark('hook_started'), HTTP(666));
      assert.strictEqual(r.ok, false);
      assert.ok(/program/.test(r.reason), r.reason);
      assert.strictEqual(intake.receive(mark('hook_started'), HTTP(100)).ok, true);
      assert.strictEqual(intake.receive(mark('hook_started'), HTTP(666)).ok, false, 'pinned now: refused as foreign');
      const rows = rawLines(path.join(base, SID)).slice(1);
      assert.deepStrictEqual(rows.map((x) => x.says), ['tampered', 'started', 'tampered']);
      assert.deepStrictEqual([rows[0].detail.what, rows[0].detail.sender_pid, 'pinned_pid' in rows[0].detail], ['foreign_sender', 666, false]);
      assert.deepStrictEqual(rows[2].detail.pinned_pid, 100);
      assert.deepStrictEqual(seen, [[666, SID], [100, SID]], 'checked only at first contact');
      assert.strictEqual(verifySessionLog(path.join(base, SID)).ok, true);
    } finally {
      rmrf(base);
    }
  },
);

it('LD58: an intake built without a sender check throws, so the wiring cannot forget it', () => {
  assert.throws(() => createIntake({ openLog: noNewLog, clock: fakeClock() }), /checkSender/);
});

it(
  'LD124: files kept with a mark reach the log with it: the slot names the kept file, and the log verifies',
  withIntake(({ intake, dir }) => {
    const m = mark('hook_exited_fail');
    delete m.detail.output_ref;
    const r = intake.receive(m, {}, [{ slot: 'output_ref', text: 'whole output\n'.repeat(300) }]);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const written = rawLines(dir(SID)).find((x) => x.seq === r.seq);
    assert.match(written.detail.output_ref, /^sha256:[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dir(SID), 'files', written.detail.output_ref.slice(7))));
    assert.strictEqual(verifySessionLog(dir(SID)).ok, true);
  }),
);

it(
  'LD123: release writes one closing note, then the session gets no tick and is no longer held',
  withIntake(({ intake, clock, dir }) => {
    assert.strictEqual(intake.receive(mark('hook_started')).ok, true);
    const r = intake.release(SID, 'released: no payload for 30 minutes');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const note = rawLines(dir(SID)).find((x) => x.seq === r.seq);
    assert.deepStrictEqual([note.source, note.says, note.target, note.detail], ['process', 'exited', { kind: 'process', name: 'intake' }, { exit_status: 'pass', reason: 'released: no payload for 30 minutes' }]);
    clock.advance(5000);
    assert.strictEqual(intake.poll(), 0, 'a released session is not ticked');
    assert.deepStrictEqual(intake.release(SID, 'again'), { ok: false, reason: `session ${SID} is not held` });
    assert.deepStrictEqual(intake.held(), []);
  }),
);

runAll('intake-engine');
