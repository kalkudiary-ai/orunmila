// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/ledger/session-log.js — one session's log folder (brief v3 lines
 * 213, 237, 266, 338, 340; Phase 1 slice A4). Not wired to capture yet.
 *
 *   <dir>/raw.jsonl          the raw log: the sealed session header (seq 0),
 *                            then one sealed mark per line (spec/hash-chain.md)
 *   <dir>/quarantine.jsonl   every input that is not a valid mark, with its
 *                            reasons, in a chain of its own; never dropped
 *   <dir>/files/<hex>        files kept beside the log (diffs, full output),
 *                            whole, named by the plain SHA-256 of their bytes
 *   <dir>/baseline.jsonl     the baseline snapshot at session start (station 4,
 *                            slice N1b, LD170), when one was taken: its
 *                            fingerprint is the header's baseline.fingerprint,
 *                            so the hash chain covers it (brief v4 line 387)
 *
 * Intake alone assigns seq, prev_hash and hash; an input that sets one is
 * quarantined. A mark naming a diff_ref or output_ref that was not kept is
 * quarantined too, so no mark points at evidence that does not exist. Files
 * are kept only through append(mark, files), with their mark (LD59).
 *
 * Every input, quarantined text included, and every kept text file is redacted
 * first (src/opon/intake/redact.js, slice A6), before anything is hashed or
 * written; `.env` values come in as `envValues`, or as `envEntries`
 * ({ names, value }, as the leak check's readEnvEntries gives them), held in
 * memory only. After redaction, each record and kept file is searched for
 * those values right after it is written (the leak check, LD101), and a hit
 * is reported by name in append's `leaks` and in leaks().
 * One writer per session log is assumed (one intake per machine, slice B1).
 * createSessionLog makes a new folder, with `baseline` (the snapshot's text,
 * src/opon/net/baseline.js) exactly when the header names one, and refuses a
 * snapshot that does not match the header's fingerprint; openSessionLog reopens one that
 * verifies, for an intake that restarted (slice B1c, test 84). ended() says
 * whether the raw log holds the session's end mark (LD55); pin() is the
 * process the session is pinned to, from the record (LD58), or null;
 * header() is the sealed session header. With `guard`, watch(log, file) and
 * wrote(log, text) put another log of the session under the guard (TE1's rest,
 * LD285: the odù and verdict logs, which the live Ọpọ́n writes). `onRecord(record)`, given to either,
 * is called with each mark as written to the raw log, after the log's own
 * state has moved on, so it may append again (the live Ọpọ́n, slice L1c).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compile } = require('../../verify/schema');
const { seal } = require('../../verify/chain');
const { canonicalize } = require('../../verify/canonical');
const { verifySession, checkLog, fileWords } = require('../../verify/session');
const { redactText, redactMark, usedValue } = require('../intake/redact');
const { scanBuffer } = require('../intake/leak-check');
const { nowMono } = require('../intake/mono');
const { createGuard } = require('./guard');

const SPEC = path.join(__dirname, '..', '..', '..', 'spec');
const MARK_SCHEMA = JSON.parse(fs.readFileSync(path.join(SPEC, 'mark.schema.json'), 'utf8'));
const checkMark = compile(MARK_SCHEMA);
const EXCERPT_MAX = MARK_SCHEMA.definitions.detail.properties.output_excerpt.maxLength; // F12 (LD247), in characters (code points)
const checkHeader = compile(JSON.parse(fs.readFileSync(path.join(SPEC, 'session-header.schema.json'), 'utf8')));

const INTAKE_FIELDS = ['seq', 'prev_hash', 'hash'];
const REF_SLOTS = ['diff_ref', 'output_ref'];
const REF = /^sha256:[0-9a-f]{64}$/;

const line = (rec) => canonicalize(rec) + '\n';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The session's end mark (LD55): ended, about the session itself. */
const endsSession = (rec) => rec.says === 'ended' && isObject(rec.target) && rec.target.kind === 'session';
/** The pin a mark records (LD58): an HTTP Glove mark's sender_pid, which intake alone writes; else null. */
const pinOf = (rec) =>
  ['hook', 'agent_claim'].includes(rec.source) && isObject(rec.detail) && rec.detail.channel === 'http' && Number.isInteger(rec.detail.sender_pid) ? rec.detail.sender_pid : null;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const describe = (errs) => errs.map((e) => `${e.path} ${e.keyword}: ${e.message}`);

