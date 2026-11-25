'use strict';

/**
 * test/graph3d.js — V3D (LD300 (2)): the trail page's 3D Map, Orunmila's own WebGL2 code shipped in the package, with
 * no library and no internet. The page code runs in a browser; what can be held here is held here:
 *
 *   - the layout (our own 3D force layout with a Barnes-Hut octree) is the same on every load, finite, and pulls
 *     linked things closer than unlinked ones;
 *   - the octree's repulsion agrees with the exact pairwise sum;
 *   - the replay (the "tracking") walks the session's touches in order, one step per touch, and marks each new turn;
 *   - the camera's projection puts the point it looks at in the middle of the screen;
 *   - every shader is GLSL ES 3.00, and the page's whole script, with the engine inside it, parses as JavaScript.
 *
 * The pixels are checked in a real browser by scripts/graph3d-shot.js (not part of npm test).
 */

const vm = require('vm');
const { assert, it, runAll } = require('./helpers');
const g3 = require('../src/render/graph3d');
const { buildVizData, renderTrailVisual } = require('../src/render/trail-visual');

const core = g3.core();

function graph(n, links) {
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: i, touches: 1 + (i % 5) });
  return { nodes, edges: links.map(([a, b]) => ({ from: a, to: b })) };
}

/** A small seeded graph: two dense clusters of 12, one bridge, and loose singles. */
function clusters() {
  const links = [];
  for (let c = 0; c < 2; c++) for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if ((i * 7 + j * 3) % 4 === 0) links.push([c * 12 + i, c * 12 + j]);
  links.push([0, 12]);
  return graph(30, links);
}

it('V3D: the layout is the same on every load and every coordinate is finite', () => {
  const g = clusters();
  const a = core.layout(g.nodes.length, g.edges, { seed: 7, steps: 300 });
  const b = core.layout(g.nodes.length, g.edges, { seed: 7, steps: 300 });
  assert.strictEqual(a.length, g.nodes.length * 3);
  assert.deepStrictEqual(Array.from(a), Array.from(b), 'two loads, one layout');
  for (const v of a) assert.ok(Number.isFinite(v), `finite: ${v}`);
});

it('V3D: linked things sit closer together than unlinked ones', () => {
  const g = clusters();
  const p = core.layout(g.nodes.length, g.edges, { seed: 3, steps: 400 });
  const d = (i, j) => Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
  const linked = new Set(g.edges.map((e) => `${e.from}-${e.to}`));
  let ls = 0, ln = 0, us = 0, un = 0;
  for (let i = 0; i < 30; i++) for (let j = i + 1; j < 30; j++) {
    if (linked.has(`${i}-${j}`)) { ls += d(i, j); ln++; } else { us += d(i, j); un++; }
  }
  assert.ok(ln > 20, `links: ${ln}`);
  assert.ok(ls / ln < 0.6 * (us / un), `linked mean ${(ls / ln).toFixed(1)} vs unlinked mean ${(us / un).toFixed(1)}`);
});

it('V3D: a thing with no links settles near the graph, not thrown out by its push (the 860f51e9 shape: 2 of 124 unlinked)', () => {
  // As dense as that session's map (5,551 links on 122 things, against its 5,490 on 124). Measured: the unlinked two
  // sit at 2.41 times the median distance with the reach limit, 6.68 without it.
  const links = [];
  for (let i = 0; i < 122; i++) for (let j = i + 1; j < 122; j++) if ((i + j) % 4 !== 0) links.push([i, j]);
  const g = graph(124, links);
  const p = core.layout(124, g.edges, { seed: 5, steps: 300 });
  const c = [0, 1, 2].map((k) => { let s = 0; for (let i = 0; i < 124; i++) s += p[i * 3 + k]; return s / 124; });
  const r = []; for (let i = 0; i < 124; i++) r.push(Math.hypot(p[i * 3] - c[0], p[i * 3 + 1] - c[1], p[i * 3 + 2] - c[2]));
  const median = r.slice().sort((a, b) => a - b)[62];
  assert.ok(Math.max(r[122], r[123]) < 4 * median, `unlinked at ${r[122].toFixed(0)}, ${r[123].toFixed(0)}; median ${median.toFixed(0)}`);
});

it("V3D: the octree's repulsion agrees with the exact pairwise sum (theta 0.5, within 5%)", () => {
  let s = 99;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const n = 300;
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = (rnd() - 0.5) * 400;
  const approx = new Float64Array(n * 3);
  const exact = new Float64Array(n * 3);
  core.repulse(pos, n, approx, { strength: 60, theta: 0.5 });
  core.repulse(pos, n, exact, { strength: 60, theta: 0 });
  let err = 0, mag = 0;
  for (let i = 0; i < n * 3; i++) { err += (approx[i] - exact[i]) ** 2; mag += exact[i] ** 2; }
  assert.ok(mag > 0, 'forces were computed');
  assert.ok(Math.sqrt(err / mag) < 0.05, `relative error ${Math.sqrt(err / mag).toFixed(4)}`);
});

