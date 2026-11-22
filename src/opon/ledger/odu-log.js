'use strict';

/**
 * src/opon/ledger/odu-log.js — the odù log (brief v4 lines 285-333; Phase 3
 * slice O1, LD167): one odù record per real event, hash-chained and
 * canonically serialised like the raw log (spec/hash-chain.md). The judge reads
 * only this log.
 *
 *   oduLog({ header, marks, groups }) -> { records, text }
 *     header  the raw log's sealed session header
 *     marks   the raw log's marks (for each odù's `witnesses`: the sources of
 *             the marks behind it)
 *     groups  the engine's group records in the order they sealed; only sealed
 *             ones are written (the closeout's force-settle is Phase 4)
 *
 * Line 1 is an `odu_header` (seq 0) naming the session and the raw log
 * header's hash, so the odù log is tied to the raw log it came from. Each odù
 * keeps its group's numbering (group g_0007 is odu_0007), so parents, children,
 * `amends` and `continues` name odùs. `witness_status` keeps each witness's
 * status, scope, own mark_seqs and, for `saw`, its verbs and each mark's key
 * detail slots; `ceiling` says the ceiling settled it (Q6, O's yes, LD174). `net_change` comes from
 * the group (station 4, slice N2), and only where the group has one;
 * `attribution` and `cause` from station 5 (slice A1b). Fields station 6
 * fills (confidence, conflicts) are left out until its slices: a field is
 * never written as a guess. Plain code, no clock.
 */

const { seal } = require('../../verify/chain');
const { canonicalize } = require('../../verify/canonical');

const oduId = (groupId) => (groupId === null || groupId === undefined ? null : `odu_${String(groupId).slice(2)}`);

function witnessEntry(w) {
  const e = { status: w.status, mark_seqs: Array.isArray(w.mark_seqs) ? [...w.mark_seqs] : [] };
  if (w.scope) e.scope = w.scope;
  if (w.status === 'saw') {
    e.says = [...w.says];
    e.slots = w.slots.map((s) => ({ ...s }));
  }
  return e;
}

function oduRecord(g, bySeq) {
  const witnesses = [...new Set(g.mark_seqs.map((s) => bySeq.get(s).source))].sort();
  return {
    schema_version: 1,
    record: 'odu',
    odu_id: oduId(g.group_id),
    session_id: g.session_id,
    parent_id: oduId(g.parent_id),
    children: g.children.map(oduId),
    amends: oduId(g.amends),
    continues: oduId(g.continues),
    ceiling: g.ceiling,
    state: g.state,
    target: g.target,
    action: g.action,
    window: { ...g.window },
    witnesses,
    witness_status: { glove: witnessEntry(g.witness_status.glove), sentinel: witnessEntry(g.witness_status.sentinel) },
    ...(g.net_change ? { net_change: { ...g.net_change } } : {}),
    cause: g.cause === null ? null : { ...g.cause, ...(g.cause.also ? { also: [...g.cause.also] } : {}) },
    attribution: g.attribution,
    lease: { checked: false, inside: null },
    mark_seqs: [...g.mark_seqs],
  };
}

function oduLog({ header, marks, groups }) {
  const bySeq = new Map(marks.map((m) => [m.seq, m]));
  let prev = seal({ schema_version: 1, record: 'odu_header', seq: 0, session_id: header.session_id, raw_header: header.hash }, null);
  const records = [prev];
  for (const g of groups) {
    if (g.state !== 'sealed') continue;
    prev = seal({ ...oduRecord(g, bySeq), seq: prev.seq + 1 }, prev.hash);
    records.push(prev);
  }
  return { records, text: records.map((r) => canonicalize(r) + '\n').join('') };
}

module.exports = { oduLog, oduId };
