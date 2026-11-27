// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
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

it("G2D, CV1: a link leaves from its column's right edge, past the labels, and enters at its box's left edge", () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  const l = L.links.find((x) => x.from === 1 && x.to === 4);
  const start = +l.d.split(' ')[0].slice(1);
  const b = L.placed.find((p) => p.id === 4);
  const end = +l.d.split(' ').slice(-2)[0];
  assert.ok(start >= L.levels[0].x + L.levels[0].width - 20, `starts at ${start}, the column ends at ${L.levels[0].x + L.levels[0].width}`);
  assert.ok(Math.abs(end - b.box.x) < 0.11, `ends at the box's left edge: ${end} vs ${b.box.x}`);
});

// CV1 (the in-house dev, 2026-11-27, LD344 §1.1): "a flowchart on a blank canvas that can be zoomed and scrolled both
// ways, like OneNote". Each thing is a box, each link an arrow the way it went, and the camera is plain code here.
it('CV1: each thing is a box that holds its dot and reaches its column\'s link edge (a flowchart, not a scatter)', () => {
  const L = core.layered(nodes, edges, { cap: 50 });
  for (const p of L.placed) {
    const lv = L.levels[p.level];
    assert.ok(p.box && p.box.x < p.x - p.r, `box ${p.id} starts left of its dot`);
    assert.ok(Math.abs(p.box.x + p.box.w - (lv.x + lv.width - 10)) < 0.11, `box ${p.id} ends at the link edge`);
    assert.ok(p.box.y < p.y && p.box.y + p.box.h > p.y && p.box.h > 8, `box ${p.id} holds its row`);
  }
  const rows = L.placed.filter((p) => p.level === 0).sort((a, b) => a.y - b.y);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].box.y >= rows[i - 1].box.y + rows[i - 1].box.h, 'boxes in a column do not overlap');
});

it('CV1: an arrow points the way the link went: forward to the right, back to the left, and within a level from its source', () => {
  const L = core.layered(nodes, edges.concat([{ from: 4, to: 2 }]), { cap: 50 });
  const arrow = (from, to) => L.links.find((l) => l.from === from && l.to === to).arrow;
  assert.strictEqual(arrow(1, 4), 'end', 'read to changed: drawn left to right, the arrow at the end');
  assert.strictEqual(arrow(4, 2), 'start', 'changed to ran: drawn left to right, the arrow at the start, pointing left');
  assert.strictEqual(arrow(4, 3), 'end', 'within one level, drawn from its source');
});

it('CV1: the camera fits the picture\'s width to the canvas, never past full size, keeping the canvas\'s shape', () => {
  const v = core.fitWidth({ width: 960, height: 3000 }, { width: 480, height: 600 }, { maxScale: 1.25 });
  assert.deepStrictEqual([v.x, v.y, v.w, v.h], [0, 0, 960, 1200], 'half size: the whole width shows, the top first');
  const big = core.fitWidth({ width: 960, height: 300 }, { width: 1920, height: 900 }, { maxScale: 1.25 });
  assert.strictEqual(big.w, 1920 / 1.25, 'a small picture is not blown up past 1.25');
  assert.ok(Math.abs(big.w / big.h - 1920 / 900) < 1e-9, "the view keeps the canvas's shape");
  assert.strictEqual(big.x, (960 - big.w) / 2, 'a picture narrower than the canvas sits in its middle, not against the left');
});

it('CV1: zooming keeps the point under the cursor still, and stops at the limits', () => {
  const view = { width: 800, height: 400 };
  const vb = { x: 100, y: 50, w: 800, h: 400 };
  const z = core.zoomAt(vb, 2, 300, 150, view, { min: 0.05, max: 4 });
  assert.deepStrictEqual([z.w, z.h], [400, 200], 'twice as close');
  // The world point (300, 150) sat 1/4 across and 1/4 down; it still does.
  assert.ok(Math.abs((300 - z.x) / z.w - (300 - vb.x) / vb.w) < 1e-9 && Math.abs((150 - z.y) / z.h - (150 - vb.y) / vb.h) < 1e-9);
  const far = core.zoomAt(vb, 1e6, 300, 150, view, { min: 0.05, max: 4 });
  assert.strictEqual(view.width / far.w, 4, 'no closer than 4x');
  const out = core.zoomAt(vb, 1e-6, 300, 150, view, { min: 0.05, max: 4 });
  assert.ok(Math.abs(view.width / out.w - 0.05) < 1e-12, 'no further than 0.05x');
});

