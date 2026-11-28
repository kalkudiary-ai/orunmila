// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/package-lock.js — CF3 (LD385): what an install command changed in npm's lock file, from the file as it
 * was before the command and after it. The lock file's own words: what npm wrote down, not proof of what is on disk
 * under node_modules/ (which the Sentinel does not watch). Plain code, no model; the same answer on every OS.
 *
 *   installManager(text) -> 'npm' | 'yarn' | 'pnpm' | 'bun' | null
 *     a step of the command line runs a package manager's install, add, update, remove or clean-install
 *     (`npm audit fix` too; a bare `yarn` installs).
 *   readLock(root) -> { file, entries: Map(name -> { version, install_script }) | null, unreadable? } | null
 *     npm-shrinkwrap.json, else package-lock.json, at the project's root (npm's own order), as one regular file of at
 *     most 64 MiB; null when neither is there. lockfileVersion 2 and 3 (`packages`, with hasInstallScript) and 1
 *     (nested `dependencies`, install scripts unknown: null). A package's name is its folder under node_modules/, a
 *     nested one with its parent's (`b/node_modules/c`); workspace folders are left out.
 *   lockChange(manager, before, after, root) -> the mark's detail.packages
 *     { manager, lock, added, changed, removed, not_read, cut?, before_unknown?, unreadable? }: each list sorted by
 *     name, at most MAX_LISTED entries in all (`cut` counts the rest); only npm's lock is read, so for another
 *     manager `lock` is null; `not_read` names every other lock file at the root. `before` undefined: the state before
 *     the command is not known (`before_unknown`); null: there was no lock file, so every entry is added.
 */

const fs = require('fs');
const path = require('path');
const { steps, commandWord } = require('./command-facts');
const { readRegular } = require('../opon/intake/regular-file');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LISTED = 200;
const NPM_LOCKS = ['npm-shrinkwrap.json', 'package-lock.json'];
const OTHER_LOCKS = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const VERBS = {
  npm: new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'update', 'up', 'upgrade', 'udpate', 'uninstall', 'un', 'unlink', 'remove', 'rm', 'r', 'dedupe', 'ddp', 'prune']),
  yarn: new Set(['install', 'add', 'remove', 'upgrade', 'up']),
  pnpm: new Set(['install', 'i', 'add', 'remove', 'rm', 'un', 'uninstall', 'update', 'up', 'upgrade']),
  bun: new Set(['install', 'i', 'add', 'a', 'remove', 'rm', 'update']),
};

function installManager(text) {
  for (const words of steps(text)) {
    const { word, rest } = commandWord(words);
    if (!VERBS[word]) continue;
    const verb = rest.find((w) => !w.startsWith('-'));
    if (word === 'yarn' && verb === undefined) return 'yarn';
    if (VERBS[word].has(verb)) return word;
    if (word === 'npm' && verb === 'audit' && rest.includes('fix')) return 'npm';
  }
  return null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function entriesOf(lock) {
  const out = new Map();
  if (isObject(lock.packages)) {
    for (const [key, v] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || !isObject(v) || typeof v.version !== 'string') continue;
      out.set(key.slice('node_modules/'.length), { version: v.version, install_script: v.hasInstallScript === true });
    }
    return out;
  }
  const walk = (deps, prefix) => {
    for (const [name, v] of Object.entries(isObject(deps) ? deps : {})) {
      if (!isObject(v)) continue;
      const at = prefix + name;
      if (typeof v.version === 'string') out.set(at, { version: v.version, install_script: null });
      walk(v.dependencies, `${at}/node_modules/`);
    }
  };
  walk(lock.dependencies, '');
  return out;
}

function readLock(root) {
  for (const file of NPM_LOCKS) {
    const buf = readRegular(path.join(root, file), MAX_BYTES);
    if (buf === null) continue;
    try {
      const lock = JSON.parse(buf.toString('utf8'));
      if (!isObject(lock)) throw new Error('not an object');
      return { file, entries: entriesOf(lock) };
    } catch {
      return { file, entries: null, unreadable: true };
    }
  }
  return null;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function lockChange(manager, before, after, root) {
  const npm = manager === 'npm';
  const read = npm && after ? after.file : null;
  const d = { manager, lock: read, added: [], changed: [], removed: [], not_read: [] };
  for (const f of [...NPM_LOCKS, ...OTHER_LOCKS]) {
    if (f !== read && isFile(path.join(root, f))) d.not_read.push(f);
  }
  if (!read) return d;
  if (!after.entries || (before && before.file === read && !before.entries)) return { ...d, unreadable: true };
  if (before === undefined || (before && before.file !== read)) return { ...d, before_unknown: true };
  if (before === null) before = { file: read, entries: new Map() }; // no lock file before the command: all of it is new
  for (const [name, a] of after.entries) {
    const b = before.entries.get(name);
    if (!b) d.added.push({ name, version: a.version, install_script: a.install_script });
    else if (b.version !== a.version) d.changed.push({ name, from: b.version, to: a.version, install_script: a.install_script });
  }
  for (const [name, b] of before.entries) if (!after.entries.has(name)) d.removed.push({ name, version: b.version });
  let room = MAX_LISTED;
  let cut = 0;
  for (const k of ['added', 'changed', 'removed']) {
    d[k].sort(byName);
    if (d[k].length > room) {
      cut += d[k].length - room;
      d[k] = d[k].slice(0, room);
    }
    room -= d[k].length;
  }
  if (cut) d.cut = cut;
  return d;
}

module.exports = { installManager, readLock, lockChange, MAX_LISTED };
