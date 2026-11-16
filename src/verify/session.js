'use strict';

/**
 * src/verify/session.js — check one session folder end to end (brief v3 lines
 * 592, 694-700; Phase 1 slice A5), and say the answer in plain words.
 *
 * Checks, in order: the raw log's hash chain (spec/hash-chain.md); every raw
 * line against its schema (line 1 the session header, the rest marks); the
 * quarantine log's chain; every file kept beside the log that a mark names
 * (missing, or changed since its fingerprint was taken). It loads nothing
 * outside src/verify and spec/, so it can be read in one sitting.
 *
 *   verifySession(dir) -> { ok, words, counts, raw, schema, quarantine, files }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyText } = require('./chain');
const { compile } = require('./schema');

const SPEC = path.join(__dirname, '..', '..', 'spec');
const load = (f) => compile(JSON.parse(fs.readFileSync(path.join(SPEC, f), 'utf8')));
const checkHeader = load('session-header.schema.json');
const checkMark = load('mark.schema.json');
const REF_SLOTS = ['diff_ref', 'output_ref'];
const REF = /^sha256:[0-9a-f]{64}$/;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function chainWords(reason, line, log) {
  if (reason === 'missing') return `the ${log} is missing or empty`;
  if (reason === 'changed') return 'this line was changed after it was written';
  if (reason === 'does not follow') return `this line does not follow line ${line - 1} (a line was deleted, inserted or moved before it)`;
  if (reason === 'out of sequence') return "this line's seq is out of sequence";
  return 'this line is not in canonical form (it was edited, or written by something else)';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function records(text, upTo) {
  return text
    .split('\n')
    .slice(0, upTo)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
}

function verifySession(dir) {
  const rawText = readText(path.join(dir, 'raw.jsonl'));
  const raw = verifyText(rawText);
  const quarantine = verifyText(readText(path.join(dir, 'quarantine.jsonl')));
  const sound = raw.ok ? raw.lines : raw.checked; // lines whose chain holds
  const recs = records(rawText, sound);

  let schema = { ok: true };
  for (let i = 0; i < recs.length && schema.ok; i++) {
    const errs = (i === 0 ? checkHeader : checkMark)(recs[i]);
    if (errs.length) schema = { ok: false, line: i + 1, errors: errs };
  }

  const files = { checked: 0, bad: [] };
  for (const rec of recs) {
    const d = rec && rec.detail && typeof rec.detail === 'object' ? rec.detail : {};
    for (const slot of REF_SLOTS) {
      const ref = d[slot];
      if (typeof ref !== 'string' || !REF.test(ref)) continue;
      files.checked++;
      let buf;
      try {
        buf = fs.readFileSync(path.join(dir, 'files', ref.slice(7)));
      } catch {
        files.bad.push({ ref, seq: rec.seq, problem: 'missing' });
        continue;
      }
      const hex = crypto.createHash('sha256').update(buf).digest('hex');
      if (`sha256:${hex}` !== ref) files.bad.push({ ref, seq: rec.seq, problem: 'changed' });
    }
  }

  const counts = {
    marks: Math.max(0, sound - 1),
    quarantined: quarantine.ok ? quarantine.lines - 1 : quarantine.checked,
    kept_files: files.checked,
  };

  let words;
  if (!schema.ok) {
    const e = schema.errors[0];
    words = `Record broken at line ${schema.line} of the raw log: it is not a valid ${schema.line === 1 ? 'session header' : 'mark'} (${e.path} ${e.keyword}).`;
  } else if (!raw.ok) {
    words = `Record broken at line ${raw.line} of the raw log: ${chainWords(raw.reason, raw.line, 'raw log')}.`;
  } else if (!quarantine.ok) {
    words = `Record broken at line ${quarantine.line} of the quarantine log: ${chainWords(quarantine.reason, quarantine.line, 'quarantine log')}.`;
  } else if (files.bad.length) {
    const b = files.bad[0];
    words = `Record broken: the file kept beside the log for mark ${b.seq} (${b.ref}) ${b.problem === 'changed' ? 'was changed after it was written' : 'is missing'}.`;
  } else {
    words =
      `Record intact: ${plural(counts.marks, 'mark', 'marks')}, ${plural(counts.quarantined, 'quarantined input', 'quarantined inputs')}, ` +
      `${plural(counts.kept_files, 'kept file', 'kept files')}, unbroken.`;
  }
  return { ok: raw.ok && schema.ok && quarantine.ok && files.bad.length === 0, words, counts, raw, schema, quarantine, files };
}

module.exports = { verifySession };
