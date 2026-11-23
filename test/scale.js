'use strict';

/**
 * test/scale.js — Phase 5's large-session half (slice LR2a, LD251; brief v4 line 616): the engine's work per mark
 * must not grow with the session's length, so a restart's replay of a long session stays proportional to it. Timed
 * as a ratio, four times the session against the session, so the machine's speed cancels out: linear work gives
 * about 4, work that walks the whole session at every turn gives about 16. Hand-built marks in memory.
 */

const { assert, it, runAll } = require('./helpers');
const { M } = require('./helpers-opon');
const { createOpon } = require('../src/opon/settle/engine');

const CONFIG = { quiet_window_ms: 1500, lag_grace_ms: 3000, ceiling_ms: 120000, exclusions: [] };

/** T turns, each a prompt, four commands (started, exited), a claim and the turn's end. */
function marks(T) {
  const out = [];
  let ms = 0;
  let seq = 0;
  const put = (m) => out.push({ ...m, seq: ++seq });
  for (let t = 1; t <= T; t++) {
    const turn = `t${t}`;
    ms += 1000;
    put(M.prompted(ms, turn));
    for (let k = 0; k < 4; k++) {
      const c = `c${t}_${k}`;
      ms += 200;
      put(M.started(ms, c, { kind: 'command', text: 'echo x' }, 'Bash', turn));
      ms += 50;
      put(M.exited(ms, c, 'echo x', 'pass', turn));
    }
    ms += 100;
    put({ ...M.claimed(ms, turn), detail: { text: 'Ran it.' } });
    put(M.turnEnded(ms, turn));
  }
  return out;
}

/** The fastest of three runs of the engine over T turns, in ms. */
function time(T) {
  const ms = marks(T);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = createOpon({ sessionId: 'ses_replay_test', config: CONFIG, root: '/r' });
    const t0 = process.hrtime.bigint();
    for (const m of ms) o.push(m);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

it('LR2a (LD251): the engine\'s time grows in proportion to the session: four times the turns take under six times as long (a walk of every past call at each turn\'s end took about sixteen)', () => {
  time(500); // warm up
  const small = time(4000);
  const large = time(16000);
  assert.ok(large / small < 6, `4,000 turns ${Math.round(small)} ms, 16,000 turns ${Math.round(large)} ms: ratio ${(large / small).toFixed(1)}`);
});

runAll('scale');
