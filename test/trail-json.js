'use strict';

/**
 * test/trail-json.js
 *
 * Covers the machine-readable trail surface (the glove as JSON):
 *   - render/trail-json.js: valid parseable JSON, own schema_version, and the
 *     --facts-only projection that drops the inferred lineage layer while
 *     keeping every recording;
 *   - src/trail sentinel_active: the honest signal that says whether the
 *     independent disk observer contributed anything to the session.
 *
 * Same dependency-free harness as the rest of the suite (assert + tmpHome).
 * Run: node test/trail-json.js
 */

const { assert, it, runAll, tmpHome, rmrf } = require('./helpers');
const { renderTrailJson, SCHEMA_VERSION } = require('../src/render/trail-json');
const eventlog = require('../src/store/eventlog');
const { trailForSession } = require('../src/trail');

// A synthetic trail model carrying BOTH recordings and the inferred lineage
// layer (edges + touched_by/touched), so the facts-only projection has
// something to strip and the recordings have something to preserve.
function sampleTrail() {
  return {
    session_id: 's1',
    generated_at: '2026-01-01T00:00:00Z',
    sentinel_active: false,
    turns: [
      {
        turn_id: 't1',
        prompt: 'add a helper',
        trail: [
          { key: 'src/a.js', type: 'file_write', channel: 'write', diff_volume: 3, ts: '2026-01-01T00:00:02Z' },
        ],
        edges: [{ from: 'src/r.js', to: 'src/a.js', kind: 'file_read->file_write', inferred: true }],
        artifacts: [
          {
            key: 'src/a.js',
            label: 'a.js',
            path: 'src/a.js',
            channels: ['write'],
            touch_count: 1,
            touches: [{ key: 'src/a.js', type: 'file_write', channel: 'write', diff_volume: 3 }],
            touched_by: ['src/r.js'],
            touched: [],
            sub_agents: [],
            any_failed: false,
          },
        ],
      },
    ],
    artifacts: [
      {
        key: 'src/a.js',
        label: 'a.js',
        path: 'src/a.js',
        channels: ['write'],
        touch_count: 1,
        touched_by: ['src/r.js'],
        sub_agents: [],
        turn_count: 1,
        any_failed: false,
      },
    ],
    totals: { turns: 1, artifacts: 1, touches: 1 },
  };
}

it('trail --json emits valid parseable JSON with a schema_version', () => {
  const out = renderTrailJson(sampleTrail(), {});
  const parsed = JSON.parse(out); // throws if not valid JSON — that's the assertion
  assert.strictEqual(parsed.schema_version, SCHEMA_VERSION, 'carries its own schema_version');
  assert.strictEqual(parsed.facts_only, false, 'default mode reports facts_only:false');
  assert.ok(Array.isArray(parsed.turns), 'turns array present');
  assert.ok(Array.isArray(parsed.artifacts), 'session artifacts array present');
  // full mode keeps the inferred layer intact
  assert.ok(Array.isArray(parsed.turns[0].edges), 'full mode keeps per-turn edges');
  assert.deepStrictEqual(parsed.turns[0].artifacts[0].touched_by, ['src/r.js'], 'full mode keeps artifact touched_by');
  assert.deepStrictEqual(parsed.artifacts[0].touched_by, ['src/r.js'], 'full mode keeps session touched_by');
});

it('--facts-only removes edges/touched_by/touched and keeps the recordings', () => {
  const out = renderTrailJson(sampleTrail(), { factsOnly: true });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.facts_only, true, 'facts_only mode is self-declared');

  const turn = parsed.turns[0];
  assert.ok(!('edges' in turn), 'facts-only drops per-turn edges');
  const art = turn.artifacts[0];
  assert.ok(!('touched_by' in art), 'facts-only drops per-turn artifact touched_by');
  assert.ok(!('touched' in art), 'facts-only drops per-turn artifact touched');
  assert.ok(!('touched_by' in parsed.artifacts[0]), 'facts-only drops session artifact touched_by');

  // recordings are all preserved — nothing observed is thrown away
  assert.ok(Array.isArray(art.touches), 'touches[] kept');
  assert.strictEqual(art.touches[0].diff_volume, 3, 'diff_volume kept');
  assert.deepStrictEqual(art.channels, ['write'], 'channels kept');
  assert.strictEqual(art.touch_count, 1, 'touch_count kept');
  assert.strictEqual(art.any_failed, false, 'any_failed kept');
  assert.ok(Array.isArray(turn.trail), 'chronological trail[] rows kept (already pure recordings)');
  assert.strictEqual(parsed.artifacts[0].touch_count, 1, 'session recordings kept');
});

it('sentinel_active is false when no independent disk write falls in the session', () => {
  const home = tmpHome();
  const sid = 'sess-no-sentinel';
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'user_prompt', text: 'go', ts: '2026-01-01T00:00:01.000Z' });
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', source: 'hook', type: 'file_write', path: 'src/a.js', diff: '+1\n', ts: '2026-01-01T00:00:02.000Z' });
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'turn_end', ts: '2026-01-01T00:00:03.000Z' });

  const trail = trailForSession(sid);
  assert.strictEqual(trail.sentinel_active, false, 'no sentinel writes → the signal is explicitly false, not silent');
  rmrf(home);
});

it('sentinel_active is true when a sentinel-observed write lands in a turn window', () => {
  const home = tmpHome();
  const sid = 'sess-with-sentinel';
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'user_prompt', text: 'go', ts: '2026-01-01T00:00:01.000Z' });
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', source: 'hook', type: 'file_write', path: 'src/a.js', diff: '+1\n', ts: '2026-01-01T00:00:02.000Z' });
  // Independently-observed disk write: turn_id null (the sentinel can't see turn
  // ids), ts inside the turn's [first, last] hook-event window [01, 03].
  eventlog.append({ session_id: sid, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: 'src/sneaky.js', diff: '+2\n', ts: '2026-01-01T00:00:02.500Z' });
  eventlog.append({ session_id: sid, turn_id: 't1', agent: 'claude-code', type: 'turn_end', ts: '2026-01-01T00:00:03.000Z' });

  const trail = trailForSession(sid);
  assert.strictEqual(trail.sentinel_active, true, 'a sentinel write in the window flips the signal true');
  rmrf(home);
});

runAll('trail-json');