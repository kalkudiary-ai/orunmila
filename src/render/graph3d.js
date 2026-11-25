// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/* global orunmilaGraph3DCore, orunmilaGraph3DShaders, document, window, requestAnimationFrame, cancelAnimationFrame,
   performance, ResizeObserver, IntersectionObserver */

/**
 * graph3d.js — the trail page's 3D Map (V3D, LD300 (2); O, 2026-11-25: "the best, up to date, 2026 version, glow,
 * sparkles, tracking").
 *
 * Orunmila's own WebGL2 code, shipped in the package: no library, no internet (NI1, LD264). The tab it replaces
 * (removed by NI1) loaded 3d-force-graph from a CDN at run time.
 *
 * Three parts, each a plain function whose source is put into the page (`source()`), so the page needs nothing else:
 *
 *   core()     pure math, also run by test/graph3d.js: a seeded 3D force layout with a Barnes-Hut octree (the same
 *              layout on every load), the replay's steps, and column-major matrices for WebGL.
 *   shaders()  GLSL ES 3.00: sphere impostors with a bright emissive core and fresnel rim, selection halos, ribbon
 *              links shaded end to end, sparkles that flow along each link, drifting dust with depth fog, and a
 *              post chain: soft-threshold bright pass, dual-filter (Kawase) bloom over six levels, ACES tone
 *              mapping, vignette and grain.
 *   main(env)  the tab in the browser: orbit, pan, zoom and fly-to with inertia; hover, click and keyboard; labels;
 *              the page's filters and search; the replay ("tracking": the session's touches in order, a comet from
 *              one thing to the next, the camera following); glow, sparkles, dust, spin and label switches; snapshot
 *              and fullscreen. It renders into a half-float target when the browser has one (8-bit otherwise),
 *              with 4x MSAA where supported, lowers its resolution when frames are slow, pauses when hidden, and
 *              honours prefers-reduced-motion. Without WebGL2 it says so and points to the 2D Graph tab.
 *
 * What differs by OS: nothing in this file touches the file system or processes. The browser's GPU path does differ
 * (ANGLE over Direct3D 11 on Windows, Metal on macOS, Mesa or a vendor driver on Linux): half-float render targets
 * and MSAA are each probed and fall back, never assumed.
 */

function core() {
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    let h = 2166136261;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Repulsion between every pair of points, added into `out`: strength * (pi - pj) / |pi - pj|^2 on i (a 1/d force,
   * as d3's many-body). theta 0 is the exact pairwise sum; theta > 0 uses a Barnes-Hut octree.
   */
  function repulse(pos, n, out, opts) {
    const k = opts.strength;
    const theta = opts.theta || 0;
    // Past distanceMax two things no longer push apart (d3's distanceMax), so a thing with no links settles near the
    // edge of the graph instead of being thrown out by the whole cluster's push.
    const dmax2 = opts.distanceMax ? opts.distanceMax * opts.distanceMax : Infinity;
    if (n < 2) return;
    if (!theta) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = pos[i * 3] - pos[j * 3];
          const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
          const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > dmax2) continue;
          const f = k / Math.max(d2, 1);
          out[i * 3] += dx * f;
          out[i * 3 + 1] += dy * f;
          out[i * 3 + 2] += dz * f;
          out[j * 3] -= dx * f;
          out[j * 3 + 1] -= dy * f;
          out[j * 3 + 2] -= dz * f;
        }
      }
      return;
    }
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (z < minz) minz = z;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      if (z > maxz) maxz = z;
    }
    const half = Math.max(maxx - minx, maxy - miny, maxz - minz) / 2 + 1e-6;
    const node = (x, y, z, h) => ({ x, y, z, h, body: -1, bodies: null, kids: null, m: 0, cx: 0, cy: 0, cz: 0 });
    const root = node((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2, half);
    const insert = (nd, i, depth) => {
      for (;;) {
        if (nd.kids === null) {
          if (nd.bodies) {
            nd.bodies.push(i);
            return;
          }
          if (nd.body === -1) {
            nd.body = i;
            return;
          }
          if (depth > 24) {
            nd.bodies = [nd.body, i];
            nd.body = -1;
            return;
          }
          const old = nd.body;
          nd.body = -1;
          nd.kids = [null, null, null, null, null, null, null, null];
          insert(childFor(nd, old), old, depth + 1);
        }
        nd = childFor(nd, i);
        depth++;
      }
    };
    const childFor = (nd, i) => {
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      const o = (px > nd.x ? 1 : 0) | (py > nd.y ? 2 : 0) | (pz > nd.z ? 4 : 0);
      if (!nd.kids[o]) {
        const h = nd.h / 2;
        nd.kids[o] = node(nd.x + (o & 1 ? h : -h), nd.y + (o & 2 ? h : -h), nd.z + (o & 4 ? h : -h), h);
      }
      return nd.kids[o];
    };
    for (let i = 0; i < n; i++) insert(root, i, 0);
    const mass = (nd) => {
      if (nd.kids) {
        for (const c of nd.kids) {
          if (!c) continue;
          mass(c);
          nd.m += c.m;
          nd.cx += c.cx * c.m;
          nd.cy += c.cy * c.m;
          nd.cz += c.cz * c.m;
        }
      } else {
        const list = nd.bodies || (nd.body >= 0 ? [nd.body] : []);
        for (const b of list) {
          nd.m++;
          nd.cx += pos[b * 3];
          nd.cy += pos[b * 3 + 1];
          nd.cz += pos[b * 3 + 2];
        }
      }
      if (nd.m) {
        nd.cx /= nd.m;
        nd.cy /= nd.m;
        nd.cz /= nd.m;
      }
    };
    mass(root);
    const t2 = theta * theta;
    const walk = (nd, i) => {
      if (!nd.m) return;
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      if (!nd.kids) {
        const list = nd.bodies || [nd.body];
        for (const b of list) {
          if (b === i) continue;
          const dx = px - pos[b * 3], dy = py - pos[b * 3 + 1], dz = pz - pos[b * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > dmax2) continue;
          const f = k / Math.max(d2, 1);
          out[i * 3] += dx * f;
          out[i * 3 + 1] += dy * f;
          out[i * 3 + 2] += dz * f;
        }
        return;
      }
      const dx = px - nd.cx, dy = py - nd.cy, dz = pz - nd.cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const w = nd.h * 2;
      if (d2 > 0 && (w * w) / d2 < t2) {
        if (d2 > dmax2) return;
        const f = (k * nd.m) / Math.max(d2, 1);
        out[i * 3] += dx * f;
        out[i * 3 + 1] += dy * f;
        out[i * 3 + 2] += dz * f;
        return;
      }
      for (const c of nd.kids) if (c) walk(c, i);
    };
    for (let i = 0; i < n; i++) walk(root, i);
  }

  /** A force layout run a step at a time (the page spreads steps over frames); seeded, so every load is the same. */
  function createLayout(n, edges, opts) {
    opts = opts || {};
    const rand = rng(opts.seed == null ? 1 : opts.seed);
    const pos = new Float64Array(n * 3);
    const vel = new Float64Array(n * 3);
    const force = new Float64Array(n * 3);
    const R = 30 * Math.cbrt(Math.max(n, 1));
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = n > 1 ? 1 - (i / (n - 1)) * 2 : 0;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const s = R * (0.6 + 0.4 * rand());
      pos[i * 3] = Math.cos(golden * i) * r * s;
      pos[i * 3 + 1] = y * s;
      pos[i * 3 + 2] = Math.sin(golden * i) * r * s;
    }
    const deg = new Float64Array(n);
    const links = [];
    for (const e of edges || []) {
      const a = e.from, b = e.to;
      if (!(a >= 0 && a < n && b >= 0 && b < n) || a === b) continue;
      links.push(a, b);
      deg[a]++;
      deg[b]++;
    }
    const charge = opts.charge || 140;
    const dist = opts.linkDistance || 26;
    const reach = opts.distanceMax || dist * 9;
    const alphaMin = 0.002;
    const decay = 1 - Math.pow(alphaMin, 1 / 300);
    const L = {
      pos,
      alpha: 1,
      steps: 0,
      done() {
        return L.alpha < alphaMin;
      },
      step() {
        force.fill(0);
        repulse(pos, n, force, { strength: charge, theta: 0.8, distanceMax: reach });
        for (let k = 0; k < links.length; k += 2) {
          const a = links[k], b = links[k + 1];
          const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const s = (((d - dist) / d) * 0.9) / Math.min(deg[a], deg[b]);
          const bias = deg[a] / (deg[a] + deg[b]);
          force[b * 3] -= dx * s * bias;
          force[b * 3 + 1] -= dy * s * bias;
          force[b * 3 + 2] -= dz * s * bias;
          force[a * 3] += dx * s * (1 - bias);
          force[a * 3 + 1] += dy * s * (1 - bias);
          force[a * 3 + 2] += dz * s * (1 - bias);
        }
        for (let i = 0; i < n * 3; i++) {
          force[i] -= pos[i] * 0.012;
          vel[i] = (vel[i] + force[i] * L.alpha) * 0.6;
          pos[i] += vel[i];
        }
        L.alpha -= L.alpha * decay;
        L.steps++;
      },
    };
    return L;
  }

  function layout(n, edges, opts) {
    const L = createLayout(n, edges, opts);
    const steps = (opts && opts.steps) || 300;
    for (let i = 0; i < steps; i++) L.step();
    return L.pos;
  }

  /** The replay's steps: every touch in order, where its comet flies from, and whether it opens a new turn. */
  function replaySteps(trail) {
    const out = [];
    for (let i = 0; i < (trail || []).length; i++) {
      const r = trail[i];
      const prev = i ? trail[i - 1] : null;
      out.push({ i, node: r.node, from: prev ? prev.node : -1, turn: r.turn, newTurn: !prev || prev.turn !== r.turn, channel: r.channel, label: r.label, failed: !!r.failed });
    }
    return out;
  }

  /** V3D3: the step at which each thing is first touched (-1: never, so the replay never shows it). */
  function firstSeen(n, steps) {
    const f = new Array(n).fill(-1);
    (steps || []).forEach((s, k) => {
      if (s.node >= 0 && s.node < n && f[s.node] < 0) f[s.node] = k;
    });
    return f;
  }

  /**
   * V3D3 (O, 2026-11-25: "the replay to start from a blank canvas and visually create those connections"): each link
   * between two touched things, once per pair, appearing at the step its second end appears and growing from the
   * end that appeared first.
   */
  function revealLinks(edges, first) {
    const out = [];
    const seen = new Set();
    for (const e of edges || []) {
      const a = e.from, b = e.to;
      if (a === b || !(first[a] >= 0) || !(first[b] >= 0)) continue;
      const key = a < b ? a + '-' + b : b + '-' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const older = first[a] <= first[b] ? a : b;
      out.push({ a: older, b: older === a ? b : a, step: Math.max(first[a], first[b]) });
    }
    return out;
  }

  // Column-major 4x4 matrices, as WebGL reads them.
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  }
  function transform(m, v) {
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  }
  function norm3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
  function eye(cam) {
    const cp = Math.cos(cam.pitch);
    return [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)];
  }
  function view(cam) {
    const e = eye(cam);
    const z = norm3([e[0] - cam.target[0], e[1] - cam.target[1], e[2] - cam.target[2]]);
    const x = norm3(cross([0, 1, 0], z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1];
  }
  function viewProj(cam, aspect, fovy) {
    const near = Math.max(0.5, cam.dist * 0.02);
    const far = cam.dist * 6 + 4000;
    return mul(perspective(fovy, aspect, near, far), view(cam));
  }

  // The two looks (O, 2026-11-25: the default "looks too much, blinding infact, can that also be toggle controlled?").
  // Calm is the default: every source of light turned down together. Vivid is the first build's look.
  const DEFAULT_LOOK = 'calm';
  function looks() {
    return {
      calm: { glow: 0.3, light: 0.5, sparkle: 0.45, dust: 0.5, exposure: 0.9 },
      vivid: { glow: 1.15, light: 1, sparkle: 1, dust: 1, exposure: 1.05 },
    };
  }

  return { rng, hashString, repulse, createLayout, layout, replaySteps, firstSeen, revealLinks, mul, transform, perspective, view, viewProj, eye, looks, DEFAULT_LOOK };
}

