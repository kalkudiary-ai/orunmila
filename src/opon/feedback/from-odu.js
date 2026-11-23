'use strict';

/**
 * src/opon/feedback/from-odu.js — the agent's closeout feedback read from the odù log (brief v4 line 614;
 * lines 644, 691; Phase 4 slice K6, LD218). Plain code, no clock, no fs.
 *
 *   feedbackFromOdu({ sessionId, agent, oduText, turn?, redactOpts? }) -> payload
 *     The same shape as `orunmila json` (src/render/json.js, schema 1.0), built from the odù log alone:
 *     a `phantom_claim` odù is a claim entry of its turn (`phantom` for a file claim,
 *     `phantom_verification` for a command claim), its `verdict_confidence` the odù's confidence and its
 *     evidence the odù's id, mark_seqs and `why`; a `silent_change` is an undisclosed change of each turn
 *     it names. Added: `source: "odu_log"`, and `findings`, the conflicts the old path has no word for
 *     (missed_live, unconfirmed_by_filesystem, outcome_missing, contradiction, concurrent_sessions), each
 *     with its odù's id, target, confidence and mark_seqs. The odù log records no backed claim and no
 *     prompt's subtasks, so verified, partial, unverifiable and silently_dropped count 0 here.
 *
 *   sideBySide(old, odu) -> rows
 *     Per turn, in turn order: the phantom claims' counts by outcome (`phantom`, `phantom_verification`)
 *     and each undisclosed path, with `in`: both, old or odu (a count row is `both` when the counts agree).
 */

const { buildRedactor } = require('../../render/redact');

const OUTCOMES = ['verified', 'partial', 'phantom', 'phantom_verification', 'unverifiable', 'undisclosed', 'silently_dropped'];
const FINDINGS = new Set(['missed_live', 'unconfirmed_by_filesystem', 'outcome_missing', 'contradiction', 'concurrent_sessions']);
const byTurn = (a, b) => (a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)); // t2 before t10

function feedbackFromOdu({ sessionId, agent = null, oduText, turn = null, redactOpts = {} }) {
  const R = buildRedactor(redactOpts);
  const odus = oduText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.record === 'odu');
  const turns = new Map();
  const of = (t) => {
    if (!turns.has(t)) turns.set(t, { session_id: sessionId, turn: t, claims: [], undisclosed_changes: [], silently_dropped: [] });
    return turns.get(t);
  };
  const findings = [];
  const where = (o) => (o.target && typeof o.target.path === 'string' ? R.path(o.target.path) : o.target ? o.target.kind : null);
  for (const o of odus) {
    for (const c of o.conflicts) {
      if (c.kind === 'phantom_claim' && o.target && o.target.turn) {
        of(o.target.turn).claims.push({ id: o.odu_id, outcome: c.claim === 'file' ? 'phantom' : 'phantom_verification', verdict_confidence: o.confidence, evidence: { odu_id: o.odu_id, mark_seqs: [...o.mark_seqs], why: c.why, ...(c.claim === 'file' ? { path: R.path(c.path) } : { phrases: [...c.phrases] }) } });
      } else if (c.kind === 'silent_change') {
        for (const t of c.turns) of(t).undisclosed_changes.push({ ref: R.path(o.target.path), odu_id: o.odu_id });
      } else if (FINDINGS.has(c.kind)) {
        findings.push({ kind: c.kind, odu_id: o.odu_id, target: where(o), confidence: o.confidence, mark_seqs: [...o.mark_seqs] });
      }
    }
  }
  const list = [...turns.values()].filter((t) => turn === null || t.turn === turn).sort((a, b) => byTurn(a.turn, b.turn));
  const summary = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
  for (const t of list) {
    t.summary = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
    for (const c of t.claims) t.summary[c.outcome]++;
    t.summary.undisclosed = t.undisclosed_changes.length;
    for (const k of OUTCOMES) summary[k] += t.summary[k];
  }
  return { schema_version: '1.0', source: 'odu_log', session_id: sessionId, agent, generated_at: null, included_fields: [], turns: list, summary, findings };
}

function sideBySide(old, odu) {
  const index = (p) => new Map((p.turns || []).map((t) => [t.turn, t]));
  const [a, b] = [index(old), index(odu)];
  const rows = [];
  for (const t of [...new Set([...a.keys(), ...b.keys()])].sort(byTurn)) {
    const [x, y] = [a.get(t), b.get(t)];
    for (const kind of ['phantom', 'phantom_verification']) {
      const n = (s) => (s ? (s.claims || []).filter((c) => c.outcome === kind).length : 0);
      if (n(x) || n(y)) rows.push({ turn: t, kind, old: n(x), odu: n(y), in: n(x) === n(y) ? 'both' : n(x) > n(y) ? 'old' : 'odu' });
    }
    const refs = (s) => new Set(s ? (s.undisclosed_changes || []).map((u) => u.ref) : []);
    const [rx, ry] = [refs(x), refs(y)];
    for (const ref of [...new Set([...rx, ...ry])].sort()) rows.push({ turn: t, kind: 'undisclosed', ref, in: rx.has(ref) && ry.has(ref) ? 'both' : rx.has(ref) ? 'old' : 'odu' });
  }
  return rows;
}

module.exports = { feedbackFromOdu, sideBySide };
