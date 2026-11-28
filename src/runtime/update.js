// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/update.js — Orunmila updating itself (PM2c1, LD332; Phase 5 plan section 6, Q33; LD268). The copy `install`
 * keeps in Orunmila's home (PM2b, src/runtime/install.js) is replaced by a newer one from npm's registry, only while no
 * session is held, so no session's record sees its code change.
 *
 *   updateNow({ home, registry, held, name? }) -> Promise<{ status, words }>
 *     status: up_to_date | switched | waiting | refused | failed
 *     In order: the version in use, from `runtime/current` (none: refused, install first); the registry's `latest`
 *     (src/runtime/registry.js, the one file that reaches the network); a version not newer is up to date. Else the
 *     package is downloaded, unless one already waits for it (`runtime/pending`), and its bytes are checked against
 *     the integrity hash the registry gives (refused when they differ: nothing kept); it is unpacked (untar.js) into
 *     its own folder, named as install names one (`<version>_<fingerprint>`), placed whole; and its self-check runs.
 *     A failed self-check removes the folder and is recorded (self_check fail, switched false). With a session held
 *     (`held()`), the checked folder waits, named in `runtime/pending`. Otherwise `runtime/previous` names the version
 *     in use, `runtime/current` the new one, and the switch is recorded (PM2a's update log).
 *
 * The self-check, run on the new copy with a throwaway home: its CLI answers `--version` with the version offered;
 * every script the starter runs is there; and the connector, given an agent it does not know, loads and exits 0 (it
 * writes nothing). A version is newer by its major, minor and patch numbers; a pre-release is older than its release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { shippedFiles, fingerprintFolder, STARTER_SCRIPTS } = require('./install');
const { untar } = require('./untar');
const { recordUpdate } = require('../opon/ledger/updates');

const NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/;
const SRI = /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/;

/** -1, 0 or 1: a against b, by major, minor and patch, then a pre-release below its release (its own text compared). */
function compareVersions(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  return x[4] < y[4] ? -1 : 1;
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};
const place = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const matches = (buf, integrity) => {
  const [alg, digest] = [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)];
  return crypto.createHash(alg).update(buf).digest('base64') === digest;
};

