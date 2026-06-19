'use strict';

const fs = require('fs');
const path = require('path');
const { readTurn, readBetween, dataDir, TYPES } = require('../store/eventlog');
const { reconcileTurn } = require('./matcher');

/**
 * Time-window correlation for the Filesystem Sentinel (PRD 6.4 / SENTINEL §5).
 * Sentinel events carry turn_id:null because that separate process can't see
 * Claude Code's turn ids. So we bucket them by TIMESTAMP: a sentinel write
 * belongs to this turn if its ts falls in [first hook event ts, last hook event
 * ts] for the turn. The honest failure mode (a write right on a turn boundary
 * landing in the neighbouring turn) is visible, not silent — documented here so
 * the heuristic is the most transparent part, not the least.
 */
function sentinelWritesForTurn(hookEvents) {
  const stamps = hookEvents.map((e) => e.ts).filter(Boolean).sort();
  if (!stamps.length) return [];
  const fromTs = stamps[0];
  const toTs = stamps[stamps.length - 1];
  return readBetween(fromTs, toTs).filter(
    (e) => e.source === 'fs-sentinel' && e.type === TYPES.FILE_WRITE
  );
}

function reportPath(sessionId, turnId) {
  const dir = path.join(dataDir(), 'reports', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${turnId}.json`);
}

function reconcileAndPersist(sessionId, turnId) {
  const events = readTurn(sessionId, turnId);
  const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
  const claimEvent = events.find((e) => e.type === TYPES.TURN_CLAIM);

  // Fold in any sentinel-observed writes whose timestamp lands in this turn's
  // window. They have no turn_id of their own, so readTurn() above never sees
  // them; this is what powers the untracked_write cross-check in the matcher.
  const sentinelEvents = sentinelWritesForTurn(events);
  const turnEvents = events.concat(sentinelEvents);

  const report = reconcileTurn({
    promptText: promptEvent ? promptEvent.text : '',
    claimText: claimEvent ? claimEvent.text : '',
    turnEvents,
  });

  const full = {
    session_id: sessionId,
    turn_id: turnId,
    generated_at: new Date().toISOString(),
    ...report,
  };

  fs.writeFileSync(reportPath(sessionId, turnId), JSON.stringify(full, null, 2));
  return full;
}

function loadReport(sessionId, turnId) {
  const p = reportPath(sessionId, turnId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listSessionReports(sessionId) {
  const dir = path.join(dataDir(), 'reports', sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

module.exports = { reconcileAndPersist, loadReport, listSessionReports, reportPath };
