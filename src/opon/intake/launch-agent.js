'use strict';

/**
 * src/opon/intake/launch-agent.js — the per-user launch agent that keeps one
 * intake running (slice LA, LD143; design D-I 4.1: started by a per-user launch
 * agent until Phase 5's separate user). macOS only; on any other platform every
 * action refuses and says so (Linux's per-user service is not built).
 *
 *   plistFor({ node, script, home, env })   the property list, as text
 *   createLaunchAgent({ platform, uid, dir, run })
 *     dir   the LaunchAgents folder (~/Library/LaunchAgents)
 *     run   (args) -> { status, stdout, stderr }: runs launchctl with args
 *     .install({ node, script, home, env }) -> { ok, plist } or { ok: false, reason }
 *           writes <dir>/<LABEL>.plist (0644), boots out any earlier agent of the
 *           label, then bootstraps it into gui/<uid>; a failed bootstrap removes
 *           the plist again and gives launchctl's words
 *     .uninstall() -> { ok, removed: <plist path> | null }: boots it out, removes the plist
 *     .status()    -> { ok, loaded, state, pid, plist }: from `launchctl print`
 *
 * The agent runs `<node> <script> intake run`, at load, and launchd restarts it
 * only after a failed exit (KeepAlive SuccessfulExit false): a crash, an
 * uncaught error, or a signal no one asked for (TE2, LD283: recorded as
 * tampering, exit 1); `orunmila intake stop` asks over the socket and exits 0
 * (LD132), so it stays a stop; a refused start (another intake runs: exit 3) is
 * retried every ThrottleInterval seconds. Only ORUNMILA_HOME,
 * ORUNMILA_INTAKE_PORT and ORUNMILA_OPON_LIVE (LA2, LD219) are copied from the
 * installing environment, and only when set.
 */

const fs = require('fs');
const path = require('path');

const LABEL = 'dev.orunmila.intake';
const ENV_KEYS = ['ORUNMILA_HOME', 'ORUNMILA_INTAKE_PORT', 'ORUNMILA_OPON_LIVE']; // LA2 (LD219): the live flag kept across restarts
const THROTTLE_S = 10;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s, pad) => `${pad}<string>${xml(s)}</string>`;

function plistFor({ node, script, home, env = {} }) {
  const out = path.join(home, 'intake', 'intake.out');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str(LABEL, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[node, script, 'intake', 'run'].map((a) => str(a, '    ')),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${THROTTLE_S}</integer>`,
    '  <key>StandardOutPath</key>',
    str(out, '  '),
    '  <key>StandardErrorPath</key>',
    str(out, '  '),
  ];
  const set = ENV_KEYS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  if (set.length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const k of set) lines.push(`    <key>${k}</key>`, str(env[k], '    '));
    lines.push('  </dict>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

const words = (r) => String((r && (r.stderr || r.stdout)) || '').trim() || `launchctl exited ${r && r.status}`;

function createLaunchAgent({ platform = process.platform, uid, dir, run }) {
  const plist = path.join(dir, `${LABEL}.plist`);
  const service = `gui/${uid}/${LABEL}`;
  const refuse = () => ({ ok: false, reason: `the launch agent is macOS only (this is ${platform}); start the intake with \`orunmila intake start\` instead` });

  function install(o) {
    if (platform !== 'darwin') return refuse();
    fs.mkdirSync(dir, { recursive: true });
    run(['bootout', service]); // an earlier agent of this label, if any; "no such process" otherwise
    const tmp = `${plist}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, plistFor(o), { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, plist);
    const r = run(['bootstrap', `gui/${uid}`, plist]);
    if (r.status !== 0) {
      fs.rmSync(plist, { force: true });
      return { ok: false, reason: `launchctl bootstrap refused the agent: ${words(r)}` };
    }
    return { ok: true, plist };
  }

  function uninstall() {
    if (platform !== 'darwin') return refuse();
    run(['bootout', service]);
    if (!fs.existsSync(plist)) return { ok: true, removed: null };
    fs.rmSync(plist, { force: true });
    return { ok: true, removed: plist };
  }

  function status() {
    if (platform !== 'darwin') return refuse();
    const on = fs.existsSync(plist) ? plist : null;
    const r = run(['print', service]);
    if (r.status !== 0) return { ok: true, loaded: false, state: null, pid: null, plist: on };
    const text = String(r.stdout || '');
    const state = /^\s*state = (.+)$/m.exec(text);
    const pid = /^\s*pid = ([0-9]+)$/m.exec(text);
    return { ok: true, loaded: true, state: state ? state[1].trim() : null, pid: pid ? Number(pid[1]) : null, plist: on };
  }

  return { install, uninstall, status, plist, service };
}

module.exports = { createLaunchAgent, plistFor, LABEL };
