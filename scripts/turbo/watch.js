'use strict';

/**
 * scripts/turbo/watch.js — the checks that make an escape from a TURBO session show up and stop
 * the run (O, 2026-11-22: "record where every write lands, check it, and make the close-out
 * declare it"; slices T18-T21, LD125-LD130).
 *
 * They detect; they do not prevent. The sandbox and the guard prevent, and these catch what got
 * past them: after each session, before the driver runs git again or starts the next session.
 *
 *   writeSentinelIgnore(root)   the clone's .orunmila/ignore: its Sentinel watches .turbo/ and
 *                               every build folder (T18), so a session's write there has a disk record
 *   tripwirePaths, fingerprint, changed      named files outside the clone that run code as O (T19)
 *   readLog(file, offset)       the event log from a byte offset (it is ~100 MB; a session's rows are the tail)
 *   outside(...)                what the Sentinels outside the clone and the tripwire saw in a
 *                               session's window, and which of it another session's record explains (T19)
 *
 * A finding is { check, detail }; the driver halts the run on any (LD127).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { BUILD_DIRS } = require('../../src/capture/fs-sentinel/ignore');

// --- T18: what the clone's Sentinel watches ------------------------------------------

/** The clone's Sentinel overrides: every build folder back in view, .turbo/ (TURBO's state) among them. */
function sentinelIgnoreText() {
  return [
    '# Written by the TURBO driver at the start of every run (slice T18, LD125); edits are overwritten.',
    '# The Sentinel watches the run state and every build folder, so a session write there has a disk record.',
    ...BUILD_DIRS.map((d) => `!${d}`),
    '',
  ].join('\n');
}

/** Write <root>/.orunmila/ignore, never through a link a session planted (LD117). Returns its path. */
function writeSentinelIgnore(root) {
  const dir = path.join(root, '.orunmila');
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {}
  if (st && !st.isDirectory()) throw new Error(`${dir} is not a directory (a symlink?); TURBO does not write through it`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ignore');
  try {
    fs.unlinkSync(file);
  } catch {}
  fs.writeFileSync(file, sentinelIgnoreText(), { flag: 'wx' });
  return file;
}

// --- T19: outside the clone ---------------------------------------------------------------

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const W_BEFORE = 1000; // ms a Sentinel row may sit before its Glove event (review/witness-join.py)
const W_AFTER = 3000; // ms after
const MAX_RUN = 600000; // ms: Claude Code's longest foreground command

/**
 * The files outside the clone that run code as O, or decide what runs (LD128). Directories are
 * fingerprinted file by file. `~/.claude/plugins` is left out: Claude Code rewrites its caches and
 * marketplace clone itself. An entry { json, pick } fingerprints only those keys of a JSON file.
 */
function tripwirePaths({ home = os.homedir(), live = path.join(home, 'tools', 'orunmila'), claudeProjects = null } = {}) {
  const h = (...p) => path.join(home, ...p);
  const list = [
    ...['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.profile', '.gitconfig'].map((f) => h(f)),
    h('.config', 'git'),
    h('.ssh', 'config'),
    h('.ssh', 'authorized_keys'),
    h('Library', 'LaunchAgents'),
    ...['settings.json', 'settings.local.json', 'CLAUDE.md', 'hooks', 'agents', 'commands', 'skills'].map((f) => h('.claude', f)),
    { json: h('.claude.json'), pick: 'mcpServers' },
    ...['config', 'hooks', 'info', 'commondir'].map((f) => path.join(live, '.git', f)),
  ];
  let projects = claudeProjects;
  if (projects === null) {
    try {
      projects = fs.readdirSync(h('.claude', 'projects')).map((n) => h('.claude', 'projects', n));
    } catch {
      projects = [];
    }
  }
  for (const p of projects) list.push(path.join(p, 'memory'));
  let worktrees = [];
  try {
    worktrees = fs.readdirSync(path.join(live, '.git', 'worktrees'));
  } catch {}
  for (const w of worktrees) for (const f of ['commondir', 'gitdir', 'config.worktree']) list.push(path.join(live, '.git', 'worktrees', w, f));
  return list;
}

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** { key: signature } for every entry: a file's sha256, a link's target, a JSON pick's sha256. Absent paths have no key. */
function fingerprint(entries) {
  const out = {};
  const visit = (p, depth) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) out[p] = `link:${fs.readlinkSync(p)}`;
    else if (st.isFile()) {
      try {
        out[p] = `file:${digest(fs.readFileSync(p))}`;
      } catch (err) {
        out[p] = `unreadable:${err.code}`;
      }
    } else if (st.isDirectory() && depth < 32) {
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch (err) {
        out[p] = `unreadable:${err.code}`;
      }
      for (const n of names) visit(path.join(p, n), depth + 1);
    }
  };
  for (const e of entries) {
    if (typeof e === 'string') visit(e, 0);
    else {
      let v;
      try {
        const j = JSON.parse(fs.readFileSync(e.json, 'utf8'));
        const projects = j.projects && typeof j.projects === 'object' ? j.projects : {};
        v = JSON.stringify([j[e.pick] || null, Object.keys(projects).sort().map((k) => [k, (projects[k] || {})[e.pick] || null])]);
      } catch (err) {
        v = err.code === 'ENOENT' ? null : `unreadable:${err.code || 'json'}`;
      }
      if (v !== null) out[`${e.json}#${e.pick}`] = `pick:${digest(v)}`;
    }
  }
  return out;
}