/** The new copy's self-check: null when it passes, else what failed. */
function selfCheck(dir, version) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-self-check-'));
  try {
    const run = (args, input = '') => spawnSync(process.execPath, args, { cwd: dir, input, encoding: 'utf8', timeout: 30000, env: { ...process.env, ORUNMILA_HOME: scratch } });
    const v = run([path.join(dir, 'bin', 'orunmila.js'), '--version']);
    if (v.status !== 0 || String(v.stdout).trim() !== version) return `its CLI answered --version with ${JSON.stringify(String(v.stdout).trim())} (exit ${v.status}), not ${version}`;
    const missing = STARTER_SCRIPTS.filter((rel) => !fs.existsSync(path.join(dir, ...rel.split('/'))));
    if (missing.length) return `it has no ${missing.join(', ')}`;
    const c = run([path.join(dir, 'src', 'capture', 'connector.js'), 'orunmila-self-check', 'postTool'], '{}');
    if (c.status !== 0) return `its connector did not load (exit ${c.status}): ${String(c.stderr).trim().slice(0, 300)}`;
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The package's files unpacked into a folder of their own under `runtime`, placed whole; returns its name. */
function unpack(runtime, tgz) {
  const files = untar(tgz);
  const incoming = path.join(runtime, `.incoming-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    for (const f of files) {
      const to = path.join(incoming, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.writeFileSync(to, f.data, { mode: 0o600 });
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(incoming, 'package.json'), 'utf8'));
    const folder = `${pkg.version}_${fingerprintFolder(incoming, shippedFiles(incoming))}`;
    if (!NAME.test(folder)) throw new Error(`the package names its version ${JSON.stringify(pkg.version)}`);
    if (fs.existsSync(path.join(runtime, folder))) return folder; // the same bytes are already here
    fs.renameSync(incoming, path.join(runtime, folder));
    return folder;
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

async function updateNow({ home, registry, held, name = 'orunmila' }) {
  const reg = require('./registry'); // the one file that reaches the network, loaded only here (LD268)
  const runtime = path.join(home, 'runtime');
  const inUse = readText(path.join(runtime, 'current'));
  if (!inUse || !NAME.test(inUse) || !fs.existsSync(path.join(runtime, inUse))) return { status: 'refused', words: `no copy of Orunmila is installed in ${runtime}: run orunmila install first` };
  const from = inUse.slice(0, inUse.indexOf('_') === -1 ? inUse.length : inUse.indexOf('_'));
  const base = String(registry).replace(/\/+$/, '');
  let pk;
  try {
    pk = await reg.getJson(`${base}/${encodeURIComponent(name)}`);
  } catch (e) {
    return { status: 'refused', words: `the registry ${base} could not be asked: ${e.message}` };
  }
  const latest = pk && pk['dist-tags'] && pk['dist-tags'].latest;
  const meta = latest && pk.versions && pk.versions[latest];
  const integrity = meta && meta.dist && meta.dist.integrity;
  if (typeof latest !== 'string' || !SEMVER.test(latest) || typeof integrity !== 'string' || !SRI.test(integrity) || !meta.dist.tarball) return { status: 'refused', words: `the registry ${base} gave no version with an integrity hash for ${name}` };
  if (!SEMVER.test(from) || compareVersions(latest, from) <= 0) return { status: 'up_to_date', words: `up to date: ${from} in use, the registry's latest is ${latest}` };

  let folder = null;
  const pendingFile = path.join(runtime, 'pending');
  const pending = readText(pendingFile);
  if (pending) {
    const [f, i] = pending.split(' ');
    if (i === integrity && NAME.test(f) && f.startsWith(`${latest}_`) && fs.existsSync(path.join(runtime, f))) folder = f; // already downloaded and checked
  }
  if (!folder) {
    let tgz;
    try {
      tgz = await reg.getBuffer(meta.dist.tarball);
    } catch (e) {
      return { status: 'refused', words: `${latest} could not be downloaded: ${e.message}` };
    }
    if (!matches(tgz, integrity)) return { status: 'refused', words: `the package downloaded for ${latest} does not match the integrity hash the registry gives (${integrity}); nothing was kept` };
    try {
      folder = unpack(runtime, tgz);
    } catch (e) {
      recordUpdate(home, { from, to: latest, integrity, self_check: 'fail', switched: false });
      return { status: 'failed', words: `${latest} could not be unpacked (${e.message}); recorded, and ${from} stays in use` };
    }
  }
  const failed = folder.startsWith(`${latest}_`) ? selfCheck(path.join(runtime, folder), latest) : `the package says it is ${folder.split('_')[0]}, not ${latest}`;
  if (failed) {
    if (folder !== inUse) fs.rmSync(path.join(runtime, folder), { recursive: true, force: true });
    fs.rmSync(pendingFile, { force: true });
    recordUpdate(home, { from, to: latest, integrity, self_check: 'fail', switched: false });
    return { status: 'failed', words: `${latest} failed its self-check (${failed}); it was removed, the refusal recorded, and ${from} stays in use` };
  }
  if (await held()) {
    place(pendingFile, `${folder} ${integrity}\n`);
    return { status: 'waiting', words: `${latest} is downloaded and checked, and waits until no session is held (${from} stays in use until then)` };
  }
  place(path.join(runtime, 'previous'), inUse + '\n');
  place(path.join(runtime, 'current'), folder + '\n');
  fs.rmSync(pendingFile, { force: true });
  recordUpdate(home, { from, to: latest, integrity, self_check: 'pass', switched: true });
  return { status: 'switched', words: `switched from ${from} to ${latest} (${path.join(runtime, folder)}); ${from} is kept as the previous version` };
}

module.exports = { updateNow, compareVersions, selfCheck };