it('CV1: the camera pans both ways, and at the picture\'s edge it stops and says so, so the page can scroll on', () => {
  const content = { x0: 0, y0: 0, x1: 960, y1: 2000 };
  const vb = { x: 0, y: 0, w: 400, h: 300 };
  const right = core.panBy(vb, 120, 0, content);
  assert.deepStrictEqual([right.vb.x, right.vb.y, right.moved], [120, 0, true], 'sideways');
  const down = core.panBy(vb, 0, 90, content);
  assert.deepStrictEqual([down.vb.x, down.vb.y, down.moved], [0, 90, true], 'down');
  const up = core.panBy(vb, 0, -100000, content);
  assert.strictEqual(up.vb.y, -150, "up until the canvas's middle meets the picture's top edge");
  assert.strictEqual(core.panBy(up.vb, 0, -10, content).moved, false, 'and no further: the wheel goes back to the page');
  const end = core.panBy(vb, 0, 100000, content);
  assert.strictEqual(end.vb.y, 2000 - 150, "down until the canvas's middle meets the picture's bottom edge");
  assert.deepStrictEqual(core.panBy(vb, 0, 0, content).vb, vb, 'not moved, not changed');
});

it('HTML1: "Flagged" adds linked things only while they do not swamp it (860f51e9: 104 of 106 shown)', () => {
  const many = [node(0, 'write', 'src/f.js', 1, 'undisclosed')];
  const links = [];
  for (let i = 1; i < 40; i++) { many.push(node(i, 'read', `src/r${i}.js`, 1)); links.push({ from: i, to: 0 }); }
  const dense = core.flaggedView(many, links, { grow: 3 });
  assert.deepStrictEqual(dense.ids, [0], 'flagged only: its 39 links would swamp it');
  assert.strictEqual(dense.withLinks, false);
  const small = core.flaggedView(many.slice(0, 3), links.slice(0, 2), { grow: 3 });
  assert.deepStrictEqual(small.ids, [0, 1, 2], 'a few linked things come along');
  assert.strictEqual(small.withLinks, true);
  assert.deepStrictEqual(core.flaggedView([node(0, 'read', 'a.js', 1)], [], {}).ids, [], 'nothing flagged, nothing in the view');
  // 860f51e9's shape: 38 of 106 flagged, the other 68 each linked to one of them: within 3x, but the whole graph.
  const big = [];
  const bigLinks = [];
  for (let i = 0; i < 106; i++) big.push(node(i, i < 38 ? 'write' : 'read', `src/f${i}.js`, 1, i < 38 ? 'undisclosed' : null));
  for (let i = 38; i < 106; i++) bigLinks.push({ from: i, to: i % 38 });
  const v = core.flaggedView(big, bigLinks, { grow: 3 });
  assert.strictEqual(v.withLinks, false, 'flagged and linked would be 106 of 106');
  assert.strictEqual(v.ids.length, 38);
});

it('HTML1: the Tree shares the Graph\'s folders: one folder and one file, however each was written', () => {
  const two = [node(0, 'write', '~/tools/proj/test/c.js', 1), node(1, 'write', 'test/c.js', 4), node(2, 'read', '~/tools/proj/README.md', 1)];
  const f = core.folders(two);
  assert.strictEqual(f.folder.get(0), 'test');
  assert.strictEqual(f.folder.get(2), '.');
  assert.strictEqual(f.repOf(0), 1, 'the most touched spelling stands for both');
});

it('HTML1: the Timeline folds touches of one thing in a row into one line with a count', () => {
  const trail = [{ turn: 't1', node: 3 }, { turn: 't1', node: 3 }, { turn: 't1', node: 4 }, { turn: 't1', node: 3 }, { turn: 't2', node: 3 }];
  assert.deepStrictEqual(core.runs(trail).map((r) => [r.turn, r.node, r.count, r.first]), [['t1', 3, 2, 0], ['t1', 4, 1, 2], ['t1', 3, 1, 3], ['t2', 3, 1, 4]]);
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
  // CV1: on the canvas nothing is held back (the fixed picture showed 60 rows a level), and the camera is the core's.
  assert.ok(scripts[0].includes('cap: Infinity'), 'no cap on the canvas');
  for (const fn of ['fitWidth(', 'zoomAt(', 'panBy(']) assert.ok(scripts[0].includes('orunmilaGraph2DCore.' + fn), 'the page moves with the core camera: ' + fn);
  assert.ok(html.includes('id="gv-canvas"') && html.includes('id="gv-zfull"'), 'a canvas box with a full-screen button');
  new vm.Script(scripts[0], { filename: 'trail-page.js' });
});

runAll('graph2d');