function refsOf(rec) {
  const d = isObject(rec.detail) ? rec.detail : {};
  return REF_SLOTS.filter((s) => typeof d[s] === 'string' && REF.test(d[s])).map((s) => ({ slot: s, ref: d[s] }));
}

/**
 * The values the leak check looks for (LD101): every `.env` value redactText
 * uses, from envValues (named by none) and envEntries, each once, with all
 * its names.
 */
function leakEntries(envValues, envEntries) {
  const byValue = new Map();
  const add = (value, names) => {
    if (!usedValue(value)) return;
    if (!byValue.has(value)) byValue.set(value, new Set());
    for (const n of names) byValue.get(value).add(n);
  };
  for (const v of envValues) add(v, []);
  for (const e of envEntries) add(e.value, e.names);
  return [...byValue].map(([value, names]) => ({ names: [...names].sort(), value }));
}

function createSessionLog(dir, headerInput, { envValues = [], envEntries = [], baseline = null, onRecord = null, guard = null } = {}) {
  const entries = leakEntries(envValues, envEntries); // first: an entry with no names list refuses the log before any write
  const rawFile = path.join(dir, 'raw.jsonl');
  const qFile = path.join(dir, 'quarantine.jsonl');
  const filesDir = path.join(dir, 'files');
  if (fs.existsSync(rawFile)) throw new Error(`a session log already exists in ${dir}`);
  for (const k of INTAKE_FIELDS) if (k in headerInput) throw new Error(`the header sets ${k}, which intake assigns`);
  // The baseline and the header's fingerprint of it come together, or not at all (LD170).
  const named = isObject(headerInput.baseline);
  if (named !== (baseline !== null)) throw new Error(named ? 'the header names a baseline snapshot, but none was given' : 'a baseline snapshot was given, but the header does not name it');
  if (named && `sha256:${sha256(Buffer.from(String(baseline), 'utf8'))}` !== headerInput.baseline.fingerprint) {
    throw new Error("the baseline snapshot does not match the header's baseline.fingerprint");
  }
  const header = seal({ ...headerInput, seq: 0 }, null);
  const errs = checkHeader(header);
  if (errs.length) throw new Error(`malformed session header: ${describe(errs).join('; ')}`);

  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(filesDir, 0o700);
  if (named) {
    // Placed before the raw log, whole: a crash between the two leaves no log that names a missing
    // snapshot, and the next start, finding no raw log, places a fresh one over the stale file.
    const tmp = path.join(dir, `baseline.jsonl.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, String(baseline), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, 'baseline.jsonl'));
  }
  fs.writeFileSync(rawFile, line(header), { flag: 'wx', mode: 0o600 });
  const qHeader = seal({ schema_version: 1, record: 'quarantine_header', session_id: header.session_id, seq: 0 }, null);
  fs.writeFileSync(qFile, line(qHeader), { flag: 'wx', mode: 0o600 });
  return writer(dir, { rawFile, qFile, header, last: header, timed: header, qLast: qHeader, counts: { marks: 0, quarantined: 0 }, ended: false, pin: null, envValues, envEntries, entries, headerLine: line(header), baselineText: named ? String(baseline) : null, onRecord, guard });
}

/** Start the next part of a log a crash cut (LD57): its first line names the cut and follows the last whole line. */
function continueLog(dir, name, tail, sessionId) {
  const part = tail.part + 1;
  const cont = seal(
    { schema_version: 1, record: 'continuation', session_id: sessionId, log: name, part, seq: tail.last.seq + 1, cut: { line: tail.line, bytes: tail.bytes, fingerprint: tail.fingerprint } },
    tail.last.hash,
  );
  const file = path.join(dir, `${name}.${part}.jsonl`);
  fs.writeFileSync(file, line(cont), { flag: 'wx', mode: 0o600 });
  return { file, last: cont };
}

/**
 * Reopen an existing session log, for an intake that restarted (test 84): both
 * chains continue where they stopped. A log whose last line a crash cut is
 * never edited: it continues in a new part whose first line names the cut
 * (LD57, spec/hash-chain.md "A log in parts"). Any other log that does not
 * verify (an edited line, a broken quarantine log, a changed or missing kept
 * file, no log) is refused with the verifier's words and nothing is written:
 * a broken chain is never extended, and nothing in a session is ever edited
 * (line 348). Known limit: a part whose own first line is cut is refused.
 */
function openSessionLog(dir, { envValues = [], envEntries = [], onRecord = null, guard = null } = {}) {
  const entries = leakEntries(envValues, envEntries); // first: an entry with no names list refuses the reopen before any write
  const v = verifySession(dir);
  const rawLog = checkLog(dir, 'raw');
  const qLog = checkLog(dir, 'quarantine');
  // Only a cut last line (a crash mid-write) may stand between a log and its reopening (LD57).
  const chainsOk = (rawLog.ok || rawLog.tail) && (qLog.ok || qLog.tail);
  if (!v.ok && !(chainsOk && v.schema.ok && v.files.bad.length === 0)) {
    const why = chainsOk && v.schema.ok ? fileWords(v.files.bad[0]) : v.words;
    throw new Error(`the session log in ${dir} cannot be reopened: ${why}`);
  }
  const header = rawLog.records[0].rec;
  const ends = (l, name) => (l.tail ? continueLog(dir, name, l.tail, header.session_id) : { file: l.file, last: l.records[l.records.length - 1].rec });
  const rawEnd = ends(rawLog, 'raw');
  const qEnd = ends(qLog, 'quarantine');
  const timedRecs = rawLog.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec); // header and marks: no continuation
  const marks = timedRecs.slice(1);
  const counts = { marks: v.counts.marks, quarantined: v.counts.quarantined };
  const pinning = marks.find((r) => pinOf(r) !== null);
  return writer(dir, {
    rawFile: rawEnd.file,
    qFile: qEnd.file,
    header,
    entries,
    last: rawEnd.last,
    timed: timedRecs[timedRecs.length - 1],
    qLast: qEnd.last,
    counts,
    ended: marks.some(endsSession),
    envEntries,
    pin: pinning ? pinOf(pinning) : null,
    envValues,
    onRecord,
    guard,
  });
}

/**
 * Appends to one session folder whose chains end at `last` (raw, in rawFile)
 * and `qLast` (quarantine, in qFile); `timed` is the raw log's last header or
 * mark, which last() reports (a continuation record has no times).
 */
function writer(dir, { rawFile, qFile, header, last, timed, qLast, counts, ended, pin, envValues, envEntries = [], entries, headerLine = null, baselineText = null, onRecord = null, guard = null }) {
  const filesDir = path.join(dir, 'files');
  // TE1 (LD279): with `guard` ({ shadowDir }, off unless asked), the raw and quarantine logs are each watched for a change
  // Orunmila did not make, against Orunmila's own copy in shadowDir; a change is recorded as a tampered mark and put back.
  const guards = guard ? [['raw', rawFile], ['quarantine', qFile]].map(([log, file]) => ({ log, g: createGuard(file, path.join(guard.shadowDir, path.basename(file))) })) : [];
  const guardOf = (log) => (guards.find((x) => x.log === log) || {}).g;
  let guarding = false;
  // TE1's rest (LD285): the session's other logs, which the live Ọpọ́n writes (odu.jsonl, verdict.jsonl). watch() starts
  // from the file as it stands, right after Orunmila wrote it; wrote() follows each of Orunmila's own appends. Every
  // append the live Ọpọ́n makes comes from a raw append (onRecord), which looks for tampering first.
  function watch(log, file) {
    if (!guard || guardOf(log)) return;
    guards.push({ log, g: createGuard(file, path.join(guard.shadowDir, path.basename(file))) });
  }
  function wrote(log, text) {
    if (guardOf(log)) guardOf(log).wrote(text);
  }

  /** TE1: look at each guarded log; record each change found (when its log was put back) and return them all. */
  function lookForTamper() {
    if (!guards.length || guarding) return [];
    guarding = true;
    const found = [];
    try {
      for (const { log, g } of guards) {
        const r = g.check();
        if (!r) continue;
        found.push({ log, ...r });
        if (!r.restored) continue; // a log not put back is never written to: verify names where its chain breaks
        const detail = { what: 'log_location', change: r.change, fingerprint_before: r.fingerprint_before, fingerprint: r.fingerprint, restored: true, reason: `the ${log} log was ${r.change} by something other than Orunmila and put back from Orunmila's own copy` };
        if (r.removed) detail.removed = r.removed;
        if (r.added) detail.added = r.added;
        append({ schema_version: 1, session_id: header.session_id, source: 'process', agent: null, turn: null, sub_agent: null, observed_at: new Date().toISOString(), target: { kind: 'file', path: g.file, outside: true }, says: 'tampered', detail, cause_hint: null });
      }
    } finally {
      guarding = false;
    }
    return found;
  }

  // LD101: the leak check after redaction. Each record and kept file is searched,
  // right after it is written, for every `.env` value the redactor uses, in the
  // spellings `orunmila leak-check` uses (spellings(): a value holding a character
  // JSON escapes is not found three JSON levels deep). A hit is reported by
  // name, length and count, never by value; the record stays: nothing is dropped.
  envValues = [...envValues, ...envEntries.map((e) => e.value)]; // the entries' values are redacted too
  const leaks = [];
  const copy = (h) => ({ ...h, names: [...h.names] });
  function check(bytes, at, found) {
    for (const h of scanBuffer(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'), entries)) {
      const hit = { ...at, ...h };
      leaks.push(hit);
      found.push(copy(hit));
    }
  }
  const reported = (r, found) => (found.length ? { ...r, leaks: found } : r);
  if (headerLine !== null) check(headerLine, { log: 'raw', seq: 0 }, []);
  if (baselineText !== null) check(baselineText, { log: 'baseline' }, []);

  /** Keep a file beside the log: text is redacted first (line 266); binary is kept as is. Returns { ref, kinds }. */
  function keep(content, found) {
    let buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const text = buf.toString('utf8');
    let kinds = [];
    if (Buffer.from(text, 'utf8').equals(buf)) {
      const r = redactText(text, envValues);
      buf = Buffer.from(r.text, 'utf8');
      kinds = r.kinds;
    }
    const hex = sha256(buf);
    const file = path.join(filesDir, hex);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
    check(buf, { log: 'files', ref: `sha256:${hex}` }, found);
    return { ref: `sha256:${hex}`, kinds };
  }

  function quarantine(received, reasons, redactions, kept, found) {
    const entry = { schema_version: 1, record: 'quarantined', session_id: header.session_id, seq: qLast.seq + 1, received_at: new Date().toISOString(), reasons, received };
    if (redactions.length) entry.redactions = redactions;
    if (kept.length) entry.kept = kept; // the files kept with it: evidence is never dropped (LD59)
    const sealed = seal(entry, qLast.hash);
    fs.appendFileSync(qFile, line(sealed));
    if (guardOf('quarantine')) guardOf('quarantine').wrote(line(sealed));
    check(line(sealed), { log: 'quarantine', seq: sealed.seq }, found);
    qLast = sealed;
    counts.quarantined++;
    return reported({ ok: false, quarantined: sealed.seq, reasons }, found);
  }

  /**
   * Append one mark. `files` are the files kept with it (an adapter's keep
   * list, [{ slot, text }]): each is kept first, redacted, and the mark's slot
   * names it and its detail.redactions notes the kinds, in this one call, so
   * the file and its note cannot come apart (LD59). A quarantined mark's files
   * are kept too, and its quarantine entry lists them.
   */
  function append(input, files = []) {
    lookForTamper(); // TE1: a change made since Orunmila's last write is recorded first, and the log put back
    const found = []; // this call's leak-check hits (LD101)
    const kept = files.map((f) => ({ slot: f.slot, ...keep(f.text, found) }));
    const refs = kept.map((k) => k.ref);
    // Redact first, before anything is hashed or written, quarantined text included (lines 248, 340).
    let value;
    try {
      value = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
    } catch (e) {
      const r = redactText(typeof input === 'string' ? input : String(input), envValues);
      return quarantine(r.text, [`not JSON: ${e.message}`], r.kinds, refs, found);
    }
    const { mark: m, kinds: redactions } = redactMark(value, envValues);
    const received = JSON.stringify(m);
    const reject = (reasons) => quarantine(received, reasons, redactions, refs, found);
    if (!isObject(m)) return reject(['not a JSON object']);
    // The slot name is the caller's text, so it is never echoed into a reason (it could hold a secret).
    const reasons = kept.filter((k) => !REF_SLOTS.includes(k.slot)).map(() => 'a kept file is named for a detail slot that holds no kept file');
    for (const k of INTAKE_FIELDS) if (k in m) reasons.push(`the source sets ${k}, which intake assigns`);
    if (m.session_id !== header.session_id) reasons.push(`session_id ${JSON.stringify(m.session_id)} is not this session's`);
    if (reasons.length) return reject(reasons);
    if (isObject(m.detail) && typeof m.detail.output_excerpt === 'string' && [...m.detail.output_excerpt].length > EXCERPT_MAX) {
      // F12 (LD247): redaction lengthens text, so an excerpt cut at the limit can come out over it: cut it back, after
      // redaction, keeping the whole redacted excerpt as the output_ref when no full output was kept with the mark.
      const whole = m.detail.output_excerpt;
      if (!kept.some((k) => k.slot === 'output_ref')) {
        const k = { slot: 'output_ref', ...keep(whole, found) };
        kept.push(k);
        refs.push(k.ref);
      }
      m.detail.output_excerpt = [...whole].slice(0, EXCERPT_MAX).join('');
    }
    if (isObject(m.detail)) {
      for (const k of kept) {
        m.detail[k.slot] = k.ref;
        if (k.kinds.length) m.detail.redactions = [...new Set([...(m.detail.redactions || []), ...k.kinds])].sort();
      }
    }

    if (m.mono_ns === undefined) {
      m.mono_ns = nowMono(); // a decimal string (brief v4 line 238)
      if (isObject(m.detail)) m.detail = { ...m.detail, stamped_by: 'intake' };
    }
    let sealed;
    try {
      sealed = seal({ ...m, seq: last.seq + 1 }, last.hash);
    } catch (e) {
      return reject([`cannot be serialised canonically: ${e.message}`]);
    }
    reasons.push(...describe(checkMark(sealed)));
    for (const { slot, ref } of refsOf(sealed)) {
      if (!fs.existsSync(path.join(filesDir, ref.slice(7)))) reasons.push(`detail.${slot} ${ref} refers to a file not kept beside the log`);
    }
    if (reasons.length) return reject(reasons);
    fs.appendFileSync(rawFile, line(sealed));
    if (guardOf('raw')) guardOf('raw').wrote(line(sealed));
    check(line(sealed), { log: 'raw', seq: sealed.seq }, found);
    last = sealed;
    timed = sealed;
    counts.marks++;
    if (endsSession(sealed)) ended = true;
    if (pin === null) pin = pinOf(sealed);
    if (onRecord) onRecord(sealed); // L1c: the record as written, after the log's own state has moved on
    return reported({ ok: true, seq: sealed.seq }, found);
  }

  /** The raw log's last record: where an intake that restarts finds when it last wrote (test 84). */
  const lastRecord = () => ({ seq: timed.seq, mono_ns: timed.mono_ns, observed_at: timed.observed_at });

  return { append, counts: () => ({ ...counts }), last: lastRecord, ended: () => ended, pin: () => pin, leaks: () => leaks.map(copy), header: () => header, guard: lookForTamper, watch, wrote };
}

/** Check a session folder: the ledger uses src/verify for checking (brief v3 line 618). */
const verifySessionLog = verifySession;

module.exports = { createSessionLog, openSessionLog, verifySessionLog };
