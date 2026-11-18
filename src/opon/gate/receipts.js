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

module.exports = { receiptsOf, receiptFor };
