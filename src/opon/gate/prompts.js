'use strict';

/**
 * src/opon/gate/prompts.js — a turn's prompts, from the prompt marks the Glove
 * delivered in that turn and nothing else (open question 2, decided by O
 * 2026-11-16: brief v4 line 275; review/phase1-design.md section 2; NF38,
 * NF54; Phase 1 slice B9b, pure part; LD68). Not wired: today's Stop hook
 * still fills a missing prompt in from the transcript (src/capture/core.js),
 * which hooks load, so it goes when capture is rewired after the 0.2.3 cut.
 *
 *   promptsOf(marks, turn) -> { prompts: [{ text, from_human }], continuation,
 *                               refillsBudget }
 *
 * A prompt counts for `turn` only when its mark is the Glove's (source
 * `hook`), says `prompted`, names that turn and targets it. Nothing is ever
 * borrowed from another turn or the transcript: a turn with no such mark is a
 * continuation, and the report and the gate say "no prompt in this turn". A
 * prompt Claude Code wrote itself (`from_human: false`, NF54) is listed but
 * does not refill the law gate's block budget; any prompt from a human does.
 * Every prompt delivered in the turn is listed, in the order given (a message
 * sent mid-turn is one, NF38). A prompt lost while the intake was down is
 * covered by that downtime's `gap`, not here.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function promptsOf(marks, turn) {
  const prompts = marks
    .filter((m) => isObject(m) && m.source === 'hook' && m.says === 'prompted' && m.turn === turn && isObject(m.target) && m.target.kind === 'turn' && m.target.id === turn)
    .map((m) => {
      const d = isObject(m.detail) ? m.detail : {};
      return { text: typeof d.prompt === 'string' ? d.prompt : '', from_human: d.from_human !== false };
    });
  return { prompts, continuation: prompts.length === 0, refillsBudget: prompts.some((p) => p.from_human) };
}

module.exports = { promptsOf };