function shaders() {
  const V = '#version 300 es\n';
  const F = '#version 300 es\nprecision highp float;\n';
  const quad = V + 'out vec2 vUV;\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';
  return {
    nodeVS:
      V +
      [
        'layout(location=0) in vec2 aCorner;',
        'layout(location=1) in vec3 iPos;',
        'layout(location=2) in vec3 iColor;',
        'layout(location=3) in vec4 iParams;',
        'uniform mat4 uViewProj; uniform vec3 uRight; uniform vec3 uUp; uniform float uPass;',
        'out vec2 vUV; out vec3 vColor; out vec4 vParams; out float vDepth;',
        'void main(){',
        '  float grow = uPass > 0.5 ? 2.2 : 1.0;',
        '  vUV = aCorner * grow;',
        '  vec3 w = iPos + (uRight * aCorner.x + uUp * aCorner.y) * iParams.x * grow;',
        '  vec4 c = uViewProj * vec4(w, 1.0);',
        '  gl_Position = c; vColor = iColor; vParams = iParams; vDepth = c.w;',
        '}',
      ].join('\n'),
    nodeFS:
      F +
      [
        'in vec2 vUV; in vec3 vColor; in vec4 vParams; in float vDepth;',
        'uniform float uPass; uniform float uTime; uniform float uMotion; uniform vec3 uFog; uniform vec2 uFogRange; uniform float uLight;',
        'out vec4 o;',
        'void main(){',
        '  float r2 = dot(vUV, vUV);',
        '  float hl = clamp(vParams.y, 0.0, 1.0); float dim = vParams.z; float flag = vParams.w;',
        '  float pulse = flag * (0.5 + 0.5 * sin(uTime * 3.2 + vParams.x * 1.7)) * uMotion;',
        '  float fog = smoothstep(uFogRange.x, uFogRange.y, vDepth);',
        '  if (uPass < 0.5) {',
        '    if (r2 > 1.0) discard;',
        '    vec3 n = vec3(vUV, sqrt(1.0 - r2));',
        '    vec3 L = normalize(vec3(-0.45, 0.6, 0.66));',
        '    float diff = max(dot(n, L), 0.0);',
        '    float rim = pow(1.0 - n.z, 2.4);',
        '    float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 56.0);',
        '    vec3 col = vColor * (0.14 + 0.5 * diff) + (vColor * rim * (1.5 + 1.6 * hl) + vec3(spec) * 0.85) * uLight;',
        '    col += vColor * (0.32 * uLight + 1.1 * pulse * uLight + 0.9 * hl) * smoothstep(1.0, 0.0, r2);',
        '    col *= 1.0 - 0.84 * dim;',
        '    o = vec4(mix(col, uFog, fog * 0.85), 1.0);',
        '  } else {',
        '    float r = sqrt(r2);',
        '    if (r < 0.97) discard;',
        '    float glow = exp(-(r - 1.0) * 3.2) * ((0.2 + 0.55 * pulse) * uLight + 0.45 * hl);',
        '    float ring = hl * smoothstep(0.1, 0.0, abs(r - 1.55)) * 1.7;',
        '    float a = (glow + ring) * (1.0 - 0.86 * dim) * (1.0 - fog);',
        '    if (a < 0.003) discard;',
        '    o = vec4(vColor * a, 1.0);',
        '  }',
        '}',
      ].join('\n'),
    lineVS:
      V +
      [
        'layout(location=0) in vec2 aQuad;',
        'layout(location=1) in vec3 iA; layout(location=2) in vec3 iB;',
        'layout(location=3) in vec3 iCA; layout(location=4) in vec3 iCB;',
        'layout(location=5) in vec2 iParams;',
        'uniform mat4 uViewProj; uniform vec2 uViewport;',
        'out vec3 vColor; out float vSide; out float vAlpha; out float vDepth;',
        'void main(){',
        '  vec4 a = uViewProj * vec4(iA, 1.0); vec4 b = uViewProj * vec4(iB, 1.0);',
        '  vec4 p = mix(a, b, aQuad.x);',
        '  vec2 sa = a.xy / max(a.w, 1e-4); vec2 sb = b.xy / max(b.w, 1e-4);',
        '  vec2 d = (sb - sa) * uViewport; float len = length(d);',
        '  d = len > 1e-5 ? d / len : vec2(1.0, 0.0);',
        '  p.xy += vec2(-d.y, d.x) * aQuad.y * iParams.y / uViewport * p.w;',
        '  gl_Position = p; vColor = mix(iCA, iCB, aQuad.x); vSide = aQuad.y; vAlpha = iParams.x; vDepth = p.w;',
        '}',
      ].join('\n'),
    lineFS:
      F +
      [
        'in vec3 vColor; in float vSide; in float vAlpha; in float vDepth;',
        'uniform vec2 uFogRange;',
        'out vec4 o;',
        'void main(){',
        '  float e = max(1.0 - vSide * vSide, 0.0);',
        '  float a = vAlpha * e * sqrt(e) * (1.0 - 0.8 * smoothstep(uFogRange.x, uFogRange.y, vDepth));',
        '  o = vec4(vColor * a, 1.0);',
        '}',
      ].join('\n'),
    sparkVS:
      V +
      [
        'layout(location=0) in float aZero;',
        'layout(location=1) in vec3 iA; layout(location=2) in vec3 iB; layout(location=3) in vec3 iC;',
        'layout(location=4) in vec4 iP;',
        'uniform mat4 uViewProj; uniform float uTime; uniform float uScale; uniform float uSparkle;',
        'out vec3 vColor; out float vI;',
        'void main(){',
        '  float t = fract(iP.x + uTime * iP.y);',
        '  vec4 c = uViewProj * vec4(mix(iA, iB, t), 1.0);',
        '  gl_Position = c + vec4(aZero);',
        '  gl_PointSize = clamp(iP.z * uScale / max(c.w, 1e-3), 1.5, 48.0);',
        '  vColor = iC; vI = iP.w * uSparkle * smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.82, t);',
        '}',
      ].join('\n'),
    motesVS:
      V +
      [
        'layout(location=0) in vec4 aPos;',
        'uniform mat4 uViewProj; uniform float uTime; uniform float uScale; uniform float uMotion; uniform float uDust;',
        'out vec3 vColor; out float vI;',
        'void main(){',
        '  float s = aPos.w;',
        '  vec3 p = aPos.xyz + sin(vec3(1.3, 2.1, 0.7) * s + uTime * 0.06 * uMotion) * 9.0;',
        '  vec4 c = uViewProj * vec4(p, 1.0);',
        '  gl_Position = c;',
        '  gl_PointSize = clamp(2.4 * uScale / max(c.w, 1e-3), 1.0, 6.0);',
        '  vColor = mix(vec3(0.35, 0.55, 1.0), vec3(0.75, 0.6, 1.0), fract(s * 7.31));',
        '  vI = (0.16 + 0.12 * sin(uTime * 1.7 * uMotion + s * 10.0)) * uDust * smoothstep(9000.0, 200.0, c.w);',
        '}',
      ].join('\n'),
    pointsVS:
      V +
      [
        'layout(location=0) in vec3 aPos; layout(location=1) in vec3 aColor; layout(location=2) in vec2 aSI;',
        'uniform mat4 uViewProj; uniform float uScale;',
        'out vec3 vColor; out float vI;',
        'void main(){',
        '  vec4 c = uViewProj * vec4(aPos, 1.0);',
        '  gl_Position = c;',
        '  gl_PointSize = clamp(aSI.x * uScale / max(c.w, 1e-3), 1.5, 96.0);',
        '  vColor = aColor; vI = aSI.y;',
        '}',
      ].join('\n'),
    pointFS:
      F +
      [
        'in vec3 vColor; in float vI;',
        'out vec4 o;',
        'void main(){',
        '  float d = length(gl_PointCoord - 0.5) * 2.0;',
        '  if (d > 1.0) discard;',
        '  float a = exp(-d * d * 4.5);',
        '  float core = smoothstep(0.38, 0.0, d);',
        '  o = vec4((vColor * a + vec3(1.0) * core * 0.9) * vI, 1.0);',
        '}',
      ].join('\n'),
    quadVS: quad,
    brightFS:
      F +
      [
        'in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;',
        'out vec4 o;',
        'void main(){',
        '  vec3 c = (texture(uTex, vUV + uTexel * vec2(-0.5, -0.5)).rgb + texture(uTex, vUV + uTexel * vec2(0.5, -0.5)).rgb',
        '          + texture(uTex, vUV + uTexel * vec2(-0.5, 0.5)).rgb + texture(uTex, vUV + uTexel * vec2(0.5, 0.5)).rgb) * 0.25;',
        // One NaN or Inf pixel would spread through every bloom level; it stops here.
        '  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);',
        '  c = min(c, vec3(64.0));',
        '  float br = max(c.r, max(c.g, c.b));',
        '  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);',
        '  soft = soft * soft / (4.0 * uKnee + 1e-4);',
        '  o = vec4(c * max(soft, br - uThreshold) / max(br, 1e-4), 1.0);',
        '}',
      ].join('\n'),
    downFS:
      F +
      [
        'in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;',
        'out vec4 o;',
        'void main(){',
        '  vec2 h = uTexel;',
        '  vec3 s = texture(uTex, vUV).rgb * 4.0;',
        '  s += texture(uTex, vUV - h).rgb + texture(uTex, vUV + h).rgb;',
        '  s += texture(uTex, vUV + vec2(h.x, -h.y)).rgb + texture(uTex, vUV - vec2(h.x, -h.y)).rgb;',
        '  o = vec4(s / 8.0, 1.0);',
        '}',
      ].join('\n'),
    upFS:
      F +
      [
        'in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;',
        'out vec4 o;',
        'void main(){',
        '  vec2 h = uTexel;',
        '  vec3 s = texture(uTex, vUV + vec2(-h.x * 2.0, 0.0)).rgb + texture(uTex, vUV + vec2(h.x * 2.0, 0.0)).rgb;',
        '  s += texture(uTex, vUV + vec2(0.0, -h.y * 2.0)).rgb + texture(uTex, vUV + vec2(0.0, h.y * 2.0)).rgb;',
        '  s += (texture(uTex, vUV + vec2(-h.x, h.y)).rgb + texture(uTex, vUV + vec2(h.x, h.y)).rgb) * 2.0;',
        '  s += (texture(uTex, vUV + vec2(-h.x, -h.y)).rgb + texture(uTex, vUV + vec2(h.x, -h.y)).rgb) * 2.0;',
        '  o = vec4(s / 12.0, 1.0);',
        '}',
      ].join('\n'),
    compositeFS:
      F +
      [
        'in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom;',
        'uniform float uBloomStrength; uniform float uExposure; uniform float uTime; uniform vec2 uRes;',
        'out vec4 o;',
        'vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
        'void main(){',
        '  vec3 s = texture(uScene, vUV).rgb; vec3 b = texture(uBloom, vUV).rgb;',
        '  if (any(isnan(s)) || any(isinf(s))) s = vec3(0.0);',
        '  if (any(isnan(b)) || any(isinf(b))) b = vec3(0.0);',
        '  vec3 c = min(s, vec3(64.0)) + b * uBloomStrength;',
        '  c = aces(c * uExposure);',
        '  vec2 q = vUV - 0.5;',
        '  c *= 1.0 - smoothstep(0.35, 0.95, length(q * vec2(uRes.x / uRes.y, 1.0)) * 0.9) * 0.55;',
        '  c = pow(c, vec3(1.0 / 2.2));',
        '  float g = fract(sin(dot(vUV * uRes + fract(uTime) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);',
        '  c += (g - 0.5) / 255.0 * 1.5;',
        '  o = vec4(c, 1.0);',
        '}',
      ].join('\n'),
  };
}

