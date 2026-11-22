'use strict';

/**
 * src/opon/group/keys.js — which group a mark joins (station 3, brief v4 lines
 * 372-379; Phase 2 slice R1, first form; grouping proper is slices G1-G2).
 *
 *   keyOf(mark) -> the group key
 *
 * A file or folder is keyed by its normalised path (intake normalised it,
 * line 345), so a read of a file joins that file's group, both witnesses'
 * marks join one group, and the tool call that changed it too. A command, a
 * tool call or a network contact is keyed by its kind and its tool call id
 * (`cause_hint`), because two runs of one command are two events; with no id
 * the mark stands alone. Turn marks (a prompt, the closing claim, the turn's
 * end) group by the turn. The session's end groups by the session. Anything
 * else (a gap, a tampering mark, the intake's own note) is its own group.
 * Ticks never reach here: they are the clock, not an event.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function keyOf(m) {
  const t = isObject(m.target) ? m.target : null;
  const alone = `seq:${m.seq}`;
  if (!t) return alone;
  if ((t.kind === 'file' || t.kind === 'dir') && typeof t.path === 'string') return `${t.kind}:${t.path}`;
  if (t.kind === 'command' || t.kind === 'tool' || t.kind === 'network') return m.cause_hint ? `${t.kind}:${m.cause_hint}` : alone;
  if (t.kind === 'turn' || t.kind === 'claim') return m.turn ? `turn:${m.turn}` : t.id ? `turn:${t.id}` : alone;
  if (t.kind === 'session' && t.id) return `session:${t.id}`;
  return alone;
}

module.exports = { keyOf };
