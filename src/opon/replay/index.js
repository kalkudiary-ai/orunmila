'use strict';

/**
 * src/opon/replay/index.js — the replay harness (Phase 2 slice R1, LD142,
 * LD152; brief v4 lines 607-608; guarantee 3; tests 13, 34, 35; open question
 * 4). It feeds a recorded raw log into a fresh Ọpọ́n and gives back its output,
 * so every settling rule is built and tested through it.
 *
 *   replayFolder(dir) -> { ok, words, lines, text }
 *
 * The raw log must verify (chain and records): replay never judges an altered
 * record, and refuses with the verifier's words. Settings come from the
 * session header, never from today's defaults (test 35); nothing is read from
 * the files the marks name, so a file changed on disk after the session
 * changes nothing (test 34). A file kept beside the log that is missing or
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

function replayFolder(dir) {
  const raw = checkLog(dir, 'raw');
  const v = verifySession(dir);
  if (!raw.ok || !v.schema.ok) return { ok: false, words: `replay refused: ${v.words}`, lines: [], text: '' };
  const recs = raw.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec);
  const header = recs[0];
  const config = configFromHeader(header);
  const opon = createOpon({ sessionId: header.session_id, config });
  const groups = [];
  for (const m of recs.slice(1)) groups.push(...opon.push(m));
  groups.push(...opon.end());
  const head = {
    record: 'replay',
    schema_version: 1,
    session_id: header.session_id,
    header_hash: header.hash,
    config,
    lost_evidence: v.files.bad.map((b) => ({ seq: b.seq, ref: b.ref, problem: b.problem })),
  };
  const lines = [head, ...groups].map(canonicalize);
  return { ok: true, words: `replayed ${recs.length - 1} marks into ${groups.length} groups`, lines, text: lines.join('\n') + '\n' };
}

module.exports = { replayFolder };
