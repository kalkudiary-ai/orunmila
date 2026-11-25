'use strict';

/**
 * test/graph2d.js — G2D (O, 2026-11-25: "update graph tab too to be more legible ... levels and undulations"): the
 * Graph tab as levels, left to right, with links as smooth curves between them. The layout is plain code, held here:
 *
 *   - three levels by what the agent did: read (left), ran or used (middle), changed (right);
 *   - inside a level, things sit grouped by folder, the most touched first, flagged ones at the top of their folder;
 *   - a level holds at most `cap` rows; the rest are counted, never dropped silently, and a search can bring them back;
 *   - every link joins two placed things, as a curve from the left one's right edge to the right one's left edge;
 *   - the same input gives the same picture.
 */

const vm = require('vm');
const { assert, it, runAll } = require('./helpers');
const g2 = require('../src/render/graph2d');
const { buildVizData, renderTrailVisual } = require('../src/render/trail-visual');

const core = g2.core();

function node(id, channel, path, touches, stain) {
  return { id, label: path ? path.split('/').pop() : 'cmd:' + id, path: path || null, primaryChannel: channel, channels: [channel], touches, stain: stain || null };
}

const nodes = [
  node(0, 'read', 'src/a/x.js', 3),
  node(1, 'read', 'src/b/y.js', 9),
  node(2, 'command', null, 4),
  node(3, 'write', 'src/a/x.js', 2, 'undisclosed'),
  node(4, 'write', 'src/a/z.js', 7),
  node(5, 'disk', 'src/b/w.js', 1),
  node(6, 'tool', null, 2),
  node(7, 'network', null, 1),
  node(8, 'read', 'src/a/v.js', 5, 'phantom'),
];
const edges = [{ from: 1, to: 4 }, { from: 0, to: 3 }, { from: 2, to: 4 }, { from: 8, to: 5 }, { from: 4, to: 3 }];

it('G2D: three levels by what the agent did: read left, ran or used middle, changed right', () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  const level = (i) => L.placed.find((p) => p.id === i).level;
  assert.deepStrictEqual([0, 1, 8].map(level), [0, 0, 0]);
  assert.deepStrictEqual([2, 6, 7].map(level), [1, 1, 1]);
  assert.deepStrictEqual([3, 4, 5].map(level), [2, 2, 2]);
  assert.deepStrictEqual(L.levels.map((l) => l.title), ['Read', 'Ran or used', 'Changed']);
  const x = (i) => L.placed.find((p) => p.id === i).x;
  assert.ok(x(0) < x(2) && x(2) < x(3), 'left to right');
});

it('G2D: inside a level, grouped by folder; flagged first in its folder, then the most touched', () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  const col = (lv) => L.placed.filter((p) => p.level === lv).sort((a, b) => a.y - b.y).map((p) => p.id);
  assert.deepStrictEqual(col(0), [8, 0, 1], 'src/a (flagged v.js, then x.js) before src/b');
  assert.deepStrictEqual(col(2), [3, 4, 5], 'src/a (flagged x.js, then z.js) before src/b');
  const groups = L.levels[0].groups.map((g) => g.folder);
  assert.deepStrictEqual(groups, ['src/a', 'src/b']);
});

it('G2D: a level holds at most `cap` rows; the rest are counted, and a search brings a hidden one back', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(node(i, 'read', `src/r${i}.js`, 30 - i));
  const L = core.layered(many, [], { cap: 10 });
  assert.strictEqual(L.placed.length, 10);
  assert.strictEqual(L.levels[0].hidden, 20);
  assert.ok(L.placed.every((p) => p.id < 10), 'the most touched are kept');
  const S = core.layered(many, [], { cap: 10, search: 'r25' });
  assert.ok(S.placed.some((p) => p.id === 25), 'the search match is placed');
});

