// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/daily.js — the daily update check (PM2c2, LD333; Phase 5 plan section 6: "about once a day the intake
 * (or, where none runs, the starter) asks"). With the updates switch on (src/opon/intake/switches.js updatesOn), the
 * intake, every hour, starts an update when the last check is a day old; the starter does the same on a hook, with its
 * own few lines (it loads Node's own modules only). Either starts `orunmila update --auto` through the starter, as its
 * own process, detached: the network stays out of the intake and the hooks (LD268), and nothing waits on it.
 *
 *   lastCheckFile(home)       <home>/runtime/last-check: the time of the last check started, one ISO line
 *   due(home, now?)           no last check, one that cannot be read, or one a day old or more
 *   startUpdate(home) -> bool the check marked now (placed whole), and `update --auto` started detached through the
 *                             starter; false, and nothing marked, when no starter is installed (`install` makes it)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const lastCheckFile = (home) => path.join(home, 'runtime', 'last-check');

function due(home, now = Date.now()) {
  try {
    const t = Date.parse(fs.readFileSync(lastCheckFile(home), 'utf8').trim());
    return !(t > 0) || now - t >= DAY_MS;
  } catch {
    return true;
  }
}

function startUpdate(home) {
  const starter = path.join(home, 'bin', 'orunmila-start.js');
  if (!fs.existsSync(starter)) return false;
  const file = lastCheckFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, new Date().toISOString() + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  spawn(process.execPath, [starter, 'bin/orunmila.js', 'update', '--auto'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

module.exports = { DAY_MS, lastCheckFile, due, startUpdate };
