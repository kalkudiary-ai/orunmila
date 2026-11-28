// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/install.js — the copy of Orunmila kept in its own home, and the hook commands that name the starter
 * (PM2b, LD331; Phase 5 plan section 6, Q33). A hook written with the path of whichever copy ran `install` breaks when
 * that copy goes (npx's and pnpm's caches are cleared, a global folder moves): it then runs nothing and records
 * nothing. So `install` copies what the package ships into `<home>/runtime/<version>_<fingerprint>/`, names that
 * folder in `<home>/runtime/current`, puts the starter at `<home>/bin/orunmila-start.js`, and every hook names the
 * starter.
 *
 *   shippedFiles(from)      the files the package at `from` ships, `/`-separated and sorted: package.json and every
 *                           file under each entry of its `files` list (as `npm pack` takes them); links skipped
 *   installRuntime({ home, from })
 *                           -> { version, folder, dir, starter, fresh }: the copy made (or kept: the same bytes give
 *                           the same folder, `fresh` false), `current` and the starter written, each placed whole
 *                           (written beside, then renamed); folders 0700 and files 0600, as the rest of the home
 *   hookCommand(home, rel)  `node "<home>/bin/orunmila-start.js" <rel>`, the form every hook takes
 *   starterTarget(starter, rel)
 *                           -> { ok, file, words }: the file a hook naming `starter` and `rel` runs today, for
 *                           `orunmila status` (PM3)
 *
 * The folder's name holds the first 12 hex of a SHA-256 over every shipped file's path, size and bytes, so two copies
 * with one version number but other bytes (a git clone between releases) are two folders, and installing the same
 * bytes again changes nothing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STARTER = 'orunmila-start.js';
const SOURCE = path.join(__dirname, STARTER);

function shippedFiles(from) {
  const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  const walk = (rel) => {
    const st = fs.lstatSync(path.join(from, ...rel.split('/')));
    if (st.isDirectory()) for (const name of fs.readdirSync(path.join(from, ...rel.split('/')))) walk(`${rel}/${name}`);
    else if (st.isFile()) out.add(rel);
  };
  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    const rel = String(entry).replace(/\\/g, '/').replace(/\/+$/, '');
    if (fs.existsSync(path.join(from, ...rel.split('/')))) walk(rel);
  }
  return [...out].sort();
}

function fingerprintOf(from, files) {
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(from, ...rel.split('/')));
    h.update(`${rel}\0${buf.length}\0`);
    h.update(buf);
  }
  return h.digest('hex');
}

/** A file placed whole: written beside its place, owner-only, then renamed over it. */
function placeFile(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const ownDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
};

function installRuntime({ home, from }) {
  const version = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).version;
  const files = shippedFiles(from);
  const folder = `${version}_${fingerprintOf(from, files).slice(0, 12)}`;
  const runtime = path.join(home, 'runtime');
  ownDir(home);
  ownDir(runtime);
  const dir = path.join(runtime, folder);
  let fresh = false;
  if (!fs.existsSync(dir)) {
    const incoming = path.join(runtime, `.incoming-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      for (const rel of files) {
        const to = path.join(incoming, ...rel.split('/'));
        ownDir(path.dirname(to));
        fs.copyFileSync(path.join(from, ...rel.split('/')), to);
        fs.chmodSync(to, 0o600);
      }
      fs.renameSync(incoming, dir);
      fresh = true;
    } finally {
      fs.rmSync(incoming, { recursive: true, force: true }); // gone after the rename; a copy cut short is never left
    }
  }
  placeFile(path.join(runtime, 'current'), folder + '\n');
  ownDir(path.join(home, 'bin'));
  const starter = path.join(home, 'bin', STARTER);
  placeFile(starter, fs.readFileSync(SOURCE));
  return { version, folder, dir, starter, fresh };
}

const hookCommand = (home, rel) => `node "${path.join(home, 'bin', STARTER)}" ${rel}`;

function starterTarget(starter, rel) {
  const runtime = path.join(path.dirname(path.dirname(starter)), 'runtime');
  let version;
  try {
    version = fs.readFileSync(path.join(runtime, 'current'), 'utf8').trim();
  } catch {
    return { ok: false, file: path.join(runtime, 'current'), words: 'no current version is named' };
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version) || typeof rel !== 'string') return { ok: false, file: path.join(runtime, 'current'), words: 'the current version is not a folder name' };
  const file = path.join(runtime, version, ...rel.split('/'));
  return fs.existsSync(file) ? { ok: true, file, words: null } : { ok: false, file, words: `version ${version} has no ${rel}` };
}

/** The first 12 hex of a folder's fingerprint over `files`, as a version folder's name holds it (PM2c1 names a download so). */
const fingerprintFolder = (from, files) => fingerprintOf(from, files).slice(0, 12);
/** Every script the starter runs, from the starter itself (PM2c1's self-check). */
const STARTER_SCRIPTS = [...require('./orunmila-start').SCRIPTS];

module.exports = { shippedFiles, installRuntime, hookCommand, starterTarget, fingerprintFolder, STARTER, STARTER_SCRIPTS };
