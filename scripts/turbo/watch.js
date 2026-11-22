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

// --- T20: the clone's .git, read by fs (LD129), and its links (LD130) ---------------------

// What a TURBO clone's .git holds, and what git adds in the commands sessions may run (commit,
// add, reset, read-tree, worktree, an automatic gc). Anything else is not read past: a planted
// commondir or gitdir sends git to another config and hooks, and the next unsandboxed git runs them.
const GIT_TOP = new Set(['HEAD', 'config', 'description', 'hooks', 'info', 'objects', 'refs', 'logs', 'index', 'packed-refs', 'COMMIT_EDITMSG', 'ORIG_HEAD', 'FETCH_HEAD', 'shallow', 'branches', 'worktrees', 'gc.pid', 'gc.log']);
// The config keys a clone is made with (measured on a clone made as cloneRepo makes it, git 2.50.1).
const CONFIG_KEYS = { core: ['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks'], turbo: ['source'], branch: ['remote', 'merge'] };

/** Parse a git config file: { entries: [{ section, sub, key, value }], bad: [lines it cannot model] }. */
function parseGitConfig(text) {
  const entries = [];
  const bad = [];
  let section = null;
  let sub = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    let m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:[#;].*)?$/.exec(line);
    if (m) {
      const name = m[1].toLowerCase();
      const dot = name.indexOf('.');
      section = dot < 0 ? name : name.slice(0, dot);
      sub = m[2] !== undefined ? m[2] : dot < 0 ? null : name.slice(dot + 1);
      continue;
    }
    m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    // A value continued on the next line, or a key before any section, is not modelled: fail closed.
    if (m && section && !line.endsWith('\\')) {
      let value = m[2] === undefined ? 'true' : m[2].trim();
      const q = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
      if (q) value = q[1].replace(/\\(.)/g, '$1');
      entries.push({ section, sub, key: m[1].toLowerCase(), value });
      continue;
    }
    bad.push(raw);
  }
  return { entries, bad };
}

/**
 * The clone's .git, checked by fs only (LD129): { findings, digest, source }. `digest` covers the
 * config, hooks and info, so a later call shows any change; `source` is turbo.source.
 */
function gitSetup(root) {
  const findings = [];
  const f = (detail) => findings.push({ check: 'git', detail });
  const dir = path.join(root, '.git');
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    f(`${dir} is missing`);
    return { findings, digest: null, source: null };
  }
  if (st.isSymbolicLink()) f(`${dir} is a symlink`);
  else if (!st.isDirectory()) f(`${dir} is a file, not a directory: a linked worktree, whose .git is shared with another checkout (LD116), or a planted gitfile`);
  if (findings.length) return { findings, digest: null, source: null };

  for (const n of fs.readdirSync(dir).sort()) {
    if (GIT_TOP.has(n) || n.endsWith('.lock')) continue;
    f(`${path.join(dir, n)} is not part of a TURBO clone's .git${n === 'commondir' || n === 'gitdir' ? `: a planted ${n} sends git to another config and hooks` : ''}`);
  }
  // No link anywhere in it but the object store (whose files git only reads as data).
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) f(`${p} is a symlink`);
      else if (e.isDirectory() && p !== path.join(dir, 'objects')) stack.push(p);
    }
  }
  for (const a of ['alternates', 'http-alternates']) if (fs.existsSync(path.join(dir, 'objects', 'info', a))) f(`${path.join(dir, 'objects', 'info', a)} sends git to another object store`);

  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'config'), 'utf8');
  } catch (err) {
    f(`cannot read ${path.join(dir, 'config')}: ${err.code}`);
  }
  const { entries, bad } = parseGitConfig(text);
  for (const b of bad) f(`the config has a line this check cannot read, and git may: ${b.trim().slice(0, 80)}`);
  for (const e of entries) {
    const ok = CONFIG_KEYS[e.section];
    const name = `${e.section}${e.sub !== null ? `.${e.sub}` : ''}.${e.key}`;
    if (!ok || !ok.includes(e.key) || (e.section !== 'branch' && e.sub !== null)) f(`the config sets ${name}, which a TURBO clone is not made with`);
  }
  const src = entries.find((e) => e.section === 'turbo' && e.sub === null && e.key === 'source');

  const parts = [text];
  for (const sub of ['hooks', 'info']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, sub)).sort();
    } catch {}
    for (const n of names) {
      const p = path.join(dir, sub, n);
      const s = fs.lstatSync(p);
      if (sub === 'hooks' && !(s.isFile() && n.endsWith('.sample'))) f(`${p} is a hook git would run`);
      parts.push(`${sub}/${n}:${s.isFile() ? digest(fs.readFileSync(p)) : s.isDirectory() ? 'dir' : 'other'}`);
    }
  }
  return { findings, digest: digest(parts.join('\0')), source: src ? src.value : null };
}

/** The links cloneRepo makes, at the targets the source has: { relPath: target }. */
function cloneLinks(source) {
  const out = {};
  if (!source) return out;
  try {
    out.node_modules = fs.realpathSync(path.join(source, 'node_modules'));
  } catch {}
  for (const f of ['CLAUDE.md', path.join('docs', 'AGENT_OPERATING_RULES.md')]) {
    try {
      out[f] = fs.readlinkSync(path.join(source, f));
    } catch {}
  }
  return out;
}

/** Every link in the clone (not under .git) whose target is outside it, but the made ones (LD130). */
function linkScan(root, allowed = {}) {
  const findings = [];
  let scanned = 0;
  const realRoot = fs.realpathSync(root);
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (d === root && e.name === '.git') continue;
      scanned++;
      if (e.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        let real;
        try {
          real = fs.realpathSync(p);
        } catch {
          real = path.resolve(fs.realpathSync(d), target); // dangling: where it would land
        }
        if (inside(real, realRoot)) continue;
        const rel = path.relative(root, p);
        if (Object.prototype.hasOwnProperty.call(allowed, rel) && allowed[rel] === target) continue;
        const made = Object.prototype.hasOwnProperty.call(allowed, rel) ? ` (it was made to point at ${allowed[rel]})` : '';
        findings.push({ check: 'links', detail: `${p} is a link to ${target}, outside the clone${made}` });
      } else if (e.isDirectory()) stack.push(p);
    }
  }
  return { findings, scanned };
}

module.exports = { sentinelIgnoreText, writeSentinelIgnore, tripwirePaths, fingerprint, changed, readLog, explainer, outside, parseGitConfig, gitSetup, cloneLinks, linkScan };
