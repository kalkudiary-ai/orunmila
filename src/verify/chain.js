// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/verify/chain.js — the hash chain, exactly as spec/hash-chain.md states it
 * (brief v3 line 247). No dependencies beyond Node's crypto.
 *
 *   hashRecord(record)        "sha256:<hex>" of the RFC 8785 bytes of the
 *                             record without its `hash` member
 *   seal(record, prevHash)    the record with `prev_hash` and `hash` set
 *   verifyText(text, start?)  { ok: true, lines } or
 *                             { ok: false, line, reason, checked, cut? };
 *                             start ({ prevHash, seq }, default null and 0) is
 *                             what the first line must follow: a later part of
 *                             a log continues the chain (LD57). cut is true
 *                             when the failing line is a last line with no
 *                             line feed, as a crash leaves it.
 *
 * `reason` is the first rule line `line` breaks, in the spec's order:
 * "not canonical", "changed", "does not follow", "out of sequence"; or
 * "missing" for an empty log. `checked` counts the lines before it that held.
 */

const crypto = require('crypto');
const { canonicalize, canonicalBytes } = require('./canonical');

function hashRecord(record) {
  const body = { ...record };
  delete body.hash;
  return 'sha256:' + crypto.createHash('sha256').update(canonicalBytes(body)).digest('hex');
}

function seal(record, prevHash) {
  const out = { ...record, prev_hash: prevHash };
  delete out.hash;
  out.hash = hashRecord(out);
  return out;
}

/** The record a line holds, or null when the line is not one record's canonical text. */
function readLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
    return canonicalize(rec) === line ? rec : null;
  } catch {
    return null;
  }
}

function verifyText(text, start = { prevHash: null, seq: 0 }) {
  if (text === '') return { ok: false, line: 1, reason: 'missing', checked: 0 };
  const parts = text.split('\n');
  const terminated = parts[parts.length - 1] === '';
  const lines = terminated ? parts.slice(0, -1) : parts;
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const last = i === lines.length - 1;
    // A last line with no line feed is cut short, as a crash leaves it (a log in parts, LD57).
    const fail = (reason) => ({ ok: false, line: i + 1, reason, checked: i, ...(!terminated && last ? { cut: true } : {}) });
    const rec = !terminated && last ? null : readLine(lines[i]);
    if (!rec) return fail('not canonical');
    if (typeof rec.hash !== 'string' || hashRecord(rec) !== rec.hash) return fail('changed');
    if (rec.prev_hash !== (i === 0 ? start.prevHash : prev.hash)) return fail('does not follow');
    if (rec.seq !== (i === 0 ? start.seq : prev.seq + 1)) return fail('out of sequence');
    prev = rec;
  }
  return { ok: true, lines: lines.length };
}

/**
 * LR2b (LD252): verifyText over a Buffer, a line at a time, so no string of the whole log is ever made (V8's longest
 * string is about 512 MB, which a long session's raw log can pass). The same lines (0x0a never occurs inside a UTF-8
 * character), the same rules and the same answers, plus `records`: the records of the lines that held.
 */
function verifyBuffer(buf, start = { prevHash: null, seq: 0 }) {
  const records = [];
  if (buf.length === 0) return { ok: false, line: 1, reason: 'missing', checked: 0, records };
  let prev = null;
  let from = 0;
  for (let i = 0; ; i++) {
    const nl = buf.indexOf(0x0a, from);
    // A last line with no line feed is cut short, as a crash leaves it (a log in parts, LD57).
    const fail = (reason) => ({ ok: false, line: i + 1, reason, checked: i, records, ...(nl === -1 ? { cut: true } : {}) });
    const rec = nl === -1 ? null : readLine(buf.toString('utf8', from, nl));
    if (!rec) return fail('not canonical');
    if (typeof rec.hash !== 'string' || hashRecord(rec) !== rec.hash) return fail('changed');
    if (rec.prev_hash !== (i === 0 ? start.prevHash : prev.hash)) return fail('does not follow');
    if (rec.seq !== (i === 0 ? start.seq : prev.seq + 1)) return fail('out of sequence');
    records.push(rec);
    prev = rec;
    from = nl + 1;
    if (from === buf.length) return { ok: true, lines: i + 1, records };
  }
}

module.exports = { hashRecord, seal, verifyText, verifyBuffer };
