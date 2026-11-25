// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/trail/from-marks.js — `trail --json` from the intake's session logs, the
 * compatibility layer's first command (slice B7, LD149; brief v4 lines
 * 747-749; tests 47, 64; NF25).
 *
 *   trailFromSessionFolder(dir) -> the trail model (src/trail/index.js), for
 *     render/trail-json.js, from <dir>/raw.jsonl and the files kept beside it
 *
 * The session's marks are turned back into today's event shape and run
 * through today's trail code, so rows, turns, artifacts and totals keep
 * today's fields, filled from the marks: `ts` and `source` from `observed_at`
 * and `source` (`fs-sentinel` for the Sentinel, as today), a fingerprint as
 * today's hex, `output_path` the full output kept beside the log, the diff
 * from its kept file (a kept file that is missing is lost evidence, never an
 * empty diff: the row says `diff_missing`, open question 4). `started` marks,
 * the intake's own process marks and law-gate checks have no event today and
 * are not rows.
 *
 * Two things today's path cannot do, and this one does:
 *   - NF25: a turn's Sentinel writes run to the next turn's first event (the
 *     last turn's to the end of the log), so a write after the turn's last
 *     hook event is not dropped.
 *   - Every row names both witnesses (`witnesses`, line 749; G2b's statuses):
 *     a Glove write and a Sentinel write of the same path in one turn are both
 *     `saw`; a write the other did not see is `saw_nothing` on that side; a
 *     Glove write outside the project is the Sentinel's `out_of_scope`
 *     (`outside_root`), and a read, command, tool call or network contact is
 *     the Sentinel's `out_of_scope` (`not_a_disk_event`). Never a guess why.
 */

const fs = require('fs');
const path = require('path');
const { buildTrail } = require('./index');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex = (fp) => (typeof fp === 'string' && /^sha256:[0-9a-f]{64}$/.test(fp) ? fp.slice(7) : null);
const DISK = new Set(['created', 'modified', 'deleted', 'renamed']);
const CHANGE_KIND = { created: 'create', modified: 'modify', deleted: 'delete', renamed: 'modify' };

function readMarks(dir) {
  const out = [];
  for (const line of fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a cut last line: `verify` reports it */
    }
  }
  return out;
}

function keptText(dir, ref, e) {
  const h = hex(ref);
  if (!h) return;
  try {
    e.diff = fs.readFileSync(path.join(dir, 'files', h), 'utf8');
  } catch {
    e.diff_missing = true;
  }
}

/** One mark as today's event, or null when today has no event for it. */
function toEvent(m, dir) {
  const d = isObject(m.detail) ? m.detail : {};
  const t = isObject(m.target) ? m.target : {};
  const e = { ts: m.observed_at, session_id: m.session_id, turn_id: m.turn || null, agent: m.agent, call_id: m.cause_hint || undefined };
  if (m.sub_agent) Object.assign(e, { sub_agent_id: m.sub_agent.id, sub_agent_type: m.sub_agent.type });
  if (m.source === 'sentinel' && DISK.has(m.says) && t.kind === 'file') {
    const ev = { ts: m.observed_at, session_id: null, turn_id: null, agent: 'fs-sentinel', source: 'fs-sentinel', type: 'file_write', path: t.path, rel_path: t.path, change_kind: CHANGE_KIND[m.says], hash_before: hex(d.fingerprint_before), hash_after: hex(d.fingerprint), binary: d.no_diff === 'binary', failed: false, outside: t.outside === true };
    keptText(dir, d.diff_ref, ev);
    return ev;
  }
  if (m.source === 'agent_claim' && m.says === 'claimed') return { ...e, type: 'turn_claim', text: d.text || '' };
  if (m.source !== 'hook') return null;
  const failed = d.exit_status === 'fail';
  if (m.says === 'prompted') return { ...e, type: 'user_prompt', text: d.prompt || '' };
  if (m.says === 'ended' && t.kind === 'turn') return { ...e, type: 'turn_end' };
  if (m.says === 'exited' && t.kind === 'command') {
    const ev = { ...e, type: 'command_run', command: t.text, exit_code: Number.isInteger(d.exit_code) ? d.exit_code : null, failed, stdout_excerpt: d.output_excerpt || '' };
    if (hex(d.output_ref)) ev.output_path = path.join(dir, 'files', hex(d.output_ref));
    return ev;
  }
  if (DISK.has(m.says) && t.kind === 'file') {
    const ev = { ...e, type: 'file_write', path: t.path, failed: false, outside: t.outside === true };
    if (hex(d.fingerprint)) ev.hash = hex(d.fingerprint);
    keptText(dir, d.diff_ref, ev);
    return ev;
  }
  if (m.says === 'read') {
    if (d.read_kind === 'pattern') return { ...e, type: 'file_read', path: d.pattern || '', read_kind: 'pattern', failed: false };
    const ev = { ...e, type: 'file_read', path: t.path, read_kind: d.read_kind === null || d.read_kind === undefined ? 'full' : d.read_kind, failed: false };
    if (hex(d.fingerprint)) ev.hash = hex(d.fingerprint);
    if (Number.isInteger(d.size)) ev.bytes = d.size;
    return ev;
  }
  if (m.says === 'ended' && (t.kind === 'file' || t.kind === 'dir')) {
    return { ...e, type: /^(Read|Grep|Glob|LS)$/.test(String(d.tool || '')) ? 'file_read' : 'file_write', path: t.path, failed: true };
  }
  if (m.says === 'called' || (m.says === 'ended' && t.kind === 'tool')) return { ...e, type: 'tool_call', tool_name: d.tool || t.name, input: d.tool_input, failed };
  if (m.says === 'contacted' || (m.says === 'ended' && t.kind === 'network')) return { ...e, type: 'network_call', tool_name: d.tool || null, host: t.host || null, target: t.url || t.query || '', failed };
  return null;
}

function witnessesFor(rows) {
  const glovePaths = new Set(rows.filter((r) => r.type === 'file_write' && r.source !== 'fs-sentinel').map((r) => r.path));
  const diskPaths = new Set(rows.filter((r) => r.source === 'fs-sentinel').map((r) => r.path));
  for (const r of rows) {
    if (r.source === 'fs-sentinel') r.witnesses = { glove: { status: glovePaths.has(r.path) ? 'saw' : 'saw_nothing' }, sentinel: { status: 'saw' } };
    else if (r.type === 'file_write') {
      r.witnesses = { glove: { status: 'saw' }, sentinel: r.outside ? { status: 'out_of_scope', scope: 'outside_root' } : { status: diskPaths.has(r.path) ? 'saw' : 'saw_nothing' } };
    } else r.witnesses = { glove: { status: 'saw' }, sentinel: { status: 'out_of_scope', scope: 'not_a_disk_event' } };
    delete r.outside;
  }
}

function trailFromSessionFolder(dir) {
  const recs = readMarks(dir);
  const header = recs[0];
  const events = recs.slice(1).map((m) => toEvent(m, dir)).filter(Boolean);
  const sentinel = events.filter((e) => e.source === 'fs-sentinel');
  const hook = events.filter((e) => e.source !== 'fs-sentinel');
  // Each turn's window: its first event to the next turn's first event (NF25).
  const firsts = new Map();
  for (const e of hook) if (e.turn_id && !firsts.has(e.turn_id)) firsts.set(e.turn_id, e.ts);
  const sentinelFor = (turnId, hookEvents, i, ids) => {
    const from = firsts.get(turnId);
    const to = i + 1 < ids.length ? firsts.get(ids[i + 1]) : null;
    return sentinel.filter((e) => e.ts >= from && (to === null || e.ts < to));
  };
  // The outside flag rides on each row so the witnesses can be named, then is removed.
  const trail = buildTrail(header.session_id, hook, sentinelFor);
  const byTs = new Map(events.map((e) => [`${e.ts}|${e.path || e.command || ''}`, e]));
  for (const turn of trail.turns) {
    for (const r of turn.trail) {
      const e = byTs.get(`${r.ts}|${r.path || r.command || ''}`);
      if (e && e.outside) r.outside = true;
      if (e && e.diff_missing) r.diff_missing = true;
    }
    witnessesFor(turn.trail);
  }
  return trail;
}

module.exports = { trailFromSessionFolder, toEvent };