/** The keys whose signature differs, appeared or went: [{ path, was, now }]. */
function changed(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => before[k] !== after[k]).map((k) => ({ path: k, was: before[k] || 'absent', now: after[k] || 'absent' }));
}

/** The log's rows from byte `offset` on (from 0 if the log shrank, as `orunmila prune` rewrites it), and its size. */
function readLog(file, offset = 0) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { rows: [], size: 0 };
  }
  const from = size < offset ? 0 : offset;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - from);
  try {
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally {
    fs.closeSync(fd);
  }
  const rows = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t)) rows.push({ ...e, _t: t });
    } catch {}
  }
  return { rows, size };
}

const RECORD_TYPES = new Set(['file_write', 'command_run']);

/**
 * Another session's record that explains a change at `p` at time `t` (witness-join's rules): a
 * write on the same path or a command within 3 s, or a command whose span covers it (from that
 * session's previous record, at most 600 s back, to 1 s after its end). Returns the row or null.
 */
function explainer(rows, sid, p, t) {
  const others = rows.filter((x) => x.session_id && x.session_id !== sid && RECORD_TYPES.has(x.type));
  const tight = others.find((x) => Math.abs(x._t - t) <= W_AFTER && (x.path === p || x.type === 'command_run'));
  if (tight) return tight;
  for (const c of others) {
    if (c.type !== 'command_run' || t > c._t + W_BEFORE) continue;
    const prev = rows.filter((x) => x.session_id === c.session_id && x._t < c._t).reduce((m, x) => Math.max(m, x._t), -Infinity);
    if (t >= Math.max(prev, c._t - MAX_RUN)) return c;
  }
  return null;
}

/**
 * One session's outside checks (LD128): Sentinel rows under `roots` (not inside `clone`) in
 * [t0, t1], and the tripwire's changes; each needs another session's record to explain it.
 */
function outside({ rows, sid, roots, clone, t0, t1, before, after }) {
  const findings = [];
  const inClone = (p) => clone.some((c) => inside(p, c));
  const sen = rows.filter((e) => e.source === 'fs-sentinel' && e.type === 'file_write' && e._t >= t0 && e._t <= t1 && e.path && !inClone(e.path) && roots.some((r) => inside(e.path, r)));
  let explained = 0;
  for (const s of sen) {
    if (explainer(rows, sid, s.path, s._t)) explained++;
    else findings.push({ check: 'outside', detail: `the Sentinel recorded a change to ${s.path} at ${s.ts}, outside the clone, and no other session's record explains it` });
  }
  const trip = changed(before, after);
  let tripExplained = 0;
  const writesIn = rows.filter((x) => x._t >= t0 && x._t <= t1);
  for (const c of trip) {
    // Only a write on that very path explains it (a peer's memory note): no file here is one a
    // command of the project's would touch, so no command window counts.
    if (writesIn.some((x) => x.session_id && x.session_id !== sid && x.type === 'file_write' && x.path === c.path)) tripExplained++;
    else findings.push({ check: 'tripwire', detail: `${c.path} changed during the session (${c.was.slice(0, 12)} -> ${c.now.slice(0, 12)}), and no other session recorded writing it` });
  }
  return {
    findings,
    outside: { roots: roots.length, rows: sen.length, explained },
    tripwire: { paths: Object.keys(after).length, changed: trip.length, explained: tripExplained },
  };
}

module.exports = { sentinelIgnoreText, writeSentinelIgnore, tripwirePaths, fingerprint, changed, readLog, explainer, outside };
