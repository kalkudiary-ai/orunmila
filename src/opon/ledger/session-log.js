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
 *
 * Intake alone assigns seq, prev_hash and hash; an input that sets one is
 * quarantined. A mark naming a diff_ref or output_ref that was not kept is
 * quarantined too, so no mark points at evidence that does not exist.
 *
 * Every input, quarantined text included, and every kept text file is redacted
 * first (src/opon/intake/redact.js, slice A6), before anything is hashed or
 * written; `.env` values come in as `envValues`, held in memory only.
 * One writer per session log is assumed (one intake per machine, slice B1).
 * createSessionLog makes a new folder; openSessionLog reopens one that
 * verifies, for an intake that restarted (slice B1c, test 84). ended() says
 * whether the raw log holds the session's end mark (LD55); pin() is the
 * process the session is pinned to, from the record (LD58), or null.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compile } = require('../../verify/schema');
const { seal } = require('../../verify/chain');
const { canonicalize } = require('../../verify/canonical');
const { verifySession, checkLog, fileWords } = require('../../verify/session');
const { redactText, redactMark } = require('../intake/redact');
const { nowMono } = require('../intake/mono');

const SPEC = path.join(__dirname, '..', '..', '..', 'spec');
const checkMark = compile(JSON.parse(fs.readFileSync(path.join(SPEC, 'mark.schema.json'), 'utf8')));
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

function createSessionLog(dir, headerInput, { envValues = [] } = {}) {
  const rawFile = path.join(dir, 'raw.jsonl');
  const qFile = path.join(dir, 'quarantine.jsonl');
  const filesDir = path.join(dir, 'files');
  if (fs.existsSync(rawFile)) throw new Error(`a session log already exists in ${dir}`);
  for (const k of INTAKE_FIELDS) if (k in headerInput) throw new Error(`the header sets ${k}, which intake assigns`);
  const header = seal({ ...headerInput, seq: 0 }, null);
  const errs = checkHeader(header);
  if (errs.length) throw new Error(`malformed session header: ${describe(errs).join('; ')}`);

  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(filesDir, 0o700);
  fs.writeFileSync(rawFile, line(header), { flag: 'wx', mode: 0o600 });
  const qHeader = seal({ schema_version: 1, record: 'quarantine_header', session_id: header.session_id, seq: 0 }, null);
  fs.writeFileSync(qFile, line(qHeader), { flag: 'wx', mode: 0o600 });
  return writer(dir, { rawFile, qFile, header, last: header, timed: header, qLast: qHeader, counts: { marks: 0, quarantined: 0 }, ended: false, pin: null, envValues });
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
 * Known limit: the redaction kinds of a file kept before the reopen are not
 * merged into a later mark that names it (they live only in memory).
 */
function openSessionLog(dir, { envValues = [] } = {}) {
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
    last: rawEnd.last,
    timed: timedRecs[timedRecs.length - 1],
    qLast: qEnd.last,
    counts,
    ended: marks.some(endsSession),
    pin: pinning ? pinOf(pinning) : null,
    envValues,
  });
}

/**
 * Appends to one session folder whose chains end at `last` (raw, in rawFile)
 * and `qLast` (quarantine, in qFile); `timed` is the raw log's last header or
 * mark, which last() reports (a continuation record has no times).
 */
function writer(dir, { rawFile, qFile, header, last, timed, qLast, counts, ended, pin, envValues }) {
  const filesDir = path.join(dir, 'files');

  const keptKinds = new Map(); // ref -> redaction kinds of that kept file

  /** Keep a file beside the log: text is redacted first (line 266); binary is kept as is. */
  function keep(content) {
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
    const ref = `sha256:${hex}`;
    if (kinds.length) keptKinds.set(ref, kinds);
    return ref;
  }

  function quarantine(received, reasons, redactions) {
    const entry = { schema_version: 1, record: 'quarantined', session_id: header.session_id, seq: qLast.seq + 1, received_at: new Date().toISOString(), reasons, received };
    if (redactions.length) entry.redactions = redactions;
    const sealed = seal(entry, qLast.hash);
    fs.appendFileSync(qFile, line(sealed));
    qLast = sealed;
    counts.quarantined++;
    return { ok: false, quarantined: sealed.seq, reasons };
  }

  function append(input) {
    // Redact first, before anything is hashed or written, quarantined text included (lines 248, 340).
    let value;
    try {
      value = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
    } catch (e) {
      const r = redactText(typeof input === 'string' ? input : String(input), envValues);
      return quarantine(r.text, [`not JSON: ${e.message}`], r.kinds);
    }
    const { mark: m, kinds: redactions } = redactMark(value, envValues);
    const received = JSON.stringify(m);
    const reject = (reasons) => quarantine(received, reasons, redactions);
    if (!isObject(m)) return reject(['not a JSON object']);
    const reasons = [];
    for (const k of INTAKE_FIELDS) if (k in m) reasons.push(`the source sets ${k}, which intake assigns`);
    if (m.session_id !== header.session_id) reasons.push(`session_id ${JSON.stringify(m.session_id)} is not this session's`);
    if (reasons.length) return reject(reasons);
    for (const { ref } of refsOf(m)) {
      const k = keptKinds.get(ref);
      if (k) m.detail.redactions = [...new Set([...(m.detail.redactions || []), ...k])].sort();
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
    last = sealed;
    timed = sealed;
    counts.marks++;
    if (endsSession(sealed)) ended = true;
    if (pin === null) pin = pinOf(sealed);
    return { ok: true, seq: sealed.seq };
  }

  /** The raw log's last record: where an intake that restarts finds when it last wrote (test 84). */
  const lastRecord = () => ({ seq: timed.seq, mono_ns: timed.mono_ns, observed_at: timed.observed_at });

  return { append, keep, counts: () => ({ ...counts }), last: lastRecord, ended: () => ended, pin: () => pin };
}

/** Check a session folder: the ledger uses src/verify for checking (brief v3 line 618). */
const verifySessionLog = verifySession;

module.exports = { createSessionLog, openSessionLog, verifySessionLog };