it('G2D: every link joins two placed things, as a curve from the left edge to the right one', () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  assert.strictEqual(L.links.length, edges.length);
  for (const l of L.links) {
    assert.ok(/^M[\d.]+ [\d.]+ C[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+$/.test(l.d), l.d);
    const a = L.placed.find((p) => p.id === l.from), b = L.placed.find((p) => p.id === l.to);
    assert.ok(a && b, 'both ends placed');
  }
  const hidden = core.layered(nodes, edges, { cap: 1 });
  for (const l of hidden.links) assert.ok(hidden.placed.some((p) => p.id === l.from) && hidden.placed.some((p) => p.id === l.to));
});

it('G2D: one folder written two ways (absolute and from the project) is one group, named from the project', () => {
  const two = [
    node(0, 'read', '~/tools/proj/src/opon/a.js', 3),
    node(1, 'read', 'src/opon/b.js', 2),
    node(2, 'write', '~/tools/proj/test/c.js', 1),
    node(3, 'write', 'test/d.js', 1),
    node(4, 'read', '~/tools/proj/README.md', 1),
  ];
  const L = core.layered(two, [], { cap: 50 });
  assert.deepStrictEqual(L.levels[0].groups.map((g) => g.folder).sort(), ['.', 'src/opon']);
  assert.deepStrictEqual(L.levels[2].groups.map((g) => g.folder), ['test']);
});

it('G2D: one file written two ways in one level is one row, and links to either spelling reach it', () => {
  const two = [
    node(0, 'write', '~/tools/proj/scripts/gate.js', 2),
    node(1, 'write', 'scripts/gate.js', 5),
    node(2, 'read', 'src/a.js', 1),
    node(3, 'read', '~/tools/proj/src/a.js', 1),
  ];
  const L = core.layered(two, [{ from: 2, to: 0 }, { from: 3, to: 1 }], { cap: 50 });
  const rows = L.placed.filter((p) => p.level === 2);
  assert.strictEqual(rows.length, 1, 'one row for scripts/gate.js');
  assert.strictEqual(rows[0].id, 1, 'the most touched spelling stands for both');
  assert.deepStrictEqual(rows[0].also, [0]);
  assert.strictEqual(L.links.length, 1, 'both links become one, between the two merged rows');
});

it("G2D: a link leaves from its column's right edge, past the labels, and enters at the dot", () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  const l = L.links.find((x) => x.from === 1 && x.to === 4);
  const start = +l.d.split(' ')[0].slice(1);
  const b = L.placed.find((p) => p.id === 4);
  const end = +l.d.split(' ').slice(-2)[0];
  assert.ok(start >= L.levels[0].x + L.levels[0].width - 20, `starts at ${start}, the column ends at ${L.levels[0].x + L.levels[0].width}`);
  assert.ok(Math.abs(end - (b.x - b.r)) < 0.11, `ends at the dot's left edge: ${end} vs ${b.x - b.r}`);
});

it('G2D: the same input gives the same picture', () => {
  assert.deepStrictEqual(core.layered(nodes, edges, { cap: 50 }), core.layered(nodes, edges, { cap: 50 }));
});

it("G2D: the trail page's Graph tab uses the levels, and its whole script parses", () => {
  const model = {
    session_id: 's1',
    artifacts: [{ key: 'a', label: 'a.js', path: 'src/a.js', channels: ['write'], touch_count: 3 }, { key: 'b', label: 'b.js', path: 'src/b.js', channels: ['read'], touch_count: 1 }],
    turns: [{ turn_id: 't1', prompt: 'p', edges: [{ from: 'b', to: 'a', kind: 'informed' }], trail: [{ key: 'b', channel: 'read', path: 'src/b.js' }, { key: 'a', channel: 'write', path: 'src/a.js' }] }],
  };
  const html = renderTrailVisual(buildVizData(model, new Map(), []));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts[0].includes('orunmilaGraph2DCore.layered('), 'the Graph tab calls the levels layout');
  new vm.Script(scripts[0], { filename: 'trail-page.js' });
});

runAll('graph2d');
