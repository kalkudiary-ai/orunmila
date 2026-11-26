#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * intake-send.js — Claude Code's hooks to the intake (Phase 1 slice B2, LD122,
 * LD133; design D-I 4.2(b)). Registered by `orunmila install --intake` for every
 * event the intake's router reads and every tool, beside today's capture hooks.
 *
 * Reads the hook payload from stdin and writes one line,
 * {"op":"payload","payload":...}, to <home>/intake/intake.sock (home:
 * ORUNMILA_HOME, else ~/.orunmila). Then it exits 0. It never blocks the agent
 * (test 85): with no intake, nothing is sent and the session has no record, as
 * the docs say; a listener that never takes the line is cut at DEADLINE_MS. It
 * prints nothing, because Claude Code adds some hooks' stdout to the agent's
 * context. A payload that is not JSON is sent as a string, and the intake
 * records it in its error log (LD132).
 *
 * Node's own modules only: this file must load no other repo file (LD122), so
 * it stays apart from the hook-loaded set that scripts/hook-reach.js guards.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEADLINE_MS = 1000;

/**
 * W2a (LD298), W4b (LD343): the intake's address, by server.js sockFor's rule (this file loads no other repo file,
 * LD122): on Windows the pipe name the running intake published in <home>/intake/address, else the home's name.
 */
function sockPath(home, platform = process.platform) {
  if (platform !== 'win32') return path.join(home, 'intake', 'intake.sock');
  const base = `\\\\?\\pipe\\orunmila-intake-${crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)}`;
  try {
    const a = fs.readFileSync(path.join(home, 'intake', 'address'), 'utf8').trim();
    if (a.startsWith(base + '-') && /^[0-9a-f]{32}$/.test(a.slice(base.length + 1))) return a;
  } catch {
    /* none published */
  }
  return base;
}

function main() {
  const done = () => process.exit(0);
  setTimeout(done, DEADLINE_MS).unref();
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('error', done);
  process.stdin.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
    const c = net.createConnection(sockPath(home));
    c.on('error', done); // no intake: nothing to send to
    c.on('close', done);
    c.on('connect', () => c.end(JSON.stringify({ op: 'payload', payload }) + '\n'));
  });
}

if (require.main === module) main();
module.exports = { sockPath };
