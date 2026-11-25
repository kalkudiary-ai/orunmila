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
 *                            Claude Code binary's own name, measured 2026-11-22).
 *                            Limit, stated: any program the agent's account
 *                            names `claude` passes; preventing that waits for
 *                            Phase 5's separate user.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) || null;
const AGENT_PROGRAMS = new Set(['claude']);

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
    if (!LSOF || socket.remoteAddress !== '127.0.0.1') return resolve(null);
    execFile(LSOF, ['-nP', '-a', `-iTCP@127.0.0.1:${socket.remotePort}`, '-Fpn'], { timeout: 5000 }, (err, stdout) => {
      // lsof exits 1 when one of its selections matched nothing; its rows still count.
      const hit = lsofRows(stdout || '').find((r) => r.names.includes(`${client}->${server}`));
      resolve(hit && Number.isInteger(hit.pid) ? hit.pid : null);
      void err;
    });
  });
}

function holderPid(port) {
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
  let comm;
  try {
    comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return false; // no such process
  }
  return AGENT_PROGRAMS.has(path.basename(comm));
}

module.exports = { peerPid, holderPid, isAgentProgram, lsofRows };
