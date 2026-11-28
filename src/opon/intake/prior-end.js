// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/prior-end.js — how the last intake ended, told at the next start (slice W4a, LD343; TE2, LD283).
 *
 * A stop no one asked for is recorded by the intake itself when it can handle the signal (TE2: SIGTERM, SIGINT,
 * SIGHUP, and SIGBREAK on Windows). A kill no handler sees (Windows' TerminateProcess: Task Manager, `taskkill /F`,
 * and what Node's process.kill does there for any signal; SIGKILL elsewhere) leaves nothing, so it used to read as
 * downtime only. Now each run leaves a note while it runs (`run.json`: pid, the machine's boot time, when it
 * started), cleared by every stop the intake makes itself; a crash leaves its own note (`last-stop.json`, as a
 * handled signal does). At the next start:
 *
 *   last-stop.json names a signal   stopped by that signal, which no one asked for (TE2's words, unchanged)
 *   last-stop.json names a crash    the intake crashed, with its error
 *   run.json left, the machine booted since    the machine restarted while the intake ran (a shutdown or power loss)
 *   run.json left, same boot        ended from outside, no stop asked for and no crash recorded: a kill
 *   neither                         nothing to say (a stop asked for, or a first start)
 *
 *   priorEnd({ lastStop, run, bootNow, toleranceMs }) -> the words for the restart's gap, or null
 *   bootTime() -> the machine's boot time now, in ms since the epoch
 *   runNote(dir), lastStopFile(dir): the two files in <home>/intake
 *
 * Plain code but bootTime: the boot times compare within toleranceMs (2 minutes), as os.uptime() is in seconds.
 */

const os = require('os');
const path = require('path');

const TOLERANCE_MS = 2 * 60 * 1000;

const runNote = (dir) => path.join(dir, 'run.json');
const lastStopFile = (dir) => path.join(dir, 'last-stop.json');
const bootTime = () => Date.now() - Math.round(os.uptime() * 1000);

function priorEnd({ lastStop = null, run = null, bootNow, toleranceMs = TOLERANCE_MS }) {
  if (lastStop && typeof lastStop.signal === 'string') return `the intake was stopped by ${lastStop.signal}, which no one asked for through \`orunmila intake stop\` (at ${lastStop.at})`;
  if (lastStop && typeof lastStop.crash === 'string') return `the intake crashed (${lastStop.crash}) at ${lastStop.at}; no stop was asked for`;
  if (!run || !Number.isInteger(run.pid)) return null;
  const was = `it ran as pid ${run.pid} from ${run.started_at}`;
  if (typeof run.boot === 'number' && typeof bootNow === 'number' && Math.abs(bootNow - run.boot) > toleranceMs) {
    return `the machine restarted while the intake ran (a shutdown or a power loss), so it ended with no stop asked for (${was})`;
  }
  return `the intake was ended from outside, with no stop asked for and no crash recorded: a kill no handler sees (Task Manager, taskkill /F, kill -9) (${was})`;
}

module.exports = { priorEnd, bootTime, runNote, lastStopFile, TOLERANCE_MS };
