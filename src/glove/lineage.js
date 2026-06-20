'use strict';

/**
 * lineage.js — "the dye"
 *
 * orunmila's reconciler is SKEPTICAL: it stains only the mismatches between what
 * the agent claimed and what the evidence shows. The glove is the inverse lens
 * on the same event log: it stains EVERYTHING the agent touched and trails it.
 * Where orunmila answers "was the narrative honest", the glove answers "what,
 * exactly and completely, did it do" — one global truth from one events.jsonl.
 *
 * This module is the lineage (taint) engine. Given one turn's events it builds:
 *   - an artifact-centric trail: per file/command/network target, the full
 *     ordered list of touches (read/write/command/network) that hit it.
 *   - turn-scoped lineage edges: every WRITE / COMMAND / NETWORK in the turn is
 *     marked `touched_by` the set of FILE READS (and prior command runs) earlier
 *     in the same turn — the dye spreading on contact.
 *
 * HONESTY (same contract as the sentinel's time-window correlation): the
 * read->write edge is a TURN-SCOPED HEURISTIC, not proven data-flow. If the
 * agent read A and wrote B in the same turn for unrelated reasons, B will still
 * show `touched_by A`. That one false-edge mode is surfaced in the render
 * ("inferred, not proven"), never hidden. v0 is deliberately coarse-but-free —
 * no content-level taint, no NLP, no API calls.
 */

const { basename } = require('../reconcile/task-extractor');

// Event types we treat as "the dye lands here" (a sink that inherits taint).
const SINK_TYPES = new Set(['file_write', 'command_run', 'network_call']);
// Event types we treat as a provenance SOURCE (the dye originates here).
const SOURCE_TYPES = new Set(['file_read', 'command_run']);
// Bookkeeping events that bracket a turn but aren't a TOUCH of anything — they
// must never show up as artifacts/nodes in the trail or they drown the real map.
const BOOKKEEPING_TYPES = new Set(['user_prompt', 'turn_claim', 'turn_end', 'session_end']);

function isTouch(e) {
  return !BOOKKEEPING_TYPES.has(e.type);
}

function diffVolume(diff) {
  if (!diff) return 0;
  return diff
    .split('\n')
    .filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .length;
}

// A stable, human-meaningful key for grouping touches into one artifact.
function artifactKey(e) {
  if (e.path || e.rel_path) return e.rel_path || e.path;
  if (e.type === 'network_call') return e.host || e.target || `network:${e.tool_name || 'unknown'}`;
  if (e.type === 'command_run') return `cmd:${(e.command || '').split(/\s+/)[0] || 'command'}`;
  if (e.tool_name) return `tool:${e.tool_name}`;
  return `event:${e.type}`;
}

function channelOf(e) {
  if (e.channel) return e.channel;
  if (e.type === 'network_call') return 'network';
  if (e.type === 'command_run') return 'command';
  if (e.type === 'file_read') return 'read';
  if (e.type === 'file_write') return e.source === 'fs-sentinel' ? 'disk' : 'write';
  return 'tool';
}

/**
 * Build the lineage model for a single turn.
 *
 * @param {Array<object>} turnEvents  every event in the turn, INCLUDING any
 *   sentinel-observed writes already folded in by the caller (the glove must
 *   show independently-observed disk touches too, not just hook-announced ones).
 * @returns {{ artifacts: object[], edges: object[], trail: object[] }}
 */
function lineageForTurn(turnEvents) {
  // Order matters: the dye only spreads forward (a write can only inherit from a
  // read that already happened). Stable sort by timestamp, falling back to input
  // order for events sharing a ts. Bookkeeping events are dropped first so they
  // never become spurious nodes on the map.
  const ordered = turnEvents
    .filter(isTouch)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = a.e.ts || '';
      const tb = b.e.ts || '';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a.i - b.i;
    })
    .map((x) => x.e);

  const sourcesSoFar = []; // [{ key, path, hash, type, ts }] seen earlier this turn
  const edges = [];        // { from (source key), to (sink key), kind, inferred:true }
  const trail = [];        // chronological, one entry per event — the "everything documented" stream

  for (const e of ordered) {
    const key = artifactKey(e);
    const channel = channelOf(e);

    const trailEntry = {
      key,
      type: e.type,
      channel,
      ts: e.ts || null,
      source: e.source || 'hook',
      failed: e.failed === true,
      call_id: e.call_id || null,
    };
    if (e.path || e.rel_path) trailEntry.path = e.rel_path || e.path;
    if (e.command) trailEntry.command = e.command;
    if (e.host) trailEntry.host = e.host;
    if (e.target) trailEntry.target = e.target;
    if (e.hash) trailEntry.hash = e.hash;
    if (typeof e.bytes === 'number') trailEntry.bytes = e.bytes;
    if (e.output_path) trailEntry.output_path = e.output_path;
    if (e.diff) trailEntry.diff_volume = diffVolume(e.diff);
    if (typeof e.exit_code === 'number') trailEntry.exit_code = e.exit_code;
    trail.push(trailEntry);

    // Sinks inherit taint from every source seen earlier in this turn.
    if (SINK_TYPES.has(e.type) && sourcesSoFar.length) {
      for (const src of sourcesSoFar) {
        if (src.key === key) continue; // a command reading its own prior write isn't a meaningful edge
        edges.push({
          from: src.key,
          to: key,
          from_hash: src.hash || null,
          kind: `${src.type}->${e.type}`,
          inferred: true, // turn-scoped heuristic, never asserted as proven flow
          ts: e.ts || null,
        });
      }
    }

    // After processing, a read (or a command run) becomes a source for later sinks.
    if (SOURCE_TYPES.has(e.type)) {
      sourcesSoFar.push({ key, path: e.path || null, hash: e.hash || null, type: e.type, ts: e.ts || null });
    }
  }

  // Collapse the trail into artifact-centric records: every distinct thing the
  // turn touched, with its ordered touches and inherited lineage.
  const artifacts = new Map();
  for (const t of trail) {
    if (!artifacts.has(t.key)) {
      artifacts.set(t.key, {
        key: t.key,
        label: t.path ? basename(t.path) : t.key,
        path: t.path || null,
        channels: new Set(),
        touches: [],
        touched_by: new Set(),
        touched: new Set(),
        any_failed: false,
      });
    }
    const a = artifacts.get(t.key);
    a.channels.add(t.channel);
    a.touches.push(t);
    if (t.failed) a.any_failed = true;
  }
  for (const edge of edges) {
    if (artifacts.has(edge.to)) artifacts.get(edge.to).touched_by.add(edge.from);
    if (artifacts.has(edge.from)) artifacts.get(edge.from).touched.add(edge.to);
  }

  const artifactList = [...artifacts.values()].map((a) => ({
    key: a.key,
    label: a.label,
    path: a.path,
    channels: [...a.channels],
    touch_count: a.touches.length,
    touches: a.touches,
    touched_by: [...a.touched_by], // what this artifact inherited the stain from
    touched: [...a.touched],       // what inherited the stain from this artifact
    any_failed: a.any_failed,
  }));

  return { artifacts: artifactList, edges, trail };
}

module.exports = { lineageForTurn, artifactKey, channelOf, isTouch, SINK_TYPES, SOURCE_TYPES, BOOKKEEPING_TYPES };
