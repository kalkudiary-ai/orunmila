// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/paths.js — path normalisation at intake (brief v3 line 339;
 * Phase 1 slice A7; NF3).
 *
 *   normalisePath(p, { root, caseInsensitive })  { path, outside }
 *     Inside the root: repo-relative, `/` separators, symlinks resolved, and
 *     lower-cased when the file system is case-insensitive, so two spellings of
 *     one file become one target ("." is the root itself). Symlinks are
 *     resolved on the deepest folder that still exists, so a deleted file
 *     normalises too; `..` is applied before that, as path.resolve does.
 *     Outside the root: the absolute real path, `outside: true` (open point P2
 *     in spec/README.md).
 *   isCaseInsensitive(dir)    whether dir's file system ignores case, by probe
 *   sessionFolderName(id)     the id, if it is safe as one folder name; throws
 *                             otherwise (NF3: a session id is used in paths)
 */

const fs = require('fs');
const path = require('path');

/** The real path of p, resolving symlinks on its deepest existing ancestor. */
function realExisting(p) {
  let cur = p;
  const tail = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    tail.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

function normalisePath(p, { root, caseInsensitive }) {
  const realRoot = realExisting(path.resolve(root));
  const real = realExisting(path.resolve(root, String(p)));
  const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
  const rel = path.relative(fold(realRoot), fold(real));
  const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  const out = outside ? real : rel || '.';
  return { path: out.split(path.sep).join('/'), outside };
}

function isCaseInsensitive(dir) {
  const real = fs.realpathSync(dir);
  const name = path.basename(real);
  const swapped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  if (swapped === name) return process.platform === 'darwin' || process.platform === 'win32'; // no letters to probe with
  try {
    return fs.statSync(path.join(path.dirname(real), swapped)).ino === fs.statSync(real).ino;
  } catch {
    return false;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionFolderName(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`unsafe session id for a folder name: ${JSON.stringify(id)}`);
  return id;
}

module.exports = { normalisePath, isCaseInsensitive, sessionFolderName };
