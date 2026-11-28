// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/group/keys.js — which group a mark joins (station 3, brief v4 lines
 * 372-379; Phase 2 slice R1, first form; grouping proper is slices G1-G2).
 *
 *   keyOf(mark) -> the group key
 *
 * A file is keyed by its normalised path (intake normalised it, line 345), so
 * a read of a file joins that file's group, both witnesses' marks join one
 * group, and the tool call that changed it too. A folder's own change on disk
 * is keyed by its path (rule 6 folds it); a read of a folder (a search, a
 * listing) by its path and tool call id, as a tool call. A command, a
 * tool call or a network contact is keyed by its kind and its tool call id
 * (`cause_hint`), because two runs of one command are two events; with no id
 * the mark stands alone. Turn marks (a prompt, the closing claim, the turn's
 * end) group by the turn. The session's end groups by the session. Anything
 * else (a gap, a tampering mark, the intake's own note) is its own group.
 * Ticks never reach here: they are the clock, not an event.
 *
 *   aliasPath(path) -> the file an editor's temp file stands for (rule 4,
 *                      line 366): `x.tmp` and `x~` are `x`, `.#x` is `x`, and
 *                      vim's swap file `.x.swp` (or `x.swp`) is `x`; any other
 *                      path is itself. Vim's `4913` names no file: the engine
 *                      joins it to its folder's latest open file group.
 */

const path = require('path');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DISK = new Set(['created', 'modified', 'deleted', 'renamed']);

function aliasPath(p) {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const at = (b) => (dir === '.' ? b : `${dir}/${b}`);
  if (base.length > 4 && base.endsWith('.tmp')) return at(base.slice(0, -4));
  if (base.length > 1 && base.endsWith('~')) return at(base.slice(0, -1));
  if (base.length > 2 && base.startsWith('.#')) return at(base.slice(2));
  if (base.length > 4 && base.endsWith('.swp')) return at(base.startsWith('.') && base.length > 5 ? base.slice(1, -4) : base.slice(0, -4));
  return p;
}

function keyOf(m) {
  const t = isObject(m.target) ? m.target : null;
  const alone = `seq:${m.seq}`;
  if (!t) return alone;
  // A folder's own change on disk is keyed apart from reads of the folder (a listing, a search): rule 6 folds it.
  if (t.kind === 'dir' && typeof t.path === 'string' && DISK.has(m.says)) return `dirchange:${t.path}`;
  if (t.kind === 'file' && typeof t.path === 'string') return `file:${t.path}`;
  // A read of a folder (a search, a listing) is a tool call: two searches are two events (G1).
  if (t.kind === 'dir' && typeof t.path === 'string') return m.cause_hint ? `dir:${t.path}|${m.cause_hint}` : alone;
  if (t.kind === 'command' || t.kind === 'tool' || t.kind === 'network') return m.cause_hint ? `${t.kind}:${m.cause_hint}` : alone;
  if (t.kind === 'turn' || t.kind === 'claim') return m.turn ? `turn:${m.turn}` : t.id ? `turn:${t.id}` : alone;
  if (t.kind === 'session' && t.id) return `session:${t.id}`;
  return alone;
}

module.exports = { keyOf, aliasPath };
