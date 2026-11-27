// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/compat-shapes.js — EU1 (Phase 7; brief v4 lines 745-748, test 47): the output shape of every command an
 * existing user may script against, so a new version can be checked against the published one on the same sessions.
 * A shape is the set of `path:type` pairs of a JSON output (no value ever kept): `a.b`, `[]` for a list's items, a key
 * that is not a plain name (a file path, a tool or service name) written `<key>`. The rule is the spec's: fields may be
 * added, never removed or given another type.
 *
 *   node scripts/compat-shapes.js record --bin <orunmila.js> --session <id>[,<id>...] --out <file>
 *   node scripts/compat-shapes.js check  --bin <orunmila.js> --session <id>[,<id>...] --shapes <file>
 *   shapeOf(value) -> sorted ['path:type', ...]      missing(old, now) -> pairs of old that now lacks
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The JSON commands of `review/phase0-rerun.md` "Commands and formats" (S4.9), each pinned to one session.
const COMMANDS = {
  'trail --json': (s) => ['trail', '--json', '--session', s],
  'trail --json --facts-only': (s) => ['trail', '--json', '--facts-only', '--session', s],
  json: (s) => ['json', '--session', s],
  'laws --check --json': (s) => ['laws', '--check', '--json', '--session', s],
};

const PLAIN = /^[a-z][a-z0-9_]*$/; // Orunmila's own field names; anything else is data used as a key
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function shapeOf(value) {
  const out = new Set();
  const walk = (v, p) => {
    out.add(`${p || '.'}:${typeOf(v)}`);
    if (Array.isArray(v)) for (const x of v) walk(x, `${p}[]`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p ? p + '.' : ''}${PLAIN.test(k) ? k : '<key>'}`);
  };
  walk(value, '');
  return [...out].sort();
}

/** The pairs `old` has that `now` lacks. A null in one and a value in the other is no difference: data, not shape. */
function missing(old, now) {
  const have = new Set(now);
  const paths = new Set(now.map((x) => x.slice(0, x.lastIndexOf(':'))));
  return old.filter((x) => {
    if (have.has(x)) return false;
    const p = x.slice(0, x.lastIndexOf(':'));
    return !(x.endsWith(':null') && paths.has(p));
  });
}

function run(bin, args, env) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, ...env } });
  let value;
  try {
    value = JSON.parse(r.stdout);
  } catch {
    value = undefined;
  }
  return { status: r.status, value };
}

/** { command: { status: [exit codes], shape: [...] } } over the sessions, each shape the union of the sessions'. */
function shapes(bin, sessions, env = {}) {
  const out = {};
  for (const [name, args] of Object.entries(COMMANDS)) {
    const all = new Set();
    const status = [];
    for (const s of sessions) {
      const r = run(bin, args(s), env);
      status.push(r.status);
      if (r.value !== undefined) for (const x of shapeOf(r.value)) all.add(x);
    }
    out[name] = { status, shape: [...all].sort() };
  }
  return out;
}

if (require.main === module) {
  const [mode, ...rest] = process.argv.slice(2);
  const opt = (k) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : null;
  };
  const bin = path.resolve(opt('--bin'));
  const sessions = String(opt('--session') || '').split(',').filter(Boolean);
  if (!sessions.length || !fs.existsSync(bin)) {
    console.error('usage: compat-shapes.js record|check --bin <orunmila.js> --session <id>[,<id>] (--out | --shapes) <file>');
    process.exit(2);
  }
  const now = shapes(bin, sessions);
  if (mode === 'record') {
    fs.writeFileSync(opt('--out'), JSON.stringify(now, null, 1) + '\n');
    for (const [k, v] of Object.entries(now)) console.log(`${k}: exit ${v.status.join(',')}, ${v.shape.length} path:type pairs`);
    process.exit(0);
  }
  const old = JSON.parse(fs.readFileSync(opt('--shapes'), 'utf8'));
  let bad = 0;
  for (const [k, v] of Object.entries(old)) {
    const lost = missing(v.shape, now[k] ? now[k].shape : []);
    const exits = now[k] ? now[k].status.join(',') : 'none';
    console.log(`${k}: exit ${v.status.join(',')} then, ${exits} now; ${lost.length} pairs lost${lost.length ? ': ' + lost.join(' ') : ''}`);
    if (lost.length || exits !== v.status.join(',')) bad++;
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { shapeOf, missing, shapes, COMMANDS };
