// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/peer.js — who is on the other end of the intake's HTTP port
 * (slice H1, LD139; design D-I 4.2(a), 4.6; NF49). Built-ins and the system's
 * own lsof and ps only, with no administrator rights.
 *
 *   peerPid(socket)       -> Promise<pid | null>: the process holding the client
 *                            end of an accepted loopback TCP connection. From
 *                            `lsof -Fpn` on the client's port: the row whose name
 *                            is `<client>-><server>` is the client's end. null
 *                            when lsof is missing, fails, or names no such row.
 *   holderPid(port)       -> pid | null: the process listening on 127.0.0.1:<port>
 *                            (a squatter, test 83), by the same lsof
 *   isAgentProgram(pid)   -> boolean: the pid runs a program named `claude` (the
 *                            Claude Code binary's own name, measured 2026-11-22;
 *                            `claude.exe` on Windows). Limit, stated: any program
 *                            the agent's account names `claude` passes; preventing
 *                            that waits for Phase 5's separate user.
 *
 * W3e (Windows): there is no lsof or ps, so each lookup returned null and every HTTP payload was tampered. On Windows
 * the system's own netstat (`-ano -p TCP`: local, foreign, state, pid columns) and tasklist (CSV, one row) are read,
 * from %SystemRoot%\System32, never from PATH, with no administrator rights. A listening row is told by its foreign
 * address 0.0.0.0:0, not by the state word, which Windows translates.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const WIN = process.platform === 'win32';
const SYS32 = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : null;
const NETSTAT = WIN && fs.existsSync(path.join(SYS32, 'netstat.exe')) ? path.join(SYS32, 'netstat.exe') : null;
const TASKLIST = WIN && fs.existsSync(path.join(SYS32, 'tasklist.exe')) ? path.join(SYS32, 'tasklist.exe') : null;
const LSOF = WIN ? null : ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) || null;
const AGENT_PROGRAMS = new Set(['claude']);

/** The TCP rows of `netstat -ano -p TCP` output: [{ local, foreign, pid }] (W3e). */
function netstatRows(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 4) continue;
    const pid = Number(f[f.length - 1]);
    if (Number.isInteger(pid) && pid >= 0) rows.push({ local: f[1], foreign: f[2], pid });
  }
  return rows;
}

/** The program name of a `tasklist /FO CSV /NH` row for `pid`, less `.exe`, or null (W3e). */
function tasklistName(text, pid) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1].replace(/\.exe$/i, '');
  }
  return null;
}

const winOpts = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

/** The rows of `lsof -F pn` output: [{ pid, names: [...] }]. */
function lsofRows(text) {
  const rows = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) {
      cur = { pid: Number(line.slice(1)), names: [] };
      rows.push(cur);
    } else if (line.startsWith('n') && cur) cur.names.push(line.slice(1));
  }
  return rows;
}

function peerPid(socket) {
  return new Promise((resolve) => {
    const client = `${socket.remoteAddress}:${socket.remotePort}`;
    const server = `${socket.localAddress}:${socket.localPort}`;
    if (socket.remoteAddress !== '127.0.0.1') return resolve(null);
    if (WIN) {
      if (!NETSTAT) return resolve(null);
      // W3e: the client's own row is local <client>, foreign <server>; the server's row is the other way round.
      return execFile(NETSTAT, ['-ano', '-p', 'TCP'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        const hit = netstatRows(stdout || '').find((r) => r.local === client && r.foreign === server);
        resolve(hit ? hit.pid : null);
        void err;
      });
    }
    if (!LSOF) return resolve(null);
    execFile(LSOF, ['-nP', '-a', `-iTCP@127.0.0.1:${socket.remotePort}`, '-Fpn'], { timeout: 5000 }, (err, stdout) => {
      // lsof exits 1 when one of its selections matched nothing; its rows still count.
      const hit = lsofRows(stdout || '').find((r) => r.names.includes(`${client}->${server}`));
      resolve(hit && Number.isInteger(hit.pid) ? hit.pid : null);
      void err;
    });
  });
}

function holderPid(port) {
  if (WIN) {
    if (!NETSTAT) return null;
    let text;
    try {
      text = execFileSync(NETSTAT, ['-ano', '-p', 'TCP'], winOpts);
    } catch (e) {
      text = (e && e.stdout) || '';
    }
    const hit = netstatRows(text).find((r) => r.local === `127.0.0.1:${port}` && r.foreign === '0.0.0.0:0'); // W3e: a listening row
    return hit ? hit.pid : null;
  }
  if (!LSOF) return null;
  let out;
  try {
    out = execFileSync(LSOF, ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    out = (e && e.stdout) || '';
  }
  const hit = lsofRows(out).find((r) => r.names.includes(`127.0.0.1:${port}`));
  return hit && Number.isInteger(hit.pid) ? hit.pid : null;
}

function isAgentProgram(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (WIN) {
    if (!TASKLIST) return false;
    try {
      return AGENT_PROGRAMS.has(tasklistName(execFileSync(TASKLIST, ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`], winOpts), pid));
    } catch {
      return false;
    }
  }
  let comm;
  try {
    comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return false; // no such process
  }
  return AGENT_PROGRAMS.has(path.basename(comm));
}

module.exports = { peerPid, holderPid, isAgentProgram, lsofRows, netstatRows, tasklistName };
