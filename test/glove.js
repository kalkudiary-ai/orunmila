'use strict';

/**
 * test/glove.js
 *
 * Dependency-free regression harness for the glove lineage engine — same style
 * as test/run.js. Each case feeds a synthetic turn straight into
 * lineageForTurn() and asserts on the artifacts / edges / trail it produces.
 *
 * Run: node test/glove.js
 */

const assert = require('assert');
const { lineageForTurn } = require('../src/glove/lineage');

function findArtifact(model, labelOrKey) {
  return model.artifacts.find((a) => a.label === labelOrKey || a.key === labelOrKey || a.path === labelOrKey);
}

const cases = [
  {
    name: 'read(A) then write(B) then bash(C): B and C are both touched_by A',
    run() {
      const model = lineageForTurn([
        { type: 'file_read', path: 'src/a.js', hash: 'aaaa1111', bytes: 10, ts: '2026-01-01T00:00:01Z' },
        { type: 'file_write', path: 'src/b.js', diff: '+x=1;\n', ts: '2026-01-01T00:00:02Z' },
        { type: 'command_run', command: 'node b.js', exit_code: 0, ts: '2026-01-01T00:00:03Z' },
      ]);
      const b = findArtifact(model, 'src/b.js');
      assert.ok(b, 'b.js artifact exists');
      assert.ok(b.touched_by.includes('src/a.js'), `b.js should be touched_by a.js, got ${JSON.stringify(b.touched_by)}`);
      // the command is keyed cmd:node — find it and assert it inherited from A too
      const cmd = model.artifacts.find((a) => a.key.startsWith('cmd:'));
      assert.ok(cmd, 'command artifact exists');
      assert.ok(cmd.touched_by.includes('src/a.js'), 'command should be touched_by a.js');
      // every edge is explicitly inferred, never asserted as proven
      assert.ok(model.edges.every((e) => e.inferred === true), 'all lineage edges must be flagged inferred');
    },
  },
  {
    name: 'a read with no following sink is a pure source (no descendants)',
    run() {
      const model = lineageForTurn([
        { type: 'file_read', path: 'src/only-read.js', hash: 'beef', bytes: 5, ts: '2026-01-01T00:00:01Z' },
      ]);
      const a = findArtifact(model, 'src/only-read.js');
      assert.ok(a, 'read artifact exists');
      assert.strictEqual(a.touched.length, 0, 'a pure read should have no descendants');
      assert.strictEqual(model.edges.length, 0, 'no edges when there is no sink');
    },
  },
  {
    name: 'forward-only: a write BEFORE a read does not inherit from that later read',
    run() {
      const model = lineageForTurn([
        { type: 'file_write', path: 'src/early.js', diff: '+a=1;\n', ts: '2026-01-01T00:00:01Z' },
        { type: 'file_read', path: 'src/late.js', hash: 'c0de', ts: '2026-01-01T00:00:02Z' },
      ]);
      const early = findArtifact(model, 'src/early.js');
      assert.strictEqual(early.touched_by.length, 0, 'a write must not inherit from a read that happened after it');
    },
  },
  {
    name: 'network_call surfaces as a network-channel artifact with its host',
    run() {
      const model = lineageForTurn([
        { type: 'network_call', channel: 'network', tool_name: 'WebFetch', host: 'example.com', target: 'https://example.com/x', ts: '2026-01-01T00:00:01Z' },
      ]);
      const net = model.artifacts.find((a) => a.channels.includes('network'));
      assert.ok(net, 'a network artifact should exist');
      assert.strictEqual(net.key, 'example.com', 'network artifact keyed by host');
      assert.ok(model.trail.some((t) => t.channel === 'network' && t.host === 'example.com'), 'trail records the network host');
    },
  },
  {
    name: 'sentinel-observed disk write appears in the trail tagged as disk-observed',
    run() {
      const model = lineageForTurn([
        { type: 'file_write', path: '/abs/src/sneaky.js', rel_path: 'src/sneaky.js', diff: '+y=2;\n', source: 'fs-sentinel', ts: '2026-01-01T00:00:01Z' },
      ]);
      const row = model.trail.find((t) => t.path === 'src/sneaky.js');
      assert.ok(row, 'sentinel write is in the trail');
      assert.strictEqual(row.channel, 'disk', 'sentinel write uses the disk channel');
      assert.strictEqual(row.source, 'fs-sentinel', 'source preserved for honesty about who observed it');
    },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`\x1b[32mPASS\x1b[0m  ${c.name}`);
    pass++;
  } catch (err) {
    console.log(`\x1b[31mFAIL\x1b[0m  ${c.name}`);
    console.log(`      ${err.message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
