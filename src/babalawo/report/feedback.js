'use strict';

/**
 * src/babalawo/report/feedback.js — the agent's feedback from the verdicts (brief v4 lines 614, 691; Phase 6 slice BB9,
 * LD273). The agent's loop reads `orunmila json` in its 1.0 shape (skills/agent-review-workflow, step 2); this keeps
 * that shape, built from the odù log as K6 built it (src/opon/feedback/from-odu.js), and adds what the judge decided:
 *   source "verdict_log"; on each phantom claim its `verdict` (the latest verdict on its odù); `session_verdict` and
 *   `top_line` as the report gives them; `judged_now` when the session has no verdict log; the law gate's counts; and
 *   `verdicts`, the report's findings, each with its verdict, rule, odù and one sentence naming both witnesses.
 * Paths and sentences go through the same redactor as the rest of the payload. Plain code, no file system.
 */

const { feedbackFromOdu } = require('../../opon/feedback/from-odu');
const { buildRedactor } = require('../../render/redact');
const { buildReport } = require('./index');

const parse = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

function feedbackFromVerdicts({ sessionId, agent = null, header, marks, oduText, verdictText, judgedNow = false, quarantined = 0, turn = null, include = [], generatedAt = null, redactOpts = {} }) {
  const R = buildRedactor(redactOpts);
  const payload = feedbackFromOdu({ sessionId, agent, oduText, turn, include, generatedAt, redactOpts });
  const verdicts = parse(verdictText);
  const latest = new Map(verdicts.filter((v) => v.record === 'verdict').map((v) => [v.odu_id, v]));
  for (const t of payload.turns) for (const c of t.claims) if (latest.has(c.evidence.odu_id)) c.verdict = latest.get(c.evidence.odu_id).verdict;
  const rep = buildReport({ header, marks, odus: parse(oduText), verdicts, quarantined, judgedNow });
  return {
    ...payload,
    source: 'verdict_log',
    session_verdict: rep.verdict,
    top_line: rep.top_line,
    judged_now: judgedNow,
    law_gate: rep.law_gate,
    verdicts: rep.findings.map((f) => ({ verdict: f.verdict, rule: f.rule || null, kind: f.kind, odu_id: f.odu_id || null, target: R.text(String(f.target)), sentence: R.text(f.sentence) })),
  };
}

module.exports = { feedbackFromVerdicts };
