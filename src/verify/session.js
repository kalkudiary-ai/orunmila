'use strict';

/**
 * src/verify/session.js — check one session folder end to end (brief v3 lines
 * 592, 694-700; Phase 1 slice A5), and say the answer in plain words.
 *
 * Checks, in order: the raw log's hash chain (spec/hash-chain.md); every raw
 * line against its schema (line 1 the session header, the rest marks); the
 * quarantine log's chain; every file kept beside the log that a mark names
 * (missing, or changed since its fingerprint was taken), and the baseline
 * snapshot when the header names one (`baseline.jsonl`, against the header's
 * baseline.fingerprint; slice N1b, LD170). It loads nothing
 * outside src/verify and spec/, so it can be read in one sitting. A field the
 * spec does not declare leaves a record intact (a reader ignores what it does
 * not know, brief v3 line 209), and the answer names each one (LD85).
 *
 * A log may run on in parts after a crash cut its last line (spec/hash-chain.md,
 * "A log in parts"; LD57): raw.jsonl, raw.2.jsonl, ... and the same for the
 * quarantine log. One chain runs through the parts; each part after the first
 * starts with a continuation record naming the cut exactly. A record so
 * continued is intact, and the answer names every cut.
 *
 *   verifySession(dir) -> { ok, words, counts, raw, schema, quarantine, files, undeclared }
 *   checkLog(dir, 'raw' | 'quarantine') -> one log across its parts:
 *     { ok, parts, file, records: [{ rec, part, line }], cuts: [{ part, line }],
 *       tail, fail }   tail: a cut last line no part continues yet
 *                    ({ part, line, bytes, fingerprint, last }), for a restart
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyText } = require('./chain');
const { compile, closed } = require('./schema');

const SPEC = path.join(__dirname, '..', '..', 'spec');
const read = (f) => JSON.parse(fs.readFileSync(path.join(SPEC, f), 'utf8'));
const load = (f) => compile(read(f));
const checkHeader = load('session-header.schema.json');
const checkMark = load('mark.schema.json');
const closedHeader = compile(closed(read('session-header.schema.json')));
const closedMark = compile(closed(read('mark.schema.json')));
const checkContinuation = load('continuation.schema.json');
const checkFooter = load('session-footer.schema.json');

/**
 * K4 (LD209): the session footer, when one was written: each line it names must be in its log with that
 * hash. Returns null when there is no footer, else { ok, words?, odu } (words name the first problem).
 */
function footerOf(dir, raw) {
  const file = path.join(dir, 'footer.json');
  if (!fs.existsSync(file)) return null;
  let f;
  try {
    f = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, words: 'Record broken: the session footer is not JSON.' };
  }
  if (checkFooter(f).length) return { ok: false, words: 'Record broken: the session footer is not a valid footer.' };
  const named = (recs, line, log) => {
    const r = recs.find((x) => x && x.seq === line.seq);
    if (!r) return `Record broken: the session footer names line ${line.seq + 1} of the ${log}, which the log does not hold.`;
    return r.hash === line.hash ? null : `Record broken: the session footer names line ${line.seq + 1} of the ${log} with a hash that line does not have.`;
  };
  const recs = raw.records.map((r) => r.rec);
  let oduAfter = 0;
  // K4b (LD210 (5)): the footer is this session's, and its raw line is the closeout's end.
  if (recs[0] && f.session_id !== recs[0].session_id) return { ok: false, words: 'Record broken: the session footer names another session.' };
  const rawProblem = named(recs, f.raw, 'raw log');
  if (rawProblem) return { ok: false, words: rawProblem };
  const end = recs.find((x) => x && x.seq === f.raw.seq);
  if (!(end.says === 'exited' && end.source === 'process' && end.target && end.target.kind === 'process' && end.target.name === 'closeout')) {
    return { ok: false, words: `Record broken: the session footer names line ${f.raw.seq + 1} of the raw log, which is not the closeout's end.` };
  }
  if (f.odu) {
    const text = fs.existsSync(path.join(dir, 'odu.jsonl')) ? fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8') : '';
    const chain = verifyText(text); // K4b: the odù log the footer names must verify as a chain, not only at its named line
    // K4c (LD214): a crash cut is excused only after the footer's own line.
    if (!chain.ok && (!chain.cut || chain.line <= f.odu.seq + 1)) return { ok: false, words: `Record broken at ${where('odù log', 1, chain.line)}: ${chainWords(chain.reason, chain.line, 'odù log', 1)}.` };
    const odu = records(text);
    const oduProblem = named(odu, f.odu, 'odù log');
    if (oduProblem) return { ok: false, words: oduProblem };
    oduAfter = odu.filter((x) => x && Number.isInteger(x.seq) && x.seq > f.odu.seq).length;
  }
  // LD249 (LD211 (5)): what follows the footer's lines is said, not hidden: a session resumed after its closeout, or a late
  // delivery. Each record is chained (intact); the footer only no longer names the log's end.
  const rawAfter = raw.records.filter((r) => !isContinuation(r) && r.rec && Number.isInteger(r.rec.seq) && r.rec.seq > f.raw.seq).length;
  return { ok: true, odu: Boolean(f.odu), after: { raw: rawAfter, odu: oduAfter } };
}
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