it('V3D: the replay walks every touch in order and marks each new turn', () => {
  const trail = [
    { turn: 't1', node: 0 }, { turn: 't1', node: 2 }, { turn: 't1', node: 2 },
    { turn: 't2', node: 1 }, { turn: 't3', node: 0 },
  ];
  const steps = core.replaySteps(trail);
  assert.deepStrictEqual(steps.map((x) => x.node), [0, 2, 2, 1, 0]);
  assert.deepStrictEqual(steps.map((x) => x.from), [-1, 0, 2, 2, 1], 'each step flies from the one before');
  assert.deepStrictEqual(steps.map((x) => x.newTurn), [true, false, false, true, true]);
  assert.deepStrictEqual(core.replaySteps([]), []);
});

it('V3D3: the replay builds from a blank canvas: a link appears when its second end does, growing from the older end', () => {
  const steps = core.replaySteps([{ turn: 't1', node: 2 }, { turn: 't1', node: 0 }, { turn: 't1', node: 2 }, { turn: 't2', node: 1 }]);
  const first = core.firstSeen(4, steps);
  assert.deepStrictEqual(first, [1, 3, 0, -1], 'node 3 is never touched, so never shown');
  const links = core.revealLinks([{ from: 0, to: 2 }, { from: 2, to: 0 }, { from: 1, to: 0 }, { from: 3, to: 0 }, { from: 1, to: 1 }], first);
  assert.deepStrictEqual(links, [{ a: 2, b: 0, step: 1 }, { a: 0, b: 1, step: 3 }], 'one link per pair, none to an untouched thing or to itself; each from its older end, at its newer end\'s step');
});

it('V3D: the camera looks at its target, and the target lands in the middle of the screen', () => {
  const m = core.viewProj({ target: [10, -4, 3], yaw: 0.7, pitch: 0.3, dist: 200 }, 1.6, 0.9);
  const [x, y, z, w] = core.transform(m, [10, -4, 3, 1]);
  assert.ok(Math.abs(x / w) < 1e-9 && Math.abs(y / w) < 1e-9, `centre: ${x / w}, ${y / w}`);
  assert.ok(z / w > -1 && z / w < 1, `inside the depth range: ${z / w}`);
  const behind = core.transform(m, [10, -4, 3 + 0, 1]);
  assert.ok(behind[3] > 0, 'in front of the camera');
});

it('V3D2: the map opens calm (O: "the default ... looks too much, blinding"), and Vivid is a switch away', () => {
  const looks = core.looks();
  assert.strictEqual(core.DEFAULT_LOOK, 'calm');
  assert.deepStrictEqual(Object.keys(looks).sort(), ['calm', 'vivid']);
  for (const k of ['glow', 'light', 'sparkle', 'dust', 'exposure']) {
    assert.ok(looks.calm[k] < looks.vivid[k], `${k}: calm ${looks.calm[k]} below vivid ${looks.vivid[k]}`);
  }
  assert.ok(looks.calm.glow <= 0.4, `calm glow ${looks.calm.glow}`);
  const src = g3.source();
  assert.ok(src.includes('data-g3look="calm"') && src.includes('data-g3look="vivid"'), 'the switch is on the page');
});

it('V3D: every shader is GLSL ES 3.00 with a main()', () => {
  const shaders = g3.shaders();
  const names = Object.keys(shaders);
  assert.ok(names.length >= 6, names.join(', '));
  for (const k of names) {
    assert.ok(shaders[k].startsWith('#version 300 es\n'), `${k} starts with the version line`);
    assert.ok(/void\s+main\s*\(\s*\)/.test(shaders[k]), `${k} has main()`);
  }
});

it("V3D: the trail page has the 3D Map tab, and its whole script, the engine inside it, parses", () => {
  const model = {
    session_id: 's1',
    artifacts: [{ key: 'a', label: 'a.js', path: 'src/a.js', channels: ['write'], touch_count: 3 }, { key: 'b', label: 'b.js', path: 'src/b.js', channels: ['read'], touch_count: 1 }],
    turns: [{ turn_id: 't1', prompt: 'p', edges: [{ from: 'b', to: 'a', kind: 'informed' }], trail: [{ key: 'b', channel: 'read', path: 'src/b.js' }, { key: 'a', channel: 'write', path: 'src/a.js' }] }],
  };
  const html = renderTrailVisual(buildVizData(model, new Map(), []));
  assert.ok(html.includes('<button class="gv-tab" data-view="map3d">3D Map</button>'), 'the tab');
  assert.ok(html.includes('<div class="gv-view" data-view="map3d" id="gv-map3d"></div>'), 'its view');
  assert.ok(html.includes('map3d:renderMap3D'), 'its renderer');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1);
  assert.ok(scripts[0].includes('orunmilaGraph3D'), 'the engine is in the page');
  new vm.Script(scripts[0], { filename: 'trail-page.js' });
});

runAll('graph3d');
