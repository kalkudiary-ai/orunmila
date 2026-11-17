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
 * A log may run on in parts after a crash cut its last line (spec/hash-chain.md,
 * "A log in parts"; LD57): raw.jsonl, raw.2.jsonl, ... and the same for the
 * quarantine log. One chain runs through the parts; each part after the first
 * starts with a continuation record naming the cut exactly. A record so
 * continued is intact, and the answer names every cut.
 *
 *   verifySession(dir) -> { ok, words, counts, raw, schema, quarantine, files }
 *   checkLog(dir, 'raw' | 'quarantine') -> one log across its parts:
 *     { ok, parts, file, records: [{ rec, part, line }], cuts: [{ part, line }],
 *       tail, fail }   tail: a cut last line no part continues yet
 *                    ({ part, line, bytes, fingerprint, last }), for a restart
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
const checkContinuation = load('continuation.schema.json');
const REF_SLOTS = ['diff_ref', 'output_ref'];
const REF = /^sha256:[0-9a-f]{64}$/;
const LOG_NAMES = { raw: 'raw log', quarantine: 'quarantine log' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
const partFile = (dir, name, part) => path.join(dir, part === 1 ? `${name}.jsonl` : `${name}.${part}.jsonl`);
const where = (log, part, line) => (part > 1 ? `line ${line} of part ${part} of the ${log}` : `line ${line} of the ${log}`);

function chainWords(reason, line, log, part) {
  if (reason === 'missing') return `the ${log} is missing or empty`;
  if (reason === 'changed') return 'this line was changed after it was written';
  if (reason === 'does not follow') {
    if (part > 1 && line === 1) return `this line does not follow the last whole line of part ${part - 1}`;
    return `this line does not follow line ${line - 1} (a line was deleted, inserted or moved before it)`;
  }
  if (reason === 'out of sequence') return "this line's seq is out of sequence";
  if (reason === 'cut') return 'this line was cut short, as a crash leaves it, and no later part continues the log';
  if (reason === 'not the cut') return `it does not match the cut at the end of part ${part - 1}`;
  return 'this line is not in canonical form (it was edited, or written by something else)';
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.alloc(0);
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

/** One log, all its parts, checked as one chain. */
function checkLog(dir, name) {
  const out = { ok: false, parts: 0, file: partFile(dir, name, 1), records: [], cuts: [], tail: null, fail: null };
  let prev = null; // the last whole line so far
  let cut = null; // the cut at the end of the part just checked
  for (let part = 1; ; part++) {
    const file = partFile(dir, name, part);
    if (part > 1 && !fs.existsSync(file)) break;
    if (part > 1 && !cut) {
      out.fail = { part: part - 1, reason: 'not cut' };
      return out;
    }
    const bytes = readBytes(file);
    const text = bytes.toString('utf8');
    out.parts = part;
    out.file = file;
    const res = verifyText(text, part === 1 ? undefined : { prevHash: prev.hash, seq: prev.seq + 1 });
    const recs = records(text, res.ok ? res.lines : res.checked);
    if (part > 1 && recs.length) {
      const c = recs[0];
      const errors = checkContinuation(c);
      if (errors.length) {
        out.fail = { part, line: 1, reason: 'continuation schema', errors };
        return out;
      }
      if (c.log !== name || c.part !== part || c.cut.line !== cut.line || c.cut.bytes !== cut.bytes || c.cut.fingerprint !== cut.fingerprint) {
        out.fail = { part, line: 1, reason: 'not the cut' };
        return out;
      }
      out.cuts.push({ part: part - 1, line: cut.line });
    }
    recs.forEach((rec, i) => out.records.push({ rec, part, line: i + 1 }));
    if (recs.length) prev = recs[recs.length - 1];
    cut = null;
    if (!res.ok) {
      if (!(res.cut && recs.length)) {
        out.fail = { part, line: res.line, reason: res.reason };
        return out;
      }
      // Cut by a crash after at least one whole line: the next part, if any, must name these bytes.
      const frag = bytes.subarray(bytes.lastIndexOf(0x0a) + 1);
      cut = { line: res.line, bytes: frag.length, fingerprint: sha256(frag) };
    }
  }
  if (cut) {
    out.tail = { part: out.parts, ...cut, last: prev };
    out.fail = { part: out.parts, line: cut.line, reason: 'cut' };
    return out;
  }
  out.ok = true;
  return out;
}

const isContinuation = (r) => r.part > 1 && r.line === 1;
const summary = (l) => ({ ok: l.ok, parts: l.parts, cuts: l.cuts, ...(l.fail || {}) });

function failWords(l, name) {
  const log = LOG_NAMES[name];
  const f = l.fail;
  if (f.reason === 'not cut') return `Record broken: part ${f.part + 1} of the ${log} follows part ${f.part}, which was not cut.`;
  if (f.reason === 'continuation schema') {
    const e = f.errors[0];
    return `Record broken at ${where(log, f.part, f.line)}: it is not a valid continuation (${e.path} ${e.keyword}).`;
  }
  return `Record broken at ${where(log, f.part, f.line)}: ${chainWords(f.reason, f.line, log, f.part)}.`;
}

function verifySession(dir) {
  const raw = checkLog(dir, 'raw');
  const quarantine = checkLog(dir, 'quarantine');
  const marks = raw.records.filter((r) => !(r.part === 1 && r.line === 1) && !isContinuation(r));

  let schema = { ok: true };
  for (const { rec, part, line } of raw.records) {
    if (isContinuation({ part, line })) continue; // checked with its part
    const errs = (part === 1 && line === 1 ? checkHeader : checkMark)(rec);
    if (errs.length) {
      schema = { ok: false, part, line, errors: errs };
      break;
    }
  }

  const files = { checked: 0, bad: [] };
  for (const { rec } of marks) {
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
    marks: marks.length,
    quarantined: quarantine.records.filter((r) => !(r.part === 1 && r.line === 1) && !isContinuation(r)).length,
    kept_files: files.checked,
  };

  let words;
  if (!schema.ok) {
    const e = schema.errors[0];
    const kind = schema.part === 1 && schema.line === 1 ? 'session header' : 'mark';
    words = `Record broken at ${where('raw log', schema.part, schema.line)}: it is not a valid ${kind} (${e.path} ${e.keyword}).`;
  } else if (!raw.ok) {
    words = failWords(raw, 'raw');
  } else if (!quarantine.ok) {
    words = failWords(quarantine, 'quarantine');
  } else if (files.bad.length) {
    const b = files.bad[0];
    words = `Record broken: the file kept beside the log for mark ${b.seq} (${b.ref}) ${b.problem === 'changed' ? 'was changed after it was written' : 'is missing'}.`;
  } else {
    const cuts = [
      ...raw.cuts.map((c) => `${where('raw log', c.part, c.line)} was cut by a crash and continues in part ${c.part + 1}`),
      ...quarantine.cuts.map((c) => `${where('quarantine log', c.part, c.line)} was cut by a crash and continues in part ${c.part + 1}`),
    ];
    words =
      `Record intact: ${plural(counts.marks, 'mark', 'marks')}, ${plural(counts.quarantined, 'quarantined input', 'quarantined inputs')}, ` +
      `${plural(counts.kept_files, 'kept file', 'kept files')}, unbroken${cuts.map((c) => `; ${c}`).join('')}.`;
  }
  return { ok: raw.ok && schema.ok && quarantine.ok && files.bad.length === 0, words, counts, raw: summary(raw), schema, quarantine: summary(quarantine), files };
}

module.exports = { verifySession, checkLog };
