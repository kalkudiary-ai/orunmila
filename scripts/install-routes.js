#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/install-routes.js — every way a user installs Orunmila, run and checked (PM1, LD335; Phase 5 plan section 6).
 * This repository is packed twice (its own version, and the same with the patch number raised, for an upgrade), and
 * each route installs it into a throwaway machine: HOME, ORUNMILA_HOME, npm's cache and prefix, and pnpm's home, store
 * and cache all inside one temporary folder. For each route:
 *
 *   hooks      every hook command the install wrote names the starter in Orunmila's home (PM2b), none the route's copy
 *   ran        the prompt hook, run exactly as written through the platform's shell, exits 0 and is recorded
 *   gone       the route's copy (its cache, store, global folder or node_modules) removed, and checked gone
 *   cleared    after that, the hook still runs and records
 *   upgrade    the next version installed by the same route and `orunmila install` run again: its exit, what it said,
 *              and the version the starter runs after it
 *
 * Routes: npm-global (npm i -g), npx (npx --package), npm-dev (npm i -D, then npx), pnpm-dlx (pnpm --package dlx),
 * pnpm-global (pnpm add -g), pnpm-dev (pnpm add -D, then pnpm exec). pnpm is pnpm on the PATH, else corepack's
 * (fetched once into the throwaway folder, which needs the network); a route whose tool cannot run says so.
 *
 *   node scripts/install-routes.js [--only npm|pnpm|<route>]
 *     prints one JSON line per route, then { ok }; exit 0 when every route that ran passed hooks, ran and cleared
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const win = process.platform === 'win32';
// CI2 (LD341): through cmd.exe each argument is quoted, so a path with a space stays one argument.
const quoted = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
const sh = (cmd, args, opts) => spawnSync(cmd, win ? args.map(quoted) : args, { encoding: 'utf8', shell: win, timeout: 300000, ...opts });

