// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/startup-win.js — the intake started at each login on Windows (Phase 5 plan section 7, slice W2b,
 * LD338), as the launch agent does on macOS (launch-agent.js). A script in the user's own Startup folder, which needs
 * no administrator rights: `orunmila-intake.vbs`, run by Windows Script Host at login, starts node hidden (no console
 * window) on the arguments it is given, `orunmila intake keep` through the starter, which keeps the intake running
 * (a failed exit started again, as launchd's KeepAlive). The intake's switches that are set when it is installed are
 * set again in the script's own environment, the same list the launch agent keeps (launch-agent.js ENV_KEYS).
 *
 *   vbsFor({ node, args, env }) -> the script's text
 *   createStartup({ platform, dir })
 *     dir   the Startup folder (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup)
 *     .install({ node, args, env }) -> { ok, file } | { ok: false, reason }: written whole, UTF-16 with its byte-order
 *           mark (Windows Script Host reads a file without one in the system's code page, so a path with a letter
 *           outside it would break)
 *     .uninstall() -> { ok, removed: file | null }
 *     .status() -> { ok, installed, file }
 *   On any platform but win32 each refuses and says what to use there.
 *
 * Quoting: each argument in double quotes (Windows forbids `"` in a file name; one in an argument is doubled), and the
 * whole command written into a VBScript string, every `"` doubled again.
 */

const fs = require('fs');
const path = require('path');
const { ENV_KEYS } = require('./launch-agent');

const STARTUP_NAME = 'orunmila-intake.vbs';
const vb = (s) => `"${String(s).replace(/"/g, '""')}"`;

function vbsFor({ node, args, env = {} }) {
  const command = [node, ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ');
  const set = ENV_KEYS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
  return [
    "' Orunmila: the intake, started hidden at each login and kept running (orunmila intake agent install, W2b).",
    "' Remove with: orunmila intake agent uninstall",
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("PROCESS")',
    ...set.map((k) => `env(${vb(k)}) = ${vb(env[k])}`),
    `sh.Run ${vb(command)}, 0, False`,
    '',
  ].join('\r\n');
}

function createStartup({ platform = process.platform, dir }) {
  const file = path.join(dir, STARTUP_NAME);
  const refuse = () => ({ ok: false, reason: `the Startup script is Windows only (this is ${platform}); on macOS the launch agent starts the intake, and elsewhere start it with \`orunmila intake start\`` });

  function install(o) {
    if (platform !== 'win32') return refuse();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbsFor(o), 'utf16le')]));
    fs.renameSync(tmp, file);
    return { ok: true, file };
  }

  function uninstall() {
    if (platform !== 'win32') return refuse();
    if (!fs.existsSync(file)) return { ok: true, removed: null };
    fs.rmSync(file, { force: true });
    return { ok: true, removed: file };
  }

  const status = () => (platform !== 'win32' ? refuse() : { ok: true, installed: fs.existsSync(file), file });

  return { install, uninstall, status, file };
}

module.exports = { vbsFor, createStartup, STARTUP_NAME };
