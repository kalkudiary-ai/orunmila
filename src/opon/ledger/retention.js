'use strict';

/**
 * src/opon/ledger/retention.js — retention replaces `prune` (brief v4 line
 * 343; test 45; N4, NF7; Phase 1 slice B6, pure part; LD66). Not wired.
 *
 * Old sessions are removed only whole: the session's folder (its raw and
 * quarantine logs, every part, and the files kept beside them) goes as one.
 * Each removal is written first to a hash-chained retention log, so a removal
 * can never look like a session that never existed. Nothing inside a session
 * is ever edited.
 *
 *   plan({ sessionsDir, keepDays, now })
 *       the session folders, sorted, whose last timed record (observed_at) is
 *       older than keepDays before `now` (an ISO time; the caller's clock).
 *   retire({ sessionsDir, id, logFile, reason, now, remove })
 *       removes one session: its folder must verify (src/verify/session.js),
 *       or nothing happens, since removing a broken record would hide the
 *       break. The `removed` record (id, the header's hash, each log's last
 *       seq and hash, counts, time, reason) is appended before the folder is
 *       touched. If removal is cut short, the next call for that id finishes
 *       it with no second record, but only for the session recorded: the
 *       folder's header line must hash as the record says, or the folder
 *       must hold no raw log any more. -> { ok: true, seq [, finished] }, or
 *       { ok: false, reason }. Throws on an unsafe id (NF3) or a broken log.
 *   readRetentionLog(file)
 *       { ok, exists, records, removed, words }: the chain (spec/hash-chain.md:
 *       a `retention_header` at seq 0, then `removed` records) checked.
 *
 * Limits: a crash that cuts the retention log's last line leaves it broken, and
 * retention stops until someone looks (it is never extended past a break). The
 * record shape is not yet in spec/ (LD66).
 */

const fs = require('fs');
const path = require('path');
const { seal, hashRecord, verifyText } = require('../../verify/chain');
const { canonicalize } = require('../../verify/canonical');
const { verifySession, checkLog } = require('../../verify/session');
const { sessionFolderName } = require('../intake/paths');

const DAY_MS = 24 * 60 * 60 * 1000;
const line = (rec) => canonicalize(rec) + '\n';
const removeTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function readRetentionLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, exists: false, records: [], removed: [], words: 'no retention log yet' };
    throw e;
  }
  const v = verifyText(text);
  const records = text
    .split('\n')
    .slice(0, v.ok ? v.lines : v.checked)
    .map((l) => JSON.parse(l));
  const broken = (words) => ({ ok: false, exists: true, records, removed: [], words });
  if (!v.ok) return broken(`the retention log is broken at line ${v.line}: ${v.reason}`);
  if (records[0].record !== 'retention_header') return broken('line 1 of the retention log is not its header');
  const bad = records.findIndex((r, i) => i > 0 && (r.record !== 'removed' || typeof r.session_id !== 'string'));
  if (bad !== -1) return broken(`line ${bad + 1} of the retention log is not a removal record`);
  return { ok: true, exists: true, records, removed: records.slice(1), words: `${records.length - 1} removal(s), unbroken` };
}

/** The last record of one of a session's logs, across its parts: { seq, hash }. */
function headOf(dir, name) {
  const recs = checkLog(dir, name).records;
  const last = recs[recs.length - 1].rec;
  return { seq: last.seq, hash: last.hash };
}

/** The hash of the session's header line as it stands, or null when there is no readable raw log. */
function headerHash(dir) {
  try {
    const first = fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[0];
    return hashRecord(JSON.parse(first));
  } catch {
    return null;
  }
}

function retire({ sessionsDir, id, logFile, reason, now = new Date().toISOString(), remove = removeTree }) {
  const dir = path.join(sessionsDir, sessionFolderName(id));
  const log = readRetentionLog(logFile);
  if (!log.ok) throw new Error(`the retention log ${logFile} is broken, so nothing is removed: ${log.words}`);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    // no folder
  }
  if (st === null) return { ok: false, reason: `no session folder for ${id}` };
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `the session folder for ${id} is a symbolic link or not a folder: nothing is removed` };

  // A removal cut short: finish it, with no second record, only for the session recorded.
  const hh = headerHash(dir);
  const prior = log.removed.find((r) => r.session_id === id && (hh === null || r.header === hh));
  if (prior && (hh === null || !verifySession(dir).ok || headOf(dir, 'raw').hash === prior.raw.hash)) {
    remove(dir);
    return { ok: true, seq: prior.seq, finished: true };
  }

  const v = verifySession(dir);
  if (!v.ok) return { ok: false, reason: `${v.words} The session is kept: removing a broken record would hide the break.` };

  const last = log.records[log.records.length - 1];
  const created = !log.exists;
  const head = created ? seal({ schema_version: 1, record: 'retention_header', seq: 0, created_at: now }, null) : last;
  const rec = seal(
    {
      schema_version: 1,
      record: 'removed',
      seq: head.seq + 1,
      session_id: id,
      removed_at: now,
      reason: String(reason),
      header: hh,
      raw: headOf(dir, 'raw'),
      quarantine: headOf(dir, 'quarantine'),
      counts: v.counts,
    },
    head.hash,
  );
  if (created) fs.writeFileSync(logFile, line(head) + line(rec), { flag: 'wx', mode: 0o600 });
  else fs.appendFileSync(logFile, line(rec));
  remove(dir); // only after the record is written
  return { ok: true, seq: rec.seq };
}

function plan({ sessionsDir, keepDays, now }) {
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error(`keepDays must be a whole number of days, at least 1 (got ${JSON.stringify(keepDays)})`);
  const cutoff = Date.parse(now) - keepDays * DAY_MS;
  if (!Number.isFinite(cutoff)) throw new Error(`now must be an ISO time (got ${JSON.stringify(now)})`);
  const out = [];
  for (const ent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue; // a symbolic link is never a session folder here
    try {
      sessionFolderName(ent.name);
    } catch {
      continue;
    }
    const timed = checkLog(path.join(sessionsDir, ent.name), 'raw')
      .records.filter((r) => !(r.part > 1 && r.line === 1))
      .map((r) => r.rec);
    if (!timed.length) continue; // no raw log: not a session folder
    const at = Date.parse(timed[timed.length - 1].observed_at);
    if (at < cutoff) out.push(ent.name);
  }
  return out.sort();
}

module.exports = { plan, retire, readRetentionLog };
