#!/usr/bin/env node
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
    const out = runGate(payload, getAdapter('claude-code'), { root: process.cwd() });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    /* silent by contract — see the header */
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));