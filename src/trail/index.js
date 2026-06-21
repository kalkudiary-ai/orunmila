'use strict';

/**
 * trail/index.js — session orchestrator for the complete-trail layer (the glove).
 *
 * Mirrors reconcile/index.js: it loads a session's events, folds in the
 * sentinel-observed disk writes that fall inside each turn's time window (so the
 * trail shows independently-observed touches, not just hook-announced ones), and
 * runs the lineage engine per turn. The output is a session-level trail model
 * that the unified renderer (render/html.js) consumes ALONGSIDE the orunmila
 * reconciliation reports — same events.jsonl, two lenses, one page.
 *
 * "The glove" is the user-facing name for this complete-trail lens (a feature of
 * orunmila, like the Filesystem Sentinel); `trail` is its name in code.
 */

const { readSession, readSentinelWrites, groupByTurn, TYPES } = require('../store/eventlog');
const { lineageForTurn } = require('./lineage');

/**
 * Sentinel-observed writes whose ts lands in this turn's hook-event window.
 * Identical correlation rule to reconcile/index.js#sentinelWritesForTurn — the
 * trail must see exactly what the reconciler sees so the two lenses agree.
 *
 * `allSentinel` is the whole log's sentinel writes, read ONCE by the caller and
 * filtered here in-memory. (It defaults to a fresh read so the function stays
 * usable standalone, but trailForSession passes the cached list to avoid an
 * O(turns²) re-parse of events.jsonl on a long session.)
 */
function sentinelWritesForTurn(hookEvents, allSentinel) {
  const pool = allSentinel || readSentinelWrites();
  const stamps = hookEvents.map((e) => e.ts).filter(Boolean).sort();
  if (!stamps.length) return [];
  const fromTs = stamps[0];
  const toTs = stamps[stamps.length - 1];
  return pool.filter((e) => e.ts && e.ts >= fromTs && e.ts <= toTs);
}

/** Build the full trail model (the glove) for a session. */
function trailForSession(sessionId) {
  const events = readSession(sessionId);
  const allSentinel = readSentinelWrites(); // one read, reused across every turn
  const byTurn = groupByTurn(events.filter((e) => e.turn_id)); // sentinel events (turn_id:null) folded per-turn below

  const turns = [];
  const sessionArtifacts = new Map(); // key -> aggregated artifact across the session

  for (const [turnId, hookEvents] of byTurn) {
    const sentinel = sentinelWritesForTurn(hookEvents, allSentinel);
    const turnEvents = hookEvents.concat(sentinel);
    const lineage = lineageForTurn(turnEvents);

    const promptEvent = hookEvents.find((e) => e.type === TYPES.USER_PROMPT);
    turns.push({
      turn_id: turnId,
      prompt: promptEvent ? promptEvent.text : '',
      ...lineage,
    });

    // Roll artifacts up to the session level for the file-grid overlay.
    for (const a of lineage.artifacts) {
      const cur = sessionArtifacts.get(a.key) || {
        key: a.key,
        label: a.label,
        path: a.path,
        channels: new Set(),
        touch_count: 0,
        touched_by: new Set(),
        sub_agents: new Set(),
        turns: new Set(),
        any_failed: false,
      };
      cur.touch_count += a.touch_count;
      a.channels.forEach((c) => cur.channels.add(c));
      a.touched_by.forEach((t) => cur.touched_by.add(t));
      (a.sub_agents || []).forEach((s) => cur.sub_agents.add(s));
      cur.turns.add(turnId);
      if (a.any_failed) cur.any_failed = true;
      sessionArtifacts.set(a.key, cur);
    }
  }

  const artifacts = [...sessionArtifacts.values()].map((a) => ({
    key: a.key,
    label: a.label,
    path: a.path,
    channels: [...a.channels],
    touch_count: a.touch_count,
    touched_by: [...a.touched_by],
    sub_agents: [...a.sub_agents],
    turn_count: a.turns.size,
    any_failed: a.any_failed,
  }));

  return {
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    turns,
    artifacts,
    totals: {
      turns: turns.length,
      artifacts: artifacts.length,
      touches: artifacts.reduce((n, a) => n + a.touch_count, 0),
    },
  };
}

module.exports = { trailForSession, sentinelWritesForTurn };
