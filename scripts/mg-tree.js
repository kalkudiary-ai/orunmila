// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/mg-tree.js — MG4: the mutation gate's launcher finds what a suite started by its place in the process
 * tree, so a process that leaves the suite's group and clears its environment is still killed when the suite ends.
 *
 * A process is known by its pid and its start time together, so a pid the system has reused for another process is
 * never killed. The table is read from `ps` (macOS) or /proc (Linux); elsewhere there is none, and nothing is tracked.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

/** Parse `ps -axww -o pid=,ppid=,lstart=` into Map pid -> { ppid, start }; `lstart` is five words. */
function parsePs(text) {
  const t = new Map();
  for (const row of text.split('\n')) {
    const w = row.trim().split(/\s+/);
    if (w.length < 7) continue;
    const pid = Number(w[0]);
    const ppid = Number(w[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    t.set(pid, { ppid, start: w.slice(2, 7).join(' ') });
  }
  return t;
}

/** Parse one /proc/<pid>/stat line: { ppid, start } (fields 4 and 22; the command name may hold spaces). */
function parseStat(text) {
  const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(f[1]), start: f[19] };
}

/** The process table now: Map pid -> { ppid, start }, or null where it cannot be read. `ps` itself is left out. */
function table() {
  if (process.platform === 'darwin') {
    const r = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', env: { LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`ps exit ${r.status}`);
    const t = parsePs(r.stdout);
    t.delete(r.pid);
    return t;
  }
  if (process.platform === 'linux') {
    const t = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(d)) continue;
      try {
        t.set(Number(d), parseStat(fs.readFileSync('/proc/' + d + '/stat', 'utf8')));
      } catch (e) {
        void e; // it ended while the table was read
      }
    }
    return t;
  }
  return null;
}

/**
 * Add to `tracked` (Map pid -> start) every process in `t` that descends from a pid in `roots` or from a process
 * already tracked and still the same process. A tracked process stays tracked after its parent ends.
 */
function track(t, roots, tracked) {
  if (!t) return tracked;
  const from = new Set(roots);
  for (const [pid, start] of tracked) if (t.has(pid) && t.get(pid).start === start) from.add(pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of t) {
      if (!from.has(pid) && from.has(p.ppid)) {
        from.add(pid);
        if (!tracked.has(pid)) tracked.set(pid, p.start);
        grew = true;
      }
    }
  }
  return tracked;
}

/** The tracked pids alive in `t` as the same process they were when tracked (a reused pid is left alone). */
function live(t, tracked) {
  if (!t) return [];
  return [...tracked].filter(([pid, start]) => t.has(pid) && t.get(pid).start === start).map(([pid]) => pid);
}

/** One line per tracked process, `pid start`, as the preload writes them and `readTracked` reads them back. */
const formatTracked = (tracked) => [...tracked].map(([pid, start]) => `${pid} ${start}\n`).join('');

function readTracked(text, tracked) {
  for (const row of text.split('\n')) {
    const i = row.indexOf(' ');
    if (i < 1) continue;
    const pid = Number(row.slice(0, i));
    if (Number.isInteger(pid) && !tracked.has(pid)) tracked.set(pid, row.slice(i + 1));
  }
  return tracked;
}

module.exports = { parsePs, parseStat, table, track, live, formatTracked, readTracked };
