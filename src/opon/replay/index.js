'use strict';

/**
 * src/opon/replay/index.js — the replay harness (Phase 2 slice R1, LD142,
 * LD152; brief v4 lines 607-608; guarantee 3; tests 13, 34, 35; open question
 * 4). It feeds a recorded raw log into a fresh Ọpọ́n and gives back its output,
 * so every settling rule is built and tested through it.
 *
 *   replayFolder(dir) -> { ok, words, lines, text, odu, verdict, verdict_words }
 *     odu: the odù log the sealed groups make (src/opon/ledger/odu-log.js,
 *     Phase 3 slice O1); verdict: that odù log judged from scratch (Phase 6
 *     slice BB6, the judge's one interface), or null with verdict_words
 *
 * The raw log must verify (chain and records): replay never judges an altered
 * record, and refuses with the verifier's words. Settings come from the
 * session header, never from today's defaults (test 35); nothing is read from
 * the files the marks name, so a file changed on disk after the session
 * changes nothing (test 34). The baseline snapshot the header names (slice N2,
 * LD171) is read from the session folder, as a kept file: if it is missing or
 * changed it is lost evidence, and every target's first `before` is unknown.
 * The byproducts list is the header's (`config.byproducts`, A1a); a header
 * without one gives step 4 nothing to match (A1b).
 * The other sessions (A2, LD179): every folder beside this one that holds a
 * `raw.jsonl`, its span from its own verified raw log (overlap.js `spanOf`).
 * One whose log does not verify is named as lost evidence
 * (`other_session_unverified`) and counted as active at every time in every
 * folder, so it can only take credits away. A folder removed since the session
 * cannot be seen (LD181 (2), Q11). A log that holds `overlapped` marks (L2,
 * LD202: the intake named in it each session sharing its folder) is read from
 * them alone, in seq order, as the live engine read them, so a folder removed
 * later changes nothing.
 * A file kept beside the log that is missing or
 * changed is named as lost evidence in the first line (open question 4), and
 * replay goes on: stations 2-3 read no diff, and nothing is ever read as an
 * empty one.
 *
 * Output, canonical JSON (RFC 8785) one record per line, so two replays of one
 * log are byte-identical (test 13): first
 *   { record: 'replay', schema_version: 1, session_id, header_hash, config, lost_evidence }
 * then the sealed groups in the order they sealed, then the rest as they
 * stand at the log's end, in the order they opened.
 */

const { verifySession, checkLog } = require('../../verify/session');
const { canonicalize } = require('../../verify/canonical');
const { configFromHeader } = require('../intake/header');
const { createOpon } = require('../settle/engine');
const { oduLog } = require('../ledger/odu-log');
const { spanOf, applyOverlapped } = require('../intake/overlap');
const { baselineMap } = require('../net/baseline');
const fs = require('fs');
const path = require('path');

const ALWAYS = { root: '/', from: '0', to: String(2n ** 63n), ended: false }; // active at every time, in every folder

/** The other sessions beside `dir` (A2, LD179): { spans, lost }, in folder-name order. */
function othersBeside(dir, sessionId) {
  const spans = [];
  const lost = [];
  const parent = path.dirname(dir);
  for (const name of fs.readdirSync(parent).sort()) {
    const other = path.join(parent, name);
    if (other === dir || !fs.existsSync(path.join(other, 'raw.jsonl'))) continue;
    const log = checkLog(other, 'raw');
    const recs = log.ok ? log.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec) : [];
    const span = recs.length && recs[0] && recs[0].record === 'session_header' ? spanOf(recs) : null;
    if (span && span.id === sessionId) continue;
    if (span) spans.push(span);
    else {
      lost.push({ seq: null, ref: name, problem: 'other_session_unverified' });
      spans.push({ id: name, ...ALWAYS });
    }
  }
  return { spans, lost };
}

/** The baseline the header names, as path -> fingerprint (null for a link or other), or null when there is none to trust. */
function baselineOf(dir, header, v) {
  if (!header.baseline || v.files.bad.some((b) => b.baseline)) return null;
  return baselineMap(fs.readFileSync(path.join(dir, 'baseline.jsonl'), 'utf8'));
}

function replayFolder(dir) {
  const raw = checkLog(dir, 'raw');
  const v = verifySession(dir);
  if (!raw.ok || !v.schema.ok) return { ok: false, words: `replay refused: ${v.words}`, lines: [], text: '' };
  const recs = raw.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec);
  const header = recs[0];
  const config = configFromHeader(header);
  // L2 (LD202): a log whose intake named the sessions sharing its folder is read from those marks alone; any other, from the folders beside it (LD179).
  const marked = recs.slice(1).some((m) => m.says === 'overlapped');
  const others = marked ? { spans: [], lost: [] } : othersBeside(dir, header.session_id);
  const opon = createOpon({ sessionId: header.session_id, config, byproducts: Array.isArray(config.byproducts) ? config.byproducts : null, baseline: baselineOf(dir, header, v), root: header.project_root, others: others.spans });
  const groups = [];
  for (const m of recs.slice(1)) {
    if (marked && m.says === 'overlapped') applyOverlapped(others.spans, m);
    groups.push(...opon.push(m));
  }
  const odu = oduLog({ header, marks: recs.slice(1), groups }).text;
  groups.push(...opon.end());
  const head = {
    record: 'replay',
    schema_version: 1,
    session_id: header.session_id,
    header_hash: header.hash,
    config,
    lost_evidence: [...v.files.bad.map((b) => ({ seq: b.seq, ref: b.ref, problem: b.problem })), ...others.lost],
  };
  const lines = [head, ...groups].map(canonicalize);
  // BB6 (guarantee 3): the odù log judged from scratch, as the closeout judges it; null with the judge's words when it refuses.
  const j = require('../../babalawo').judge({ header, oduText: odu });
  return { ok: true, words: `replayed ${recs.length - 1} marks into ${groups.length} groups`, lines, text: lines.join('\n') + '\n', odu, verdict: j.ok ? j.text : null, verdict_words: j.ok ? null : j.words };
}

module.exports = { replayFolder };
