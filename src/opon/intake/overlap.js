// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/overlap.js — which sessions were active in a folder at a
 * time, told from the session logs alone (brief v4 line 344: one intake per
 * machine "so it can tell when sessions overlap in the same folder"; line 602;
 * decision LD63 under O's D15: the set goes on the odù's concurrent_sessions
 * conflict, never on a mark). Station 5 (lines 404-405) calls it. Pure: it
 * reads records it is given and never the clock, so replay gets the same set.
 *
 *   spanOf(records)  one session's raw log records, header first ->
 *                    { id, root, from, to, ended }: from the header's mono_ns,
 *                    in its project_root, to the session's end mark (LD55),
 *                    else its last record. The intake ticks every session it
 *                    holds while idle (line 353), so the last record is when
 *                    it last held it. A mark after the end mark is a late
 *                    delivery and does not extend the span. Records with no
 *                    mono_ns (a continuation, LD57) are skipped.
 *   concurrent(spans, root, mono)
 *                    the ids, sorted, of the sessions whose root shares files
 *                    with `root` (the same folder, or one inside the other, by
 *                    whole folder names: NF80, LD69) and whose span holds
 *                    `mono` (both ends included). mono_ns is compared as an
 *                    integer.
 *   applyOverlapped(spans, mark)
 *                    an `overlapped` mark (L2, LD202) applied to a session's
 *                    own list: the session it names begins, or ends
 *   sharesFiles(a, b) whether two roots share files
 *
 * Limits: a session whose agent died with no end mark counts as active while
 * the intake holds it (NF79; more overlap means fewer credits, never a false
 * one); mono_ns across a reboot is not comparable (clock_reset); roots are
 * compared as written, so two spellings of one folder that differ in case are
 * two folders.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A root with `/` separators and no trailing one (`/` becomes '', which holds every absolute path). */
const folderOf = (root) => String(root).replace(/\\/g, '/').replace(/\/+$/, '');
const within = (child, parent) => child === parent || child.startsWith(parent + '/');
const sharesFiles = (a, b) => {
  const x = folderOf(a);
  const y = folderOf(b);
  return within(x, y) || within(y, x);
};
const endsSession = (rec) => rec.says === 'ended' && isObject(rec.target) && rec.target.kind === 'session';

function spanOf(records) {
  const header = records[0];
  if (!isObject(header) || header.record !== 'session_header') throw new Error('a session span needs the raw log records, starting with the session header');
  let to = header.mono_ns;
  let ended = false;
  for (const rec of records.slice(1)) {
    if (rec.mono_ns === undefined) continue; // a continuation record has no times
    to = rec.mono_ns;
    if (endsSession(rec)) {
      ended = true;
      break; // a later mark is a late delivery
    }
  }
  return { id: header.session_id, root: header.project_root, from: header.mono_ns, to, ended };
}

const OPEN = String(2n ** 63n); // a session named as begun and not yet as ended runs on

/**
 * L2 (Q11 (2) (a), LD202): an `overlapped` mark's news in a session's own list of the others:
 * the session it names, from its start, open until a later mark names its end. Live and replay
 * apply each such mark of the session's log, in seq order, to a list of their own.
 */
function applyOverlapped(spans, mark) {
  const d = isObject(mark.detail) ? mark.detail : {};
  const span = { id: d.session, root: d.root, from: d.from, to: d.ended === true ? d.to : OPEN, ended: d.ended === true };
  const i = spans.findIndex((s) => s.id === span.id);
  if (i >= 0) spans[i] = span;
  else spans.push(span);
}

function concurrent(spans, root, mono) {
  const t = BigInt(mono);
  return spans
    .filter((s) => sharesFiles(s.root, root) && BigInt(s.from) <= t && t <= BigInt(s.to))
    .map((s) => s.id)
    .sort();
}

module.exports = { spanOf, concurrent, applyOverlapped, sharesFiles };
