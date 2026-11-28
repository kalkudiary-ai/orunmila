#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * law-gate.js — Claude Code Stop hook entry point for the LAW LAYER.
 *
 * Registered SEPARATELY from stop.js, and that separation is the point.
 * stop.js is capture: observe-only, exits zero, never speaks. This one is the
 * only script in orunmila permitted to refuse anything. Keeping them apart is
 * what lets the law layer exist without touching the contract the capture layer
 * has always kept.
 *
 * Contract with the host:
 *   - writes at most one JSON object to stdout
 *   - ALWAYS exits 0. A non-zero exit from a Stop hook blocks the agent by
 *     itself, so an accidental crash here would refuse a turn for no reason.
 *     Every failure path is silent.
 *
 * Kill switch: ORUNMILA_LAWS=off
 *
 * ORUNMILA_GATE_MARKS=1 (off by default; slice B5, LD146): the gate's decision
 * is also sent to the intake as one payload, for a `law_gate` mark (test 61).
 * The sender is loaded only then, so the flag off loads what it always did.
 * `--marks` on the hook's command line does the same (BB5b, LD276): `install
 * --intake` writes it, since an environment prefix on a hook command does not
 * work in every shell a hook runs in (cmd.exe on Windows).
 */

const { runGate } = require('../../laws/gate');
const { getAdapter } = require('../agents');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
});
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}');
    let check = null;
    const marks = process.env.ORUNMILA_GATE_MARKS === '1' || process.argv.includes('--marks');
    const out = runGate(payload, getAdapter('claude-code'), { root: process.cwd(), onCheck: marks ? (c) => (check = c) : undefined });
    if (out) process.stdout.write(JSON.stringify(out));
    if (check) {
      const p = { hook_event_name: 'OrunmilaLawCheck', session_id: payload.session_id, cwd: process.cwd(), check };
      require('./gate-send').send(p, () => process.exit(0));
      return;
    }
  } catch {
    /* silent by contract — see the header */
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));