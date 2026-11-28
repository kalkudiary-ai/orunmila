#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/intake-restart-idle.js — IR1 (LD240; Phase 5, LD237): restart the intake only while it holds no session.
 *
 * A restart writes a downtime gap into every session the intake holds (router.js resume(): only the sessions in
 * held.json are reopened and gapped). The intake releases a session after 30 minutes with no payload, so a restart
 * made while it holds none writes no gap in any session's log. This waits for that: it asks the running intake for
 * its status every `pollMs`, and restarts it only after `quietPolls` answers in a row hold no session; then it waits
 * for an intake with another pid to answer, and reports how long none did.
 *
 * Stated limit: a session whose first payloads land inside the restart's own downtime has no log yet, so nothing
 * records their loss (as test 85 says of no intake at all). Waiting until no session is held makes that unlikely;
 * it does not make it impossible. The handover (IR2) removes the downtime itself.
 *
 *   restartWhenIdle({ status, restart, wait, now, pollMs, quietPolls, maxWaitMs, answerPollMs, answerWaitMs })
 *     -> { ok: true, before, after, downtimeMs, held } or { ok: false, reason }
 *
 *   node scripts/intake-restart-idle.js [--poll-ms N] [--quiet-polls N] [--max-wait-ms N]
 *     the live intake under its launch agent (macOS): `launchctl kickstart -k gui/<uid>/dev.orunmila.intake`;
 *     prints the result as one JSON line; exit 0 only when another intake answered after the restart.
 */

const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

async function restartWhenIdle({ status, restart, wait, now, pollMs = 60000, quietPolls = 2, maxWaitMs = Infinity, answerPollMs = 100, answerWaitMs = 30000 }) {
  const start = now();
  let quiet = 0;
  let before;
  for (;;) {
    const s = await status();
    if (!s) return { ok: false, reason: 'no intake answers' };
    before = s.pid;
    const held = Array.isArray(s.held) ? s.held : [];
    quiet = held.length === 0 ? quiet + 1 : 0;
    if (quiet >= quietPolls) break;
    if (now() - start >= maxWaitMs) return { ok: false, reason: `sessions stayed held: ${held.join(', ')}` };
    await wait(pollMs);
  }
  const t0 = now();
  try {
    await restart();
  } catch (e) {
    return { ok: false, reason: `the restart failed: ${e.message}` };
  }
  for (;;) {
    const s = await status();
    if (s && s.pid !== before) return { ok: true, before, after: s.pid, downtimeMs: now() - t0, held: s.held };
    if (now() - t0 >= answerWaitMs) return { ok: false, reason: `no intake answered within ${answerWaitMs} ms of the restart` };
    await wait(answerPollMs);
  }
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i === -1) return dflt;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a number of 0 or more`);
  return n;
}

async function main() {
  if (process.platform !== 'darwin') {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'only the macOS launch agent is supported here' }) + '\n');
    return 1;
  }
  const { statusOf, intakePaths } = require('../src/opon/intake/server');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const sock = intakePaths(home).sock;
  const target = `gui/${process.getuid()}/dev.orunmila.intake`;
  const r = await restartWhenIdle({
    status: () => statusOf(sock, 2000),
    restart: async () => {
      const k = spawnSync('launchctl', ['kickstart', '-k', target], { encoding: 'utf8' });
      if (k.error || k.status !== 0) throw new Error(k.error ? k.error.message : `launchctl exited ${k.status}: ${(k.stderr || '').trim()}`);
    },
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Math.round(performance.now()),
    pollMs: arg('--poll-ms', 60000),
    quietPolls: arg('--quiet-polls', 2),
    maxWaitMs: arg('--max-wait-ms', Infinity),
  });
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n');
  return r.ok ? 0 : 1;
}

module.exports = { restartWhenIdle };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
      process.exit(1);
    },
  );
}