const fileWords = (b) =>
  `Record broken: ${b.baseline ? 'the baseline snapshot kept beside the log' : `the file kept beside the log for mark ${b.seq}`} (${b.ref}) ${b.problem === 'changed' ? 'was changed after it was written' : 'is missing'}.`;

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

  const undeclared = [];
  if (schema.ok) {
    for (const { rec, part, line } of raw.records) {
      if (isContinuation({ part, line })) continue;
      for (const e of (part === 1 && line === 1 ? closedHeader : closedMark)(rec)) if (e.keyword === 'additionalProperties') undeclared.push({ part, line, path: e.path });
    }
  }

  const files = { checked: 0, bad: [] };
  // The baseline snapshot the header names (LD170): it is a file kept beside the log, read by its fingerprint.
  const head = raw.records.length && raw.records[0].part === 1 && raw.records[0].line === 1 ? raw.records[0].rec : null;
  let baseline = null;
  if (head && head.baseline && typeof head.baseline === 'object' && typeof head.baseline.fingerprint === 'string') {
    const ref = head.baseline.fingerprint;
    let buf = null;
    try {
      buf = fs.readFileSync(path.join(dir, 'baseline.jsonl'));
    } catch {
      files.bad.push({ ref, seq: 0, problem: 'missing', baseline: true });
    }
    if (buf !== null && sha256(buf) !== ref) files.bad.push({ ref, seq: 0, problem: 'changed', baseline: true });
    else if (buf !== null) baseline = { entries: buf.toString('utf8').split('\n').length - 1 };
  }
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

  const footer = footerOf(dir, raw);

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
    words = fileWords(files.bad[0]);
  } else if (footer && !footer.ok) {
    words = footer.words;
  } else {
    const cuts = [
      ...raw.cuts.map((c) => `${where('raw log', c.part, c.line)} was cut by a crash and continues in part ${c.part + 1}`),
      ...quarantine.cuts.map((c) => `${where('quarantine log', c.part, c.line)} was cut by a crash and continues in part ${c.part + 1}`),
    ];
    const fields = undeclared.length
      ? [`${plural(undeclared.length, 'field', 'fields')} the spec does not declare: ${undeclared.map((u) => `${u.path} at ${where('raw log', u.part, u.line)}`).join(', ')}`]
      : [];
    const base = baseline ? [`the baseline snapshot of ${plural(baseline.entries, 'entry', 'entries')} matches the header`] : [];
    const after = (n, log) => (n ? [`${plural(n, 'record', 'records')} after the footer's line in the ${log} (written after its closeout)`] : []);
    const foot = footer ? [`the session footer matches the raw log${footer.odu ? ' and the odù log' : ''}`, ...after(footer.after.raw, 'raw log'), ...after(footer.after.odu, 'odù log')] : [];
    words =
      `Record intact: ${plural(counts.marks, 'mark', 'marks')}, ${plural(counts.quarantined, 'quarantined input', 'quarantined inputs')}, ` +
      `${plural(counts.kept_files, 'kept file', 'kept files')}, unbroken${[...cuts, ...fields, ...base, ...foot].map((c) => `; ${c}`).join('')}.`;
  }
  return { ok: raw.ok && schema.ok && quarantine.ok && files.bad.length === 0 && (!footer || footer.ok), words, counts, raw: summary(raw), schema, quarantine: summary(quarantine), files, undeclared };
}

module.exports = { verifySession, checkLog, fileWords };
