'use strict';

/**
 * test/intake-restart.js — IR1 (LD240; Phase 5, LD237): the intake is restarted only while it holds no session, so
 * no session's log gets a downtime gap. The decision and the restart's timing run on fake status and restart
 * functions and a fake clock; nothing here touches a real intake or launchd.
 */

const { assert, it, runAll } = require('./helpers');
const { restartWhenIdle } = require('../scripts/intake-restart-idle');

/** A fake intake: each status() call takes the next answer of `answers`, and the clock moves pollMs per wait. */
function fake(answers, { failRestart = false } = {}) {
  const calls = [];
  let i = 0;
  let now = 0;
  return {
    calls,
    opts: {
      status: async () => {
        const a = answers[Math.min(i++, answers.length - 1)];
        calls.push(['status', now, a && a.pid]);
        return a;
      },
      restart: async () => {
        calls.push(['restart', now]);
        if (failRestart) throw new Error('launchctl refused');
      },
      wait: async (ms) => {
        now += ms;
      },
      now: () => now,
    },
  };
}
const up = (pid, held = []) => ({ intake: 'orunmila', pid, held });

it('IR1: a restart waits while any session is held, and runs once the intake has held none for two polls in a row; it reports the new pid and the time no intake answered', async () => {
  const f = fake([up(1, ['s1']), up(1, []), up(1, ['s2']), up(1, []), up(1, []), null, null, up(2, [])]);
  const r = await restartWhenIdle({ ...f.opts, pollMs: 1000, quietPolls: 2, answerPollMs: 100 });
  assert.deepStrictEqual(f.calls.filter((c) => c[0] === 'restart').length, 1, 'restarted once');
  const at = f.calls.findIndex((c) => c[0] === 'restart');
  assert.deepStrictEqual(f.calls.slice(at - 2, at).map((c) => c[2]), [1, 1], 'after two idle polls in a row');
  assert.deepStrictEqual([r.ok, r.before, r.after, r.downtimeMs], [true, 1, 2, 200], 'polled at the restart, +100 and +200 ms');
});

it('IR1: with no intake answering it does nothing (there is nothing to restart, and a start is not a restart)', async () => {
  const f = fake([null]);
  const r = await restartWhenIdle({ ...f.opts, pollMs: 1000, quietPolls: 2, maxWaitMs: 5000 });
  assert.deepStrictEqual([r.ok, r.reason, f.calls.some((c) => c[0] === 'restart')], [false, 'no intake answers', false]);
});

it('IR1: past its limit while sessions stay held it gives up and restarts nothing', async () => {
  const f = fake([up(1, ['s1'])]);
  const r = await restartWhenIdle({ ...f.opts, pollMs: 1000, quietPolls: 2, maxWaitMs: 5000 });
  assert.deepStrictEqual([r.ok, r.reason, f.calls.some((c) => c[0] === 'restart')], [false, 'sessions stayed held: s1', false]);
});

it('IR1: a restart that fails, or an intake that does not answer again, is reported, never taken for success', async () => {
  const failed = await restartWhenIdle({ ...fake([up(1, [])], { failRestart: true }).opts, pollMs: 1000, quietPolls: 1 });
  assert.deepStrictEqual([failed.ok, failed.reason], [false, 'the restart failed: launchctl refused']);
  const silent = await restartWhenIdle({ ...fake([up(1, []), null]).opts, pollMs: 1000, quietPolls: 1, answerPollMs: 100, answerWaitMs: 1000 });
  assert.deepStrictEqual([silent.ok, silent.reason], [false, 'no intake answered within 1000 ms of the restart']);
  const same = await restartWhenIdle({ ...fake([up(1, []), up(1, [])]).opts, pollMs: 1000, quietPolls: 1, answerPollMs: 100, answerWaitMs: 1000 });
  assert.deepStrictEqual([same.ok, same.reason], [false, 'no intake answered within 1000 ms of the restart'], 'the old pid answering is not a restart');
});

runAll('intake-restart');
