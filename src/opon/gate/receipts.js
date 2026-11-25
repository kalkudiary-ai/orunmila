// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/gate/receipts.js — how much a turn's Glove marks show the agent saw
 * of a file, as the law gate grades it (open question 3, decided by O
 * 2026-11-16: brief v4 line 276; review/phase1-design.md section 3; NF26,
 * NF69; Phase 1 slice B9a, pure part; LD67). Not wired: today's gate grades
 * events in src/laws/evaluate.js, which hooks load, so it is not changed
 * before the 0.2.3 cut.
 *
 *   receiptsOf(marks)       a turn's marks -> { files, dirs }: the strongest
 *                           grade each path earned
 *   receiptFor(r, path)     'full', 'weak' or 'none' for one file
 *
 * Grading, from Glove marks (source `hook`) that passed (`exit_status`
 * `pass`); anything else, a failed tool call's `ended` mark included, is no
 * receipt (NF26, NF69), and `read_kind` is read only after that check:
 *   - a `read` of a file, `read_kind` `full`, `range` or `null`: full
 *     (`range` and `null` are full by O's decision; the mark keeps what the
 *     tool showed);
 *   - a `read` with `read_kind` `pattern` (a search): weak, for that file, or
 *     for every file under the folder searched;
 *   - any other `read` of a folder (a listing): weak for the files under it;
 *   - a write outcome (`created`, `modified`, `deleted`, `renamed`): full.
 * The strongest grade a path earns wins, whatever the order; a later failure
 * never takes back a receipt already earned. Paths are compared as the marks
 * give them (normalised at intake, slice A7); `.` is the project root.
 *
 * Limits: a shell command's reads (`cat`, `ls`, a shell search) are graded by
 * today's command parser until the wiring (LD67); a sub-agent's marks count
 * like the agent's own, so the caller chooses which marks to pass.
 */

const RANK = { none: 0, weak: 1, full: 2 };
const WRITES = ['created', 'modified', 'deleted', 'renamed'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function raise(map, key, grade) {
  if (RANK[grade] > RANK[map.get(key) || 'none']) map.set(key, grade);
}

function receiptsOf(marks) {
  const files = new Map();
  const dirs = new Map();
  for (const m of marks) {
    if (!isObject(m) || m.source !== 'hook' || !isObject(m.target) || typeof m.target.path !== 'string') continue;
    const d = isObject(m.detail) ? m.detail : {};
    if (d.exit_status !== 'pass') continue; // a failed or unknown call is no receipt, before read_kind is looked at
    const { kind, path } = m.target;
    if (m.says === 'read') {
      const searched = d.read_kind === 'pattern';
      if (kind === 'file') raise(files, path, searched ? 'weak' : 'full');
      else if (kind === 'dir') raise(dirs, path, 'weak');
    } else if (WRITES.includes(m.says) && kind === 'file') {
      raise(files, path, 'full');
    }
  }
  return { files, dirs };
}

const under = (p, dir) => dir === '.' || p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

function receiptFor({ files, dirs }, p) {
  let best = files.get(p) || 'none';
  for (const [dir, grade] of dirs) if (under(p, dir) && RANK[grade] > RANK[best]) best = grade;
  return best;
}

/**
 * The receipts the law gate's rules join against (src/laws/evaluate.js
 * buildReceipts' shape), from a turn's marks (slice B9, LD148), graded as
 * above: only the Glove's marks (`hook`) count, and only those that passed.
 * Commands from `exited` marks: `pass` without an unguarded pipe is a passing
 * command, `fail` a failed one with its code when stated, and a pipe or an
 * `unknown` status (background, interrupted) proves nothing; their command
 * lines and output are content receipts as today. A tool call or a network
 * contact that passed is a full receipt of its name and input. `pathGrade`
 * gives the folder-level grades (a listing or a search: weak).
 */
function buildReceiptsFromMarks(marks) {
  const { classifyShellLine, hasUnguardedPipe } = require('../../laws/evaluate');
  const full = [];
  const weak = [];
  const passingCommands = [];
  const failedCommands = [];
  const unreliableCommands = [];
  const glove = marks.filter((m) => isObject(m) && m.source === 'hook' && isObject(m.target));
  for (const m of glove) {
    const d = isObject(m.detail) ? m.detail : {};
    const t = m.target;
    if (m.says === 'exited' && t.kind === 'command') {
      const command = String(t.text || '');
      const out = String(d.output_excerpt || '');
      const laundered = hasUnguardedPipe(command);
      if (d.exit_status === 'pass' && !laundered) passingCommands.push({ command, out });
      else if (d.exit_status === 'fail') failedCommands.push({ command, exit_code: Number.isInteger(d.exit_code) ? d.exit_code : null });
      else unreliableCommands.push({ command });
      const segments = classifyShellLine(command);
      for (const seg of segments.full) full.push({ text: seg, kind: 'command' });
      for (const seg of segments.weak) weak.push({ text: seg, kind: 'shell_pattern' });
      if (out) (segments.weak.length ? weak : full).push({ text: out, kind: segments.weak.length ? 'shell_pattern' : 'command' });
      continue;
    }
    if (!(d.exit_status === 'pass')) continue; // NF26, NF69: a call that did not pass is no receipt
    if (m.says === 'read' && t.kind === 'file') full.push({ text: String(t.path), kind: 'read' });
    else if (m.says === 'read' && t.kind === 'dir' && d.read_kind === 'pattern') weak.push({ text: `${t.path} ${d.pattern || ''}`, kind: 'pattern_read' });
    else if (WRITES.includes(m.says) && t.kind === 'file') full.push({ text: String(t.path), kind: 'write' });
    else if (m.says === 'called') full.push({ text: `${d.tool || t.name || 'tool'} ${JSON.stringify(d.tool_input === undefined ? {} : d.tool_input)}${d.tool_result_excerpt ? '\n' + d.tool_result_excerpt : ''}`, kind: 'tool_call' });
    else if (m.says === 'contacted') full.push({ text: `${d.tool || 'network'} ${t.host || ''} ${t.url || t.query || ''}`, kind: 'network_call' });
  }
  const graded = receiptsOf(glove);
  // A path target's value is its basename (assert-extractor); the path as written is `raw`.
  const pathGrade = (target) => receiptFor(graded, String(target.raw || target.value || '').replace(/^\.\//, ''));
  return { full, weak, passingCommands, failedCommands, unreliableCommands, pathGrade };
}

module.exports = { receiptsOf, receiptFor, buildReceiptsFromMarks };
