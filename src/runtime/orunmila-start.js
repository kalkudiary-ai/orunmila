#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/orunmila-start.js — the one fixed starter every hook names (PM2b, LD331; Phase 5 plan section 6, Q33).
 * `orunmila install` copies it to `<home>/bin/orunmila-start.js` (`<home>` is Orunmila's home, `~/.orunmila` by
 * default) and writes each hook as `node "<home>/bin/orunmila-start.js" <script> [args]`. It reads the version folder
 * named in `<home>/runtime/current` (a text file, not a link: Windows restricts links) and runs that version's copy of
 * the script, so a hook never names a package runner's cache, and an update (PM2c) only rewrites `current`.
 *
 *   node orunmila-start.js <script> [args...]
 *     <script> one of Orunmila's own (SCRIPTS below), written with `/`; anything else is refused
 *     the script runs as its own process, with the same Node, environment, folder, input and arguments; its output
 *     and exit code are the starter's. (Run in this process, a script that starts only as the main module would do
 *     nothing, and a hook that does nothing records nothing: test 85's case.)
 *
 * Fails loud: no current version, a `current` that is not a plain folder name, or a version without the script, is
 * one line on stderr naming what to do, and exit 1. It loads Node's own modules only, so a damaged version folder
 * cannot stop it from saying so. The home is the folder above its own, never the environment, so a hook run with
 * another ORUNMILA_HOME still runs the version this install named.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = new Set([
  'src/capture/claude-code/user-prompt-submit.js',
  'src/capture/claude-code/pre-tool-use.js',
  'src/capture/claude-code/post-tool-use.js',
  'src/capture/claude-code/stop.js',
  'src/capture/claude-code/law-gate.js',
  'src/capture/claude-code/intake-send.js',
  'src/capture/connector.js',
  'bin/orunmila.js',
]);
const NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/; // a folder name: no separator, never `.` or `..`

function fail(words) {
  process.stderr.write(`orunmila: ${words}\n`);
  process.exit(1);
}

function main() {
  const home = path.resolve(__dirname, '..');
  const rel = process.argv[2];
  if (!SCRIPTS.has(rel)) fail(`the starter runs only Orunmila's own scripts, and "${rel}" is not one of them`);
  const file = path.join(home, 'runtime', 'current');
  let version = null;
  try {
    version = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    fail(`no current version is named (${file}: ${e.code || e.message}); run orunmila install again`);
  }
  if (!NAME.test(version)) fail(`${file} says "${version}", which is not a version folder's name; run orunmila install again`);
  const script = path.join(home, 'runtime', version, ...rel.split('/'));
  if (!fs.existsSync(script)) fail(`version ${version} has no ${rel} (${script}); run orunmila install again`);
  const r = spawnSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' });
  if (r.error) fail(`${rel} could not be run (${r.error.code || r.error.message})`);
  process.exit(r.status === null ? 1 : r.status);
}

main();
