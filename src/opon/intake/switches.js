// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/switches.js — the install's switches, kept in Orunmila's home (Phase 6 slice BJ1, LD300 (4), LD326:
 * the Babaláwo, the judge, is an install option, off by default, like the Closeout Gate). One file,
 * <home>/intake/switches.json, `{"judge": true | false}`, written by `orunmila install --with-judge | --without-judge`
 * and read by `orunmila intake run` at its start, and by `orunmila lenses` and `status`. The environment still wins
 * where it is set (ORUNMILA_JUDGE_LIVE=1 on, =0 off), so a launch agent installed with it keeps working.
 *
 *   switchesFile(home)              the file's path
 *   readSwitches(home) -> { judge, problem }
 *                                   judge false when the file is absent; a file that is not JSON, or a judge that is
 *                                   neither true nor false, is off, and `problem` says why (fail safe: the judge only
 *                                   adds verdicts, so off loses nothing from the record)
 *   setJudge(home, on) -> file      the switch written, any other keys kept; placed whole (a temp file renamed into
 *                                   place), owner-only like the rest of the intake folder
 *   judgeOn(env, home) -> { on, from }
 *                                   from: 'environment' (ORUNMILA_JUDGE_LIVE is 1 or 0), 'switch' (the file holds a
 *                                   judge), or 'default' (off)
 */

const fs = require('fs');
const path = require('path');

const switchesFile = (home) => path.join(home, 'intake', 'switches.json');

function readObject(home) {
  let text;
  try {
    text = fs.readFileSync(switchesFile(home), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { obj: {}, problem: null, present: false };
    return { obj: {}, problem: `${switchesFile(home)} could not be read (${e.code || e.message})`, present: true };
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { obj: {}, problem: `${switchesFile(home)} is not a JSON object`, present: true };
    return { obj, problem: null, present: true };
  } catch {
    return { obj: {}, problem: `${switchesFile(home)} could not be read as JSON`, present: true };
  }
}

function readSwitches(home) {
  const { obj, problem } = readObject(home);
  if (problem) return { judge: false, problem };
  if (!('judge' in obj)) return { judge: false, problem: null };
  if (typeof obj.judge !== 'boolean') return { judge: false, problem: `the judge in ${switchesFile(home)} is neither true nor false` };
  return { judge: obj.judge, problem: null };
}

function setJudge(home, on) {
  const file = switchesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { obj, problem } = readObject(home);
  const next = problem ? { judge: on === true } : { ...obj, judge: on === true };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

function judgeOn(env, home) {
  const v = env && env.ORUNMILA_JUDGE_LIVE;
  if (v === '1' || v === '0') return { on: v === '1', from: 'environment' };
  const { obj, problem } = readObject(home);
  if (!problem && typeof obj.judge === 'boolean') return { on: obj.judge, from: 'switch' };
  return { on: false, from: 'default' };
}

/**
 * PM2c2 (LD333): the daily update check, `{"updates": true | false}` in the same file, written by `orunmila install
 * --with-updates | --without-updates`; ORUNMILA_UPDATES=1 or 0 wins where set. Off with no switch at all; a plain
 * install sets it on unless it is set already (UD1, setUpdatesDefault below); the starter reads the same key itself
 * (src/runtime/orunmila-start.js).
 */
function setUpdates(home, on) {
  const file = switchesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { obj, problem } = readObject(home);
  const next = { ...(problem ? {} : obj), updates: on === true };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

function updatesOn(env, home) {
  const v = env && env.ORUNMILA_UPDATES;
  if (v === '0' || v === '1') return { on: v === '1', from: 'environment' };
  const { obj, problem } = readObject(home);
  if (!problem && typeof obj.updates === 'boolean') return { on: obj.updates, from: 'switch' };
  return { on: false, from: 'default' };
}

/**
 * UD1 (O's word, 2026-11-27, with MR7 and Q38; Q33's plan): a user's install turns the daily check on. Written only
 * when the switch holds neither true nor false and the file reads cleanly, so a choice already made either way is kept,
 * and a damaged file is left for `orunmila lenses` to name. A home no install made has no switch, and stays off.
 *   -> { written, file }
 */
function setUpdatesDefault(home) {
  const { obj, problem } = readObject(home);
  if (problem || typeof obj.updates === 'boolean') return { written: false, file: switchesFile(home) };
  return { written: true, file: setUpdates(home, true) };
}

/**
 * MR7 (R7, LD315) and PB1 (LD330): two of the intake's switches on by default since O's word of 2026-11-27, each
 * turned off by its variable set to 0 (any other value, or none, leaves it on): the log guard (TE1, LD279) and a
 * peer's busy notes (AT1b). -> { on, from: 'environment' | 'default' }
 */
const onUnlessZero = (v) => (v === '0' || v === '1' ? { on: v === '1', from: 'environment' } : { on: true, from: 'default' });
const logGuardOn = (env) => onUnlessZero(env && env.ORUNMILA_LOG_GUARD);
const peerBusyOn = (env) => onUnlessZero(env && env.ORUNMILA_PEER_BUSY);

module.exports = { switchesFile, readSwitches, setJudge, judgeOn, setUpdates, updatesOn, setUpdatesDefault, logGuardOn, peerBusyOn };