function pack(base, env, version) {
  const src = path.join(base, `src-${version}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of pkg.files) if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(src, f), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ ...pkg, version, scripts: {}, devDependencies: {} }, null, 2));
  const r = sh('npm', ['pack', '--pack-destination', base, src], { env, cwd: base });
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
  return path.join(base, r.stdout.trim().split('\n').pop());
}

function machine(base, name) {
  const m = path.join(base, name);
  const d = { home: path.join(m, 'user'), data: path.join(m, 'orunmila home'), project: path.join(m, 'a project'), prefix: path.join(m, 'npm prefix'), cache: path.join(m, 'npm-cache'), pnpmHome: path.join(m, 'pnpm-home'), store: path.join(m, 'pnpm-store'), pcache: path.join(m, 'pnpm-cache') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.project, 'package.json'), JSON.stringify({ name: 'a-project', version: '1.0.0', private: true }));
  const bin = win ? d.prefix : path.join(d.prefix, 'bin');
  const env = {
    ...process.env,
    HOME: d.home,
    USERPROFILE: d.home,
    ORUNMILA_HOME: d.data,
    ORUNMILA_UPDATES: '0',
    npm_config_prefix: d.prefix,
    npm_config_cache: d.cache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    PNPM_HOME: d.pnpmHome,
    npm_config_store_dir: d.store,
    npm_config_cache_dir: d.pcache,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    PATH: [bin, d.pnpmHome, process.env.PATH].join(path.delimiter),
  };
  return { ...d, env };
}

/** The pnpm command: pnpm on the PATH, else corepack's; null when neither runs. */
function pnpmCommand(env) {
  if (sh('pnpm', ['--version'], { env }).status === 0) return ['pnpm'];
  if (sh('corepack', ['pnpm@9.15.9', '--version'], { env }).status === 0) return ['corepack', 'pnpm@9.15.9'];
  return null;
}

// `readme`: the line README.md gives for the route (PM4, LD337; test/install-routes.js holds that it is there).
const ROUTES = {
  'npm-global': { tool: 'npm', readme: 'npm install -g orunmila', install: (m, tgz) => [['npm', ['install', '-g', tgz]], ['orunmila', ['install']]], clear: (m) => [path.join(m.prefix, win ? '' : 'lib', 'node_modules', 'orunmila')] },
  npx: { tool: 'npm', readme: 'npx orunmila install', install: (m, tgz) => [['npx', ['--yes', '--package', tgz, 'orunmila', 'install']]], clear: (m) => [path.join(m.cache, '_npx')] },
  'npm-dev': { tool: 'npm', readme: 'npm install -D orunmila', install: (m, tgz) => [['npm', ['install', '-D', tgz]], ['npx', ['--no-install', 'orunmila', 'install']]], clear: (m) => [path.join(m.project, 'node_modules')] },
  'pnpm-dlx': { tool: 'pnpm', readme: 'pnpm dlx orunmila install', install: (m, tgz, p) => [[p[0], [...p.slice(1), '--package', tgz, 'dlx', 'orunmila', 'install']]], clear: (m) => [m.pcache, m.store] },
  'pnpm-global': { tool: 'pnpm', readme: 'pnpm add -g orunmila', install: (m, tgz, p) => [[p[0], [...p.slice(1), 'add', '-g', tgz]], ['orunmila', ['install']]], clear: (m) => [path.join(m.pnpmHome, 'global'), m.store] },
  'pnpm-dev': { tool: 'pnpm', readme: 'pnpm add -D orunmila', install: (m, tgz, p) => [[p[0], [...p.slice(1), 'add', '-D', tgz]], [p[0], [...p.slice(1), 'exec', 'orunmila', 'install']]], clear: (m) => [path.join(m.project, 'node_modules'), m.store] },
};

function hooksOf(m) {
  const s = JSON.parse(fs.readFileSync(path.join(m.project, '.claude', 'settings.json'), 'utf8'));
  return Object.entries(s.hooks).flatMap(([event, es]) => es.flatMap((e) => (e.hooks || []).filter((h) => h.type === 'command').map((h) => ({ event, command: h.command }))));
}

function prompt(m, words) {
  const c = hooksOf(m).find((h) => h.event === 'UserPromptSubmit');
  const r = spawnSync(c.command, { shell: true, cwd: m.project, env: m.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'routes', transcript_path: path.join(m.home, 't.jsonl'), cwd: m.project, hook_event_name: 'UserPromptSubmit', prompt: words }), timeout: 60000 });
  let recorded;
  try {
    recorded = fs.readFileSync(path.join(m.data, 'events.jsonl'), 'utf8').split('\n').some((l) => l.includes(JSON.stringify(words)));
  } catch {
    recorded = false; // no event log: nothing recorded
  }
  return r.status === 0 && recorded;
}

function runRoute(base, name, a, b, pnpm) {
  const route = ROUTES[name];
  const m = machine(base, name);
  const out = { route: name };
  const p = route.tool === 'pnpm' ? pnpm(m.env) : null;
  if (route.tool === 'pnpm' && !p) return { ...out, skipped: 'pnpm could not run (not on the PATH, and corepack could not fetch it)' };
  const steps = (tgz) => {
    for (const [cmd, args] of route.install(m, tgz, p)) {
      const r = sh(cmd, args, { env: m.env, cwd: m.project });
      if (r.status !== 0) return { status: r.status, said: `${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(-400)}` };
    }
    return { status: 0 };
  };
  const first = steps(a);
  if (first.status !== 0) return { ...out, failed: first.said };
  const starter = path.join(m.data, 'bin', 'orunmila-start.js');
  out.hooks = hooksOf(m).every((h) => h.command.startsWith(`node "${starter}" `));
  out.ran = prompt(m, 'before clearing');
  for (const x of route.clear(m)) fs.rmSync(x, { recursive: true, force: true });
  out.gone = route.clear(m).every((x) => !fs.existsSync(x)); // the route's copy is really gone, so `cleared` means something
  out.cleared = prompt(m, 'after clearing');
  const up = steps(b);
  out.upgrade = { status: up.status, said: up.said || null, runs: spawnSync(process.execPath, [starter, 'bin/orunmila.js', '--version'], { encoding: 'utf8' }).stdout.trim() };
  out.ok = out.hooks && out.ran && out.gone && out.cleared;
  return out;
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila routes ')));
  const results = [];
  try {
    const env = { ...process.env, npm_config_cache: path.join(base, 'pack-cache'), npm_config_update_notifier: 'false' };
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const next = version.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, x, y, z) => `${x}.${y}.${Number(z) + 1}`);
    const a = pack(base, env, version);
    const b = pack(base, env, next);
    let pn;
    const pnpm = (e) => (pn === undefined ? (pn = pnpmCommand(e)) : pn);
    for (const name of Object.keys(ROUTES)) {
      if (only && only !== name && only !== ROUTES[name].tool) continue;
      let r;
      try {
        r = runRoute(base, name, a, b, pnpm);
      } catch (e) {
        r = { route: name, failed: e.message };
      }
      results.push(r);
      process.stdout.write(JSON.stringify(r) + '\n');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  const ok = results.length > 0 && results.every((r) => r.ok || r.skipped);
  process.stdout.write(JSON.stringify({ ok, ran: results.filter((r) => !r.skipped).length, skipped: results.filter((r) => r.skipped).length }) + '\n');
  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { ROUTES, pack, machine, sh, hooksOf }; // the last four: scripts/upgrade-proof.js (EU2) shares them
