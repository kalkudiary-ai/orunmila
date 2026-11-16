'use strict';

/**
 * src/opon/intake/adapters/law-gate.js — the law gate's turn checks as
 * `checked` marks, source `law_gate` (brief v3 lines 199, 242, 575; Phase 1
 * slice A8; test 61; NF16: today the gate keeps a per-turn file, rewritten in
 * place, with no quoted text).
 *
 *   translateCheck({ sessionId, agent, turn, observedAt, check })
 *     -> { mark, rejects: [] } or { mark: null, rejects: [{ reason }] }
 *
 * `check` is the gate's own decision, not its rendered text:
 *   { skipped: '<why>' }                         result skipped
 *   { findings: [] }                             result passed
 *   { findings, blocked: true }                  result blocked
 *   { findings, blocked: false, exhausted? }     result warned; a blocking
 *                                                finding the budget no longer
 *                                                lets block is noted
 *                                                budget_exhausted, never silent
 * `findings` are evaluateTurn's ({ law_id, severity, evidence: { text } }).
 * A pure translator; the quoted text is redacted by intake like any mark.
 */

function translateCheck({ sessionId, agent = null, turn, observedAt, check }) {
  const reject = (reason) => ({ mark: null, rejects: [{ reason }] });
  if (!turn) return reject('a law-gate check names its turn (line 255); none given');
  if (!check || typeof check !== 'object') return reject('no check given');
  const detail = {};
  if (typeof check.skipped === 'string') {
    Object.assign(detail, { result: 'skipped', reason: check.skipped, findings: [] });
  } else if (Array.isArray(check.findings)) {
    detail.findings = check.findings.map((f) => ({
      law: f.law_id,
      severity: f.severity,
      quote: f.evidence && typeof f.evidence.text === 'string' ? f.evidence.text : null,
    }));
    if (check.blocked) {
      if (!check.findings.some((f) => f.severity === 'block')) return reject('blocked with no blocking finding');
      detail.result = 'blocked';
    } else {
      detail.result = check.findings.length ? 'warned' : 'passed';
      if (check.exhausted) detail.budget_exhausted = true;
    }
  } else {
    return reject('the check is none of skipped, passed, warned or blocked');
  }
  return {
    mark: {
      schema_version: 1,
      session_id: sessionId,
      source: 'law_gate',
      agent,
      turn,
      sub_agent: null,
      observed_at: observedAt,
      target: { kind: 'turn', id: turn },
      says: 'checked',
      detail,
      cause_hint: null,
    },
    rejects: [],
  };
}

module.exports = { translateCheck };
