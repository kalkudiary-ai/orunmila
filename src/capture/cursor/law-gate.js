#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/cursor/law-gate.js — the Closeout Gate for Cursor (CG1, LD394; O, 2026-11-28: "can we make close out
 * gate ... work in cursor?"). Installed only with `orunmila install --agent cursor --with-gate`, as two hooks:
 *
 *   law-gate.js text   on afterAgentResponse: keeps that response's text under its generation_id, owner-only, and
 *                      answers nothing
 *   law-gate.js stop   on stop (loop_limit 2, the gate's block budget): waits up to ORUNMILA_CURSOR_GATE_WAIT_MS
 *                      (2,000 ms) for the text of this same generation, then judges the turn with the gate Claude
 *                      Code's Stop hook uses (src/laws/gate.js). A block is answered as `{ "followup_message": ... }`,
 *                      which Cursor submits as the next user message (its hooks documentation); advice is not shown,
 *                      as Cursor's stop hook takes nothing else, and is kept in the gate's record like every check.
 *
 * Why the wait: measured in test 49 (Cursor's command-line agent 2026.11.22), stop and afterAgentResponse fire in the
 * same millisecond, and stop's payload has no text. The text is taken only from this generation's response, so the
 * gate never judges an earlier message (N10); with none, it judges nothing and records the skip. An aborted or failed
 * turn is not judged. Every failure exits 0 with nothing printed: the gate may stop enforcing, never stop the agent.
 * Kill switch: ORUNMILA_LAWS=off, as for Claude Code.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WAIT_MS = () => {
  const n = Number(process.env.ORUNMILA_CURSOR_GATE_WAIT_MS);
  return Number.isInteger(n) && n >= 0 ? n : 2000;
};

function textFile(sessionId, generation) {
  const { dataDir } = require('../../store/eventlog');
  const dir = path.join(dataDir(), 'laws-state', String(sessionId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `cursor-${crypto.createHash('sha256').update(String(generation)).digest('hex').slice(0, 16)}.text.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(mode, raw) {
  const { getAdapter } = require('../agents');
  const cursor = getAdapter('cursor');
  const payload = JSON.parse(raw || '{}');
  if (!payload || typeof payload !== 'object' || !payload.generation_id) return;
  const sessionId = cursor.fields.sessionId(payload);
  if (!sessionId || sessionId === 'unknown') return;
  const file = textFile(sessionId, payload.generation_id);
  if (mode === 'text') {
    if (typeof payload.text === 'string') fs.writeFileSync(file, JSON.stringify({ text: payload.text }), { mode: 0o600 });
    return;
  }
  if (mode !== 'stop' || payload.status !== 'completed') return;
  let text = null;
  for (const until = Date.now() + WAIT_MS(); ; await sleep(25)) {
    try {
      text = JSON.parse(fs.readFileSync(file, 'utf8')).text;
      break;
    } catch {
      if (Date.now() >= until) break;
    }
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the kept text is best-effort */
  }
  const { runGate } = require('../../laws/gate');
  const judged = typeof text === 'string' ? { ...payload, text } : { ...payload, text: undefined };
  const out = runGate(judged, cursor, { root: process.cwd() });
  if (out && out.decision === 'block') {
    process.stdout.write(JSON.stringify({ followup_message: `Orunmila's Closeout Gate, an automatic follow-up (not from the user):\n\n${out.reason}` }));
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  main(process.argv[2], raw).then(
    () => process.exit(0),
    () => process.exit(0),
  );
});
process.stdin.on('error', () => process.exit(0));