/**
 * The tab in the browser. `env` carries the page's data and helpers; returns { pause, resume }.
 *
 * Node cannot run this half (it needs a DOM and WebGL2), so Node's coverage leaves it out, by this marker and nothing
 * else; core() and shaders() above stay counted. It is checked in real browsers instead: scripts/graph3d-shot.js
 * renders a session's trail page and screenshots the 3D Map in Chrome and Firefox, at rest and mid-replay.
 */
/* c8 ignore start */
function main(env) {
  const C = orunmilaGraph3DCore;
  const SH = orunmilaGraph3DShaders;
  const D = env.DATA;
  const el = env.el;
  const N = D.nodes.length;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const FOV = 0.9;
  const opt = { mode: 'all', glow: 1, sparks: true, motes: true, spin: !reduced, labels: true, follow: true, search: '' };
  // The look: Calm by default, Vivid on the switch; the choice is remembered in this browser (and only there).
  const LOOKS = C.looks();
  let saved;
  try {
    saved = window.localStorage.getItem('orunmila.g3.look');
  } catch {
    saved = null;
  }
  function setLook(name) {
    opt.look = LOOKS[name] ? name : C.DEFAULT_LOOK;
    const L = LOOKS[opt.look];
    opt.glow = L.glow;
    opt.light = L.light;
    opt.sparkle = L.sparkle;
    opt.dust = L.dust;
    opt.exposure = L.exposure;
  }
  setLook(saved);

  // ---- the controls ----
  el.innerHTML =
    env.legend() +
    env.renderFilterBar('map3d') +
    '<div class="gv-gctl">' +
    '<button class="gv-gbtn" data-g3mode="flagged">Flagged</button>' +
    '<button class="gv-gbtn on" data-g3mode="all">Everything</button>' +
    '<span class="gv-gcount" id="g3-count"></span>' +
    '<input class="gv-search" id="g3-search" placeholder="Search files…" autocomplete="off">' +
    '<div class="gv-zoom-ctrl"><button id="g3-fit" title="Fit everything (F)">&#9711;</button><button id="g3-shot" title="Save a picture">&#9113;</button><button id="g3-full" title="Fullscreen">&#9974;</button></div>' +
    '</div>' +
    '<div class="g3-wrap" id="g3-wrap" tabindex="0" aria-label="3D map of the session; drag to turn, scroll to zoom, click a sphere for details">' +
    '<canvas class="g3-canvas" id="g3-canvas"></canvas>' +
    '<div class="g3-labels" id="g3-labels"></div>' +
    '<div class="g3-hud">' +
    '<span class="gv-seg g3-look" role="group" aria-label="Look">' +
    '<button data-g3look="calm"' + (opt.look === 'calm' ? ' class="on"' : '') + '>Calm</button>' +
    '<button data-g3look="vivid"' + (opt.look === 'vivid' ? ' class="on"' : '') + '>Vivid</button>' +
    '</span>' +
    '<label>Glow <input type="range" id="g3-glow" min="0" max="250" value="' + Math.round(opt.glow * 100) + '"></label>' +
    '<label><input type="checkbox" id="g3-sparks" checked> Sparkles</label>' +
    '<label><input type="checkbox" id="g3-motes" checked> Dust</label>' +
    '<label><input type="checkbox" id="g3-spin"' + (opt.spin ? ' checked' : '') + '> Spin</label>' +
    '<label><input type="checkbox" id="g3-lbl" checked> Labels</label>' +
    '</div>' +
    '<div class="g3-msg" id="g3-msg" hidden></div>' +
    '</div>' +
    '<div class="g3-replay">' +
    '<button class="gv-gbtn" id="g3-play" title="Replay the session in order (Space)">&#9654; Replay</button>' +
    '<input type="range" id="g3-scrub" min="0" max="' + D.trail.length + '" value="' + D.trail.length + '">' +
    '<select id="g3-speed" title="Replay speed"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option><option value="10">10x</option></select>' +
    '<label><input type="checkbox" id="g3-follow" checked> Follow</label>' +
    '<span class="g3-step" id="g3-step">' + D.trail.length + ' touches in ' + D.turns.length + ' turn(s)</span>' +
    '</div>';
  const $ = (id) => document.getElementById(id);
  const wrap = $('g3-wrap');
  const canvas = $('g3-canvas');
  const labelsEl = $('g3-labels');
  const msg = (text) => {
    const m = $('g3-msg');
    m.hidden = false;
    m.textContent = text;
  };

  // ---- the data ----
  function linear(hex) {
    const h = String(hex || '#888888').replace('#', '');
    const v = h.length === 3 ? h.split('').map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return v.map((x) => Math.pow((x || 0) / 255, 2.2));
  }
  const color = D.nodes.map((n) => linear(env.colorOf(n.stain, n.primaryChannel)));
  const radius = D.nodes.map((n) => Math.min(13, 2.8 + Math.sqrt(n.touches || 0) * 1.9));
  const flagged = D.nodes.map((n) => (n.stain && n.stain !== 'verified' && n.stain !== 'clean' ? 1 : 0));
  const neighbours = D.nodes.map(() => []);
  for (const e of D.edges) {
    if (e.from === e.to || !neighbours[e.from] || !neighbours[e.to]) continue;
    neighbours[e.from].push(e.to);
    neighbours[e.to].push(e.from);
  }
  const L = C.createLayout(N, D.edges, { seed: C.hashString(D.session) });
  // Settle the layout for up to 60 ms before the first frame; the rest runs a few milliseconds a frame.
  const settle0 = performance.now();
  while (!L.done() && performance.now() - settle0 < 60) L.step();
  const P = L.pos;

  let visible = [];
  let visEdges = [];
  const isVis = new Uint8Array(N);
  function recompute() {
    const pass = D.nodes.map((n) => env.nodePassesFilter(n));
    const keep = new Uint8Array(N);
    const stained = D.nodes.some((n, i) => pass[i] && flagged[i]);
    if (opt.mode === 'flagged' && stained && env.flaggedView) {
      // The Graph tab's rule (HTML1): linked things come along only while they do not swamp the view.
      for (const id of env.flaggedView(D.nodes.filter((n, i) => pass[i]), D.edges, { grow: 3 }).ids) keep[id] = 1;
    } else if (opt.mode === 'flagged' && stained) {
      D.nodes.forEach((n, i) => {
        if (pass[i] && flagged[i]) keep[i] = 1;
      });
    } else D.nodes.forEach((n, i) => (keep[i] = pass[i] ? 1 : 0));
    visible = [];
    for (let i = 0; i < N; i++) {
      isVis[i] = keep[i] && pass[i] ? 1 : 0;
      if (isVis[i]) visible.push(i);
    }
    visEdges = D.edges.filter((e) => e.from !== e.to && isVis[e.from] && isVis[e.to]);
    $('g3-count').textContent = visible.length + ' of ' + N + ' things' + (opt.mode === 'flagged' && !stained ? ' · nothing flagged, showing all' : '');
    dirty = true;
  }

  // ---- WebGL2 ----
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  } catch {
    gl = null;
  }
  if (!gl) {
    msg('This browser has 3D (WebGL2) switched off or unavailable. The Graph tab shows the same map in 2D.');
    return { pause() {}, resume() {} };
  }

  let G = null; // GPU objects, rebuilt after a context loss
  function program(vs, fs) {
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    const u = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  function buffer(data, usage) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
    return b;
  }
  function attr(loc, size, stride, offset, divisor) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
    gl.vertexAttribDivisor(loc, divisor || 0);
  }

  function initGL() {
    const g = {};
    g.float = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    g.fmt = g.float ? gl.RGBA16F : gl.RGBA8;
    g.type = g.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    g.node = program(SH.nodeVS, SH.nodeFS);
    g.line = program(SH.lineVS, SH.lineFS);
    g.spark = program(SH.sparkVS, SH.pointFS);
    g.motes = program(SH.motesVS, SH.pointFS);
    g.points = program(SH.pointsVS, SH.pointFS);
    g.bright = program(SH.quadVS, SH.brightFS);
    g.down = program(SH.quadVS, SH.downFS);
    g.up = program(SH.quadVS, SH.upFS);
    g.comp = program(SH.quadVS, SH.compositeFS);

    g.nodeBuf = gl.createBuffer();
    g.nodeVAO = gl.createVertexArray();
    gl.bindVertexArray(g.nodeVAO);
    buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    attr(0, 2, 2, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.nodeBuf);
    attr(1, 3, 10, 0, 1);
    attr(2, 3, 10, 3, 1);
    attr(3, 4, 10, 6, 1);

    g.lineBuf = gl.createBuffer();
    g.lineVAO = gl.createVertexArray();
    gl.bindVertexArray(g.lineVAO);
    buffer(new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]));
    attr(0, 2, 2, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.lineBuf);
    attr(1, 3, 14, 0, 1);
    attr(2, 3, 14, 3, 1);
    attr(3, 3, 14, 6, 1);
    attr(4, 3, 14, 9, 1);
    attr(5, 2, 14, 12, 1);

    g.sparkBuf = gl.createBuffer();
    g.sparkVAO = gl.createVertexArray();
    gl.bindVertexArray(g.sparkVAO);
    buffer(new Float32Array([0]));
    attr(0, 1, 1, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.sparkBuf);
    attr(1, 3, 13, 0, 1);
    attr(2, 3, 13, 3, 1);
    attr(3, 3, 13, 6, 1);
    attr(4, 4, 13, 9, 1);

    const rand = C.rng(C.hashString(D.session) ^ 0x5bd1e995);
    const spread = 60 * Math.cbrt(Math.max(N, 8)) + 260;
    const motes = new Float32Array(1400 * 4);
    for (let i = 0; i < 1400; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, r = spread * Math.cbrt(0.15 + 0.85 * rand());
      const s = Math.sqrt(1 - u * u);
      motes.set([Math.cos(th) * s * r, u * r, Math.sin(th) * s * r, rand() * 100], i * 4);
    }
    g.motesVAO = gl.createVertexArray();
    gl.bindVertexArray(g.motesVAO);
    buffer(motes);
    attr(0, 4, 4, 0, 0);
    g.motesCount = 1400;

    g.pointsBuf = gl.createBuffer();
    g.pointsVAO = gl.createVertexArray();
    gl.bindVertexArray(g.pointsVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.pointsBuf);
    attr(0, 3, 8, 0, 0);
    attr(1, 3, 8, 3, 0);
    attr(2, 2, 8, 6, 0);

    g.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(null);
    g.w = 0;
    g.h = 0;
    return g;
  }

  function target(w, h, withDepth, samples) {
    const t = { w, h, fb: gl.createFramebuffer() };
    t.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, G.fmt, w, h, 0, gl.RGBA, G.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (withDepth) {
      t.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    }
    if (samples > 1) {
      t.msfb = gl.createFramebuffer();
      t.mscol = gl.createRenderbuffer();
      t.msdepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.mscol);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, G.fmt, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.msdepth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msfb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.mscol);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.msdepth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) t.msfb = null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }
  function freeTarget(t) {
    if (!t) return;
    gl.deleteFramebuffer(t.fb);
    gl.deleteTexture(t.tex);
    if (t.depth) gl.deleteRenderbuffer(t.depth);
    if (t.msfb) gl.deleteFramebuffer(t.msfb);
    if (t.mscol) gl.deleteRenderbuffer(t.mscol);
    if (t.msdepth) gl.deleteRenderbuffer(t.msdepth);
  }

  let quality = 1;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    const w = Math.max(2, Math.round(wrap.clientWidth * dpr));
    const h = Math.max(2, Math.round(wrap.clientHeight * dpr));
    if (G.w === w && G.h === h) return;
    canvas.width = w;
    canvas.height = h;
    freeTarget(G.scene);
    (G.levels || []).forEach(freeTarget);
    let samples;
    try {
      const s = gl.getInternalformatParameter(gl.RENDERBUFFER, G.fmt, gl.SAMPLES);
      samples = s && s.length ? Math.min(4, s[0]) : 0;
    } catch {
      samples = 0;
    }
    G.scene = target(w, h, true, samples);
    G.levels = [];
    let lw = w >> 1, lh = h >> 1;
    for (let i = 0; i < 6 && lw >= 2 && lh >= 2; i++) {
      G.levels.push(target(lw, lh, false, 0));
      lw >>= 1;
      lh >>= 1;
    }
    G.w = w;
    G.h = h;
    G.dpr = dpr;
    dirty = true;
  }

  // ---- the camera ----
  const cam = { target: [0, 0, 0], yaw: 0.7, pitch: 0.28, dist: 300 };
  const spin = { yaw: 0, pitch: 0 };
  let flight = null;
  let lastInput = 0;
  function bounds(ids) {
    const list = ids.length ? ids : D.nodes.map((n, i) => i);
    if (!list.length) return { c: [0, 0, 0], r: 50 };
    const c = [0, 0, 0];
    for (const i of list) for (let k = 0; k < 3; k++) c[k] += P[i * 3 + k] / list.length;
    // Frame 95% of the things, so one straggler cannot shrink the rest to dots.
    const ds = list.map((i) => Math.hypot(P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]) + radius[i]).sort((a, b) => a - b);
    const r = Math.max(10, ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))]);
    return { c, r };
  }
  function flyTo(to, dist, ms) {
    flight = { t0: performance.now(), ms: reduced ? 1 : ms || 750, from: { target: cam.target.slice(), dist: cam.dist }, to: { target: to, dist } };
    dirty = true;
  }
  function fit(ms) {
    const b = bounds(visible);
    flyTo(b.c, (b.r / Math.sin(FOV / 2)) * 1.08, ms);
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // ---- hover, selection, search, replay ----
  let hovered = -1;
  let selected = -1;
  const replay = { steps: C.replaySteps(D.trail), cur: D.trail.length, playing: false, t0: 0, speed: 1, trail: [] };
  const seen = new Float64Array(N);
  // V3D3: when each thing appeared in the replay, for its pop-in and its links' growth (NaN: not yet; a scrub jump
  // shows things at once, with no animation).
  const appear = new Float64Array(N).fill(NaN);
  function touchedUpTo(k, animateAt) {
    seen.fill(-1);
    for (let s = 0; s < k && s < replay.steps.length; s++) seen[replay.steps[s].node] = s;
    for (let i = 0; i < N; i++) {
      if (seen[i] < 0) appear[i] = NaN;
      else if (Number.isNaN(appear[i])) appear[i] = animateAt === undefined ? -1e12 : animateAt;
    }
  }
  touchedUpTo(replay.cur);
  const replaying = () => replay.cur < replay.steps.length;
  // The replay starts from a blank canvas: a thing not yet touched is not drawn at all.
  const hiddenNow = (i) => replaying() && seen[i] < 0;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const popIn = (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);

  function nodeState(i, now) {
    let hl = 0, dim = 0;
    const focus = selected >= 0 ? selected : hovered;
    if (focus >= 0) {
      if (i === focus) hl = 1;
      else if (neighbours[focus].indexOf(i) >= 0) hl = 0.45;
      else dim = 0.6;
    }
    if (opt.search) {
      const n = D.nodes[i];
      const hit = String(n.label || '').toLowerCase().indexOf(opt.search) >= 0 || String(n.path || '').toLowerCase().indexOf(opt.search) >= 0;
      if (hit) hl = Math.max(hl, 0.7);
      else dim = Math.max(dim, 0.85);
    }
    if (replaying()) {
      const at = seen[i];
      if (at < 0) dim = Math.max(dim, 0.8);
      else {
        const age = replay.cur - 1 - at;
        hl = Math.max(hl, age <= 0 ? 1 : Math.max(0, 0.6 - age * 0.1));
      }
    }
    if (i === selected) hl = 1;
    return [hl, dim, flagged[i] && !reduced ? 1 : 0, now];
  }

  // ---- drawing ----
  let dirty = true;
  let nodeData = new Float32Array(0), lineData = new Float32Array(0), sparkData = new Float32Array(0);
  let vp = null;
  let viewM = null;
  // Two sparkles a link on a small graph; on a dense one, one link in so many carries one, at most about 1,500 in all.
  function sparkCount(k) {
    const ne = visEdges.length;
    if (ne <= 750) return 2;
    const every = Math.ceil(ne / 1500);
    return k % every === 0 ? 1 : 0;
  }
  function fill(now) {
    if (nodeData.length < visible.length * 10) nodeData = new Float32Array(visible.length * 10);
    let nv = 0;
    for (let k = 0; k < visible.length; k++) {
      const i = visible[k];
      if (hiddenNow(i)) continue;
      const s = nodeState(i, now);
      const c = color[i];
      // V3D3: a thing that just appeared pops in, and flashes as it does
      const p = replaying() ? clamp01((now - appear[i]) / 450) : 1;
      const hl = Math.max(s[0], (1 - p) * 0.9);
      nodeData.set([P[i * 3], P[i * 3 + 1], P[i * 3 + 2], c[0], c[1], c[2], radius[i] * Math.max(0.01, popIn(p)) * (1 + 0.25 * hl), hl, s[1], s[2]], nv * 10);
      nv++;
    }
    const allE = visEdges.length;
    if (lineData.length < allE * 14) lineData = new Float32Array(allE * 14);
    const focus = selected >= 0 ? selected : hovered;
    const dprPx = G.dpr || 1;
    // Links add light, so a dense graph (860f51e9: 5,490 links on 124 things) would burn to white: each link's
    // light and its sparkles scale down with the square root of the link count.
    const density = Math.min(1, 21 / Math.sqrt(Math.max(allE, 1)));
    // V3D3: in the replay a link shows once both its ends have appeared, growing from the end that came first.
    const grow = (a, b) => {
      if (!replaying()) return { from: a, to: b, g: 1 };
      const born = Math.max(appear[a], appear[b]);
      const older = appear[a] <= appear[b] ? a : b;
      const t = clamp01((now - born) / 600);
      return { from: older, to: older === a ? b : a, g: t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 };
    };
    let ne = 0;
    let sparks = 0;
    for (let k = 0; k < allE; k++) {
      const e = visEdges[k];
      if (hiddenNow(e.from) || hiddenNow(e.to)) continue;
      const gr = grow(e.from, e.to);
      const a = gr.from, b = gr.to, g = gr.g;
      const hot = focus >= 0 && (a === focus || b === focus);
      const cold = focus >= 0 && !hot;
      const alpha = (hot ? 0.9 : cold ? 0.03 * density : 0.26 * density) + (1 - g) * 0.45;
      const bx = P[a * 3] + (P[b * 3] - P[a * 3]) * g, by = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * g, bz = P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * g;
      lineData.set([P[a * 3], P[a * 3 + 1], P[a * 3 + 2], bx, by, bz, ...color[a], ...color[b], alpha, (hot ? 2.6 : 1.3) * dprPx], ne * 14);
      ne++;
      if (!cold && g >= 1) sparks += hot ? 5 : sparkCount(k);
    }
    if (sparkData.length < sparks * 13) sparkData = new Float32Array(sparks * 13);
    let s = 0;
    for (let k = 0; k < allE; k++) {
      const e = visEdges[k];
      if (hiddenNow(e.from) || hiddenNow(e.to)) continue;
      const gr = grow(e.from, e.to);
      if (gr.g < 1) continue;
      const a = gr.from, b = gr.to;
      const hot = focus >= 0 && (a === focus || b === focus);
      const cold = focus >= 0 && !hot;
      if (cold) continue;
      const count = hot ? 5 : sparkCount(k);
      for (let j = 0; j < count; j++) {
        const seed = ((k * 7919 + j * 104729) % 1000) / 1000;
        sparkData.set([P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], ...color[b], (j / count + seed * 0.3) % 1, (0.12 + seed * 0.1) * (reduced ? 0.25 : 1), hot ? 26 : 18, hot ? 2.4 : 1.25 * Math.max(0.45, density)], s * 13);
        s++;
      }
    }
    return { nv, ne, ns: s };
  }

  function cometPoints(now) {
    if (!replaying() || replay.cur <= 0) return 0;
    const step = replay.steps[replay.cur - 1];
    const dur = 650 / replay.speed;
    const t = replay.playing ? Math.min(1, (now - replay.t0) / dur) : 1;
    const b = step.node;
    const a = step.from >= 0 ? step.from : b;
    const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const B = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 + Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) * 0.22, (A[2] + B[2]) / 2];
    const at = (u) => [0, 1, 2].map((k) => (1 - u) * (1 - u) * A[k] + 2 * (1 - u) * u * mid[k] + u * u * B[k]);
    const col = linear(step.failed ? '#ff5252' : '#ffffff');
    const out = [];
    const tail = 22;
    const e = ease(t);
    for (let j = 0; j < tail; j++) {
      const u = Math.max(0, e - j * 0.035);
      const p = at(u);
      const fade = 1 - j / tail;
      out.push(p[0], p[1], p[2], col[0], col[1], col[2], (j ? 14 : 34) * fade + 4, (j ? 1.6 : 4.5) * fade);
      if (u === 0) break;
    }
    replay.trail = out;
    return out.length / 8;
  }

  function draw(now) {
    resize();
    const w = G.w, h = G.h;
    const aspect = w / h;
    vp = C.viewProj(cam, aspect, FOV);
    viewM = C.view(cam);
    const right = [viewM[0], viewM[4], viewM[8]];
    const up = [viewM[1], viewM[5], viewM[9]];
    const t = now / 1000;
    const motion = reduced ? 0 : 1;
    const fog = linear('#05070b');
    const fogRange = [cam.dist * 0.9, cam.dist * 3.2];
    const scale = (h / 2 / Math.tan(FOV / 2));
    const counts = fill(now);

    const scene = G.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.msfb || scene.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // opaque spheres first, writing depth
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.useProgram(G.node.p);
    gl.uniformMatrix4fv(G.node.u.uViewProj, false, vp);
    gl.uniform3fv(G.node.u.uRight, right);
    gl.uniform3fv(G.node.u.uUp, up);
    gl.uniform1f(G.node.u.uTime, t);
    gl.uniform1f(G.node.u.uMotion, motion);
    gl.uniform1f(G.node.u.uLight, opt.light);
    gl.uniform3fv(G.node.u.uFog, fog);
    gl.uniform2fv(G.node.u.uFogRange, fogRange);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.nodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, nodeData.subarray(0, counts.nv * 10), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(G.nodeVAO);
    gl.uniform1f(G.node.u.uPass, 0);
    if (counts.nv) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, counts.nv);

    // everything else adds light, reads depth, writes none
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(G.node.u.uPass, 1);
    if (counts.nv) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, counts.nv);

    if (opt.motes) {
      gl.useProgram(G.motes.p);
      gl.uniformMatrix4fv(G.motes.u.uViewProj, false, vp);
      gl.uniform1f(G.motes.u.uTime, t);
      gl.uniform1f(G.motes.u.uScale, scale);
      gl.uniform1f(G.motes.u.uMotion, motion);
      gl.uniform1f(G.motes.u.uDust, opt.dust);
      gl.bindVertexArray(G.motesVAO);
      gl.drawArrays(gl.POINTS, 0, G.motesCount);
    }

    if (counts.ne) {
      gl.useProgram(G.line.p);
      gl.uniformMatrix4fv(G.line.u.uViewProj, false, vp);
      gl.uniform2f(G.line.u.uViewport, w, h);
      gl.uniform2fv(G.line.u.uFogRange, fogRange);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, lineData.subarray(0, counts.ne * 14), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(G.lineVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, counts.ne);
    }

    if (opt.sparks && counts.ns) {
      gl.useProgram(G.spark.p);
      gl.uniformMatrix4fv(G.spark.u.uViewProj, false, vp);
      gl.uniform1f(G.spark.u.uTime, t);
      gl.uniform1f(G.spark.u.uScale, scale / 100);
      gl.uniform1f(G.spark.u.uSparkle, opt.sparkle);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.sparkBuf);
      gl.bufferData(gl.ARRAY_BUFFER, sparkData.subarray(0, counts.ns * 13), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(G.sparkVAO);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, counts.ns);
    }

    const comet = cometPoints(now);
    if (comet) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(G.points.p);
      gl.uniformMatrix4fv(G.points.u.uViewProj, false, vp);
      gl.uniform1f(G.points.u.uScale, scale / 100);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.pointsBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(replay.trail), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(G.pointsVAO);
      gl.drawArrays(gl.POINTS, 0, comet);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);

    if (scene.msfb) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scene.msfb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scene.fb);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // bloom: bright pass to half size, down the chain, back up adding each level
    gl.bindVertexArray(G.quadVAO);
    gl.disable(gl.BLEND);
    const lv = G.levels;
    const pass = (prog, src, dst, uniforms) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
      gl.viewport(0, 0, dst ? dst.w : w, dst ? dst.h : h);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      if (prog.u.uTex) gl.uniform1i(prog.u.uTex, 0);
      if (prog.u.uTexel) gl.uniform2f(prog.u.uTexel, 1 / src.w, 1 / src.h);
      if (uniforms) uniforms();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    if (lv.length) {
      pass(G.bright, scene, lv[0], () => {
        gl.uniform1f(G.bright.u.uThreshold, G.float ? 0.95 : 0.6);
        gl.uniform1f(G.bright.u.uKnee, 0.45);
      });
      for (let i = 1; i < lv.length; i++) pass(G.down, lv[i - 1], lv[i]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = lv.length - 1; i > 0; i--) pass(G.up, lv[i], lv[i - 1]);
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(G.comp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(G.comp.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lv.length ? lv[0].tex : scene.tex);
    gl.uniform1i(G.comp.u.uBloom, 1);
    gl.uniform1f(G.comp.u.uBloomStrength, lv.length ? opt.glow : 0);
    gl.uniform1f(G.comp.u.uExposure, opt.exposure);
    gl.uniform1f(G.comp.u.uTime, t);
    gl.uniform2f(G.comp.u.uRes, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    drawLabels();
  }

  // ---- labels (HTML over the canvas) ----
  const labelPool = [];
  function screenOf(i) {
    const c = C.transform(vp, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 1]);
    if (c[3] <= 0) return null;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    return { x: (c[0] / c[3] * 0.5 + 0.5) * cw, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * ch, w: c[3], r: (radius[i] * ch) / 2 / Math.tan(FOV / 2) / c[3] };
  }
  // Files before commands and tools; flagged first; then the most touched.
  const isFile = D.nodes.map((n) => (n.path ? 1 : 0));
  function drawLabels() {
    const want = [];
    for (const i of [hovered, selected, replaying() && replay.cur > 0 ? replay.steps[replay.cur - 1].node : -1]) if (i >= 0 && isVis[i] && want.indexOf(i) < 0) want.push(i);
    const pinned = want.length;
    if (opt.labels) {
      const ranked = visible.filter((i) => !hiddenNow(i)).sort((a, b) => flagged[b] - flagged[a] || isFile[b] - isFile[a] || D.nodes[b].touches - D.nodes[a].touches).slice(0, 40);
      for (const i of ranked) if (want.indexOf(i) < 0) want.push(i);
    }
    while (labelPool.length < want.length) {
      const s = document.createElement('span');
      s.className = 'g3-label';
      labelsEl.appendChild(s);
      labelPool.push(s);
    }
    // Most important first; a label that would overlap one already placed is left out (the pinned ones never are).
    const placed = [];
    let shown = 0;
    labelPool.forEach((s, k) => {
      const i = want[k];
      const p = i == null ? null : screenOf(i);
      if (!p || p.x < -50 || p.y < -20 || p.x > wrap.clientWidth + 50 || p.y > wrap.clientHeight + 20) {
        s.style.display = 'none';
        return;
      }
      const text = env.trunc(D.nodes[i].label, 30);
      const bw = text.length * 6.4 + 16, top = p.y - p.r - 6 - 19;
      const box = [p.x - bw / 2, top, p.x + bw / 2, top + 19];
      const clash = placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
      if (k >= pinned && (clash || shown >= 16)) {
        s.style.display = 'none';
        return;
      }
      placed.push(box);
      shown++;
      s.style.display = '';
      if (s.textContent !== text) s.textContent = text;
      s.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + (p.y - p.r - 6).toFixed(1) + 'px) translate(-50%,-100%)';
      const focus = i === hovered || i === selected;
      s.style.opacity = focus ? '1' : String(Math.max(0.25, Math.min(0.9, (cam.dist * 1.6) / p.w)));
      s.classList.toggle('on', focus);
    });
  }

  function pick(mx, my) {
    let best = -1, bestW = Infinity;
    for (const i of visible) {
      if (hiddenNow(i)) continue;
      const p = screenOf(i);
      if (!p) continue;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d <= Math.max(p.r, 3) + 4 && p.w < bestW) {
        best = i;
        bestW = p.w;
      }
    }
    return best;
  }

  // ---- the loop ----
  let running = false;
  let raf = 0;
  let last = 0;
  let slow = 0;
  let frames = 0;
  function frame(now) {
    raf = 0;
    if (!running || !G) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    if (last) {
      frames++;
      if (now - last > 34) slow++;
      if (frames >= 90) {
        if (slow > 45 && quality > 0.55) {
          quality -= 0.15;
          G.w = 0;
        }
        frames = 0;
        slow = 0;
      }
    }
    last = now;
    let busy = false;
    if (!L.done()) {
      const t0 = performance.now();
      while (!L.done() && performance.now() - t0 < 7) L.step();
      busy = true;
      if (L.done() && !flight) fit(900);
    }
    if (flight) {
      const u = Math.min(1, (now - flight.t0) / flight.ms);
      const e = ease(u);
      for (let k = 0; k < 3; k++) cam.target[k] = flight.from.target[k] + (flight.to.target[k] - flight.from.target[k]) * e;
      cam.dist = flight.from.dist + (flight.to.dist - flight.from.dist) * e;
      if (u >= 1) flight = null;
      busy = true;
    }
    if (Math.abs(spin.yaw) > 1e-5 || Math.abs(spin.pitch) > 1e-5) {
      cam.yaw += spin.yaw;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + spin.pitch));
      spin.yaw *= 0.9;
      spin.pitch *= 0.9;
      busy = true;
    } else if (opt.spin && now - lastInput > 4000 && !replay.playing) {
      cam.yaw += dt * 0.07;
      busy = true;
    }
    if (replay.playing) {
      const dur = 650 / replay.speed;
      if (now - replay.t0 >= dur) {
        if (replay.cur >= replay.steps.length) {
          replay.playing = false;
          setPlay();
        } else {
          replay.cur++;
          replay.t0 = now;
          touchedUpTo(replay.cur, now);
          showStep();
        }
      }
      if (opt.follow && replay.cur > 0) {
        const n = replay.steps[replay.cur - 1].node;
        for (let k = 0; k < 3; k++) cam.target[k] += (P[n * 3 + k] - cam.target[k]) * 0.05;
      }
      busy = true;
    }
    if (busy || dirty || opt.sparks || opt.motes || flagged.some((f, i) => f && isVis[i])) {
      draw(now);
      dirty = false;
    }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running) return;
    running = true;
    last = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // ---- replay controls ----
  const scrub = $('g3-scrub');
  function setPlay() {
    $('g3-play').innerHTML = replay.playing ? '&#10074;&#10074; Pause' : '&#9654; Replay';
    $('g3-play').classList.toggle('on', replay.playing);
  }
  function showStep() {
    scrub.value = String(replay.cur);
    const out = $('g3-step');
    if (!replaying() || replay.cur === 0) {
      out.textContent = replay.cur === 0 ? 'Start of the session' : D.trail.length + ' touches in ' + D.turns.length + ' turn(s)';
      return;
    }
    const s = replay.steps[replay.cur - 1];
    out.textContent = 'Turn ' + s.turn + ' · ' + replay.cur + ' / ' + replay.steps.length + ' · ' + s.channel + ' · ' + env.trunc(s.label, 48) + (s.failed ? ' · FAILED' : '');
    out.classList.toggle('turn', s.newTurn);
  }
  function togglePlay() {
    if (!replay.steps.length) return;
    if (!replay.playing && replay.cur >= replay.steps.length) {
      replay.cur = 0;
      touchedUpTo(0);
    }
    replay.playing = !replay.playing;
    replay.t0 = performance.now();
    setPlay();
    showStep();
    dirty = true;
  }
  $('g3-play').addEventListener('click', togglePlay);
  scrub.addEventListener('input', () => {
    replay.cur = +scrub.value;
    replay.playing = false;
    touchedUpTo(replay.cur);
    setPlay();
    showStep();
    dirty = true;
  });
  $('g3-speed').addEventListener('change', (e) => (replay.speed = +e.target.value || 1));
  $('g3-follow').addEventListener('change', (e) => (opt.follow = e.target.checked));

  // ---- the other controls ----
  el.querySelectorAll('[data-g3look]').forEach((b) =>
    b.addEventListener('click', () => {
      setLook(b.dataset.g3look);
      el.querySelectorAll('[data-g3look]').forEach((x) => x.classList.toggle('on', x === b));
      $('g3-glow').value = String(Math.round(opt.glow * 100));
      try {
        window.localStorage.setItem('orunmila.g3.look', opt.look);
      } catch {
        /* a browser that keeps nothing still switches; it just opens Calm next time */
      }
      dirty = true;
    })
  );
  $('g3-glow').addEventListener('input', (e) => {
    opt.glow = +e.target.value / 100;
    dirty = true;
  });
  [['g3-sparks', 'sparks'], ['g3-motes', 'motes'], ['g3-spin', 'spin'], ['g3-lbl', 'labels']].forEach(([id, k]) =>
    $(id).addEventListener('change', (e) => {
      opt[k] = e.target.checked;
      dirty = true;
    })
  );
  $('g3-search').addEventListener('input', (e) => {
    opt.search = e.target.value.trim().toLowerCase();
    dirty = true;
  });
  el.querySelectorAll('[data-g3mode]').forEach((b) =>
    b.addEventListener('click', () => {
      opt.mode = b.dataset.g3mode;
      el.querySelectorAll('[data-g3mode]').forEach((x) => x.classList.toggle('on', x === b));
      recompute();
      fit(700);
    })
  );
  env.bindFilters(el, () => {
    recompute();
  });
  $('g3-fit').addEventListener('click', () => fit(700));
  $('g3-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
  });
  $('g3-shot').addEventListener('click', () => {
    if (!G) return;
    draw(performance.now());
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = 'orunmila-3d-' + String(D.session || 'session').slice(0, 8) + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  });

  // ---- pointer, wheel, touch, keyboard ----
  let drag = null;
  const pointers = new Map();
  const local = (e) => {
    const r = wrap.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas && e.target !== labelsEl) return;
    wrap.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    lastInput = performance.now();
    const xy = local(e);
    drag = { x: xy[0], y: xy[1], moved: 0, pan: e.button === 2 || e.shiftKey, pinch: pointers.size === 2 ? pinchDist() : 0 };
  });
  function pinchDist() {
    const v = [...pointers.values()];
    return v.length >= 2 ? Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]) : 0;
  }
  wrap.addEventListener('pointermove', (e) => {
    const xy = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, xy);
    if (drag) {
      const dx = xy[0] - drag.x, dy = xy[1] - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = xy[0];
      drag.y = xy[1];
      lastInput = performance.now();
      flight = null;
      if (pointers.size >= 2) {
        const d = pinchDist();
        if (drag.pinch && d) cam.dist = Math.max(20, Math.min(20000, cam.dist * (drag.pinch / d)));
        drag.pinch = d;
      } else if (drag.pan) {
        const k = (cam.dist * Math.tan(FOV / 2) * 2) / wrap.clientHeight;
        const v = viewM || C.view(cam);
        for (let i = 0; i < 3; i++) cam.target[i] += (-dx * v[i * 4] + dy * v[i * 4 + 1]) * k;
      } else {
        spin.yaw = -dx * 0.006;
        spin.pitch = dy * 0.006;
        cam.yaw += spin.yaw;
        cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + spin.pitch));
      }
      dirty = true;
      env.tipHide();
      return;
    }
    if (e.target !== canvas && e.target !== labelsEl) return;
    const i = pick(xy[0], xy[1]);
    if (i !== hovered) {
      hovered = i;
      dirty = true;
      wrap.style.cursor = i >= 0 ? 'pointer' : 'grab';
    }
    if (i >= 0) {
      const n = D.nodes[i];
      const sxy = env.stageXY(e);
      env.tipShow('<b>' + env.escjs(n.label) + '</b> &mdash; ' + env.escjs(n.stain ? n.stain.replace(/_/g, ' ') : n.primaryChannel) + '<br>' + n.touches + ' touches · ' + env.escjs(n.channels.join(', ')) + '<span class="ex">' + env.escjs(env.explainOf(n.stain, n.primaryChannel)) + '</span>', sxy[0], sxy[1]);
    } else env.tipHide();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (drag && drag.moved < 5 && pointers.size === 0) {
      const xy = local(e);
      const i = pick(xy[0], xy[1]);
      selected = i;
      if (i >= 0) {
        env.showDetail(D.nodes[i]);
        flyTo([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], Math.max(60, Math.min(cam.dist, radius[i] * 14)), 800);
      }
      dirty = true;
    }
    if (pointers.size === 0) drag = null;
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('pointerleave', () => {
    if (hovered >= 0) {
      hovered = -1;
      dirty = true;
    }
    env.tipHide();
  });
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      lastInput = performance.now();
      flight = null;
      cam.dist = Math.max(20, Math.min(20000, cam.dist * Math.exp(e.deltaY * 0.0012)));
      dirty = true;
    },
    { passive: false }
  );
  wrap.addEventListener('keydown', (e) => {
    const k = e.key;
    lastInput = performance.now();
    if (k === 'ArrowLeft') spin.yaw = 0.05;
    else if (k === 'ArrowRight') spin.yaw = -0.05;
    else if (k === 'ArrowUp') spin.pitch = 0.04;
    else if (k === 'ArrowDown') spin.pitch = -0.04;
    else if (k === '+' || k === '=') cam.dist *= 0.85;
    else if (k === '-' || k === '_') cam.dist *= 1.18;
    else if (k === 'f' || k === 'F') fit(700);
    else if (k === ' ') togglePlay();
    else if (k === 'Escape') {
      selected = -1;
      replay.playing = false;
      setPlay();
    } else return;
    e.preventDefault();
    dirty = true;
  });

  // ---- size, visibility, context loss ----
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop();
    G = null;
    msg('The graphics card reset; the map comes back by itself.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      G = initGL();
      $('g3-msg').hidden = true;
      start();
    } catch (err) {
      msg('The 3D map could not restart: ' + (err && err.message));
    }
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => (dirty = true)).observe(wrap);
  document.addEventListener('fullscreenchange', () => (dirty = true));
  let onScreen = true;
  let shown = true;
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((x) => x.isIntersecting);
      if (onScreen && shown && !document.hidden) start();
      else stop();
    }).observe(wrap);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (onScreen && shown) start();
  });

  try {
    G = initGL();
  } catch (err) {
    msg('The 3D map could not start on this graphics card: ' + (err && err.message) + '. The Graph tab shows the same map in 2D.');
    return { pause() {}, resume() {} };
  }
  recompute();
  const b0 = bounds(visible);
  cam.target = b0.c;
  cam.dist = (b0.r / Math.sin(FOV / 2)) * 1.25;
  // The first frame is drawn now, not on the next animation frame, so the map shows at once even where frames are
  // slow to come (a busy machine, a background tab brought forward, a headless browser).
  draw(performance.now());
  dirty = false;
  start();
  return {
    pause() {
      shown = false;
      stop();
      env.tipHide();
    },
    resume() {
      shown = true;
      dirty = true;
      if (onScreen) start();
    },
  };
}

/* c8 ignore stop */

/** The engine as page source: the three parts above, as the page's own script. */
function source() {
  return (
    'var orunmilaGraph3DCore = (' + core.toString() + ')();\n' +
    'var orunmilaGraph3DShaders = (' + shaders.toString() + ')();\n' +
    'var orunmilaGraph3D = ' + main.toString() + ';\n'
  );
}

module.exports = { core, shaders, main, source };
