// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/ledger/updates.js — the update log (Phase 6 slice PM2a; Q44 (a), approved by O 2026-11-25, LD299; LD329).
 * Orunmila switches itself to a newer version only while no session is held (PM2, Phase 5 plan section 6), so no
 * session's record sees its code change; each switch, and each update it refused (a failed self-check), is written to
 * `updates.jsonl` in Orunmila's home, beside the sessions: a hash-chained log of its own, like the retention log, so an
 * update can never look like code that was always there. `orunmila verify --updates` checks it.
 *
 *   updatesFile(home)              <home>/updates.jsonl
 *   readUpdatesLog(home) -> { ok, exists, records, updates, words }
 *                                  the chain (spec/hash-chain.md) checked, then every record against its schema
 *                                  (spec/updates-header.schema.json, spec/update.schema.json); the first line that
 *                                  breaks either is named. No log yet is ok, `exists: false`.
 *   recordUpdate(home, { from, to, integrity, self_check, switched }, at) -> { ok: true, seq } | { ok: false, reason }
 *                                  the record is checked against its schema before anything is written (a refusal
 *                                  names the field); the first update makes the log, its header first; a broken log
 *                                  is never extended (throws). Owner-only, like the other logs.
 *
 * Limits: a crash that cuts the last line leaves the log broken, and updates are then refused until someone looks, as
 * the retention log does.
 */

const fs = require('fs');
const path = require('path');
const { seal, verifyText } = require('../../verify/chain');
const { canonicalize } = require('../../verify/canonical');
const { compile } = require('../../verify/schema');

const SPEC = path.join(__dirname, '..', '..', '..', 'spec');
let checks = null;
function schemas() {
  if (!checks) {
    const load = (f) => compile(JSON.parse(fs.readFileSync(path.join(SPEC, f), 'utf8')));
    checks = { updates_header: load('updates-header.schema.json'), update: load('update.schema.json') };
  }
  return checks;
}
const firstError = (errors) => `${errors[0].path || '/'} (${errors[0].keyword})`;
const line = (rec) => canonicalize(rec) + '\n';

const updatesFile = (home) => path.join(home, 'updates.jsonl');

function readUpdatesLog(home) {
  let text;
  try {
    text = fs.readFileSync(updatesFile(home), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, exists: false, records: [], updates: [], words: 'no update log yet' };
    throw e;
  }
  const v = verifyText(text);
  const records = text
    .split('\n')
    .slice(0, v.ok ? v.lines : v.checked)
    .map((l) => JSON.parse(l));
  const broken = (words) => ({ ok: false, exists: true, records, updates: [], words });
  if (!v.ok) return broken(`the update log is broken at line ${v.line}: ${v.reason}`);
  const s = schemas();
  for (const [i, r] of records.entries()) {
    const want = i === 0 ? 'updates_header' : 'update';
    const errors = s[want](r);
    if (errors.length) return broken(`line ${i + 1} of the update log is not ${i === 0 ? 'its header' : 'an update record'}: ${firstError(errors)}`);
  }
  return { ok: true, exists: true, records, updates: records.slice(1), words: `${records.length - 1} update(s), unbroken` };
}

function recordUpdate(home, u, at = new Date().toISOString()) {
  const log = readUpdatesLog(home);
  if (!log.ok) throw new Error(`the update log ${updatesFile(home)} is broken, so nothing is written: ${log.words}`);
  const created = !log.exists;
  const head = created ? seal({ schema_version: 1, record: 'updates_header', seq: 0, created_at: at }, null) : log.records[log.records.length - 1];
  const rec = seal({ schema_version: 1, record: 'update', seq: head.seq + 1, at, from: u.from, to: u.to, integrity: u.integrity, self_check: u.self_check, switched: u.switched }, head.hash);
  const s = schemas();
  const errors = [...(created ? s.updates_header(head) : []), ...s.update(rec)];
  if (errors.length) return { ok: false, reason: `the update record does not fit its schema, so nothing is written: ${firstError(errors)}` };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (created) fs.writeFileSync(updatesFile(home), line(head) + line(rec), { flag: 'wx', mode: 0o600 });
  else fs.appendFileSync(updatesFile(home), line(rec));
  return { ok: true, seq: rec.seq };
}

module.exports = { updatesFile, readUpdatesLog, recordUpdate };
