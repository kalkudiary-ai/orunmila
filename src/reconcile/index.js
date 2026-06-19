'use strict';

const fs = require('fs');
const path = require('path');
const { readTurn, dataDir, TYPES } = require('../store/eventlog');
const { reconcileTurn } = require('./matcher');

function reportPath(sessionId, turnId) {
  const dir = path.join(dataDir(), 'reports', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${turnId}.json`);
}

function reconcileAndPersist(sessionId, turnId) {
  const events = readTurn(sessionId, turnId);
  const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
  const claimEvent = events.find((e) => e.type === TYPES.TURN_CLAIM);

  const report = reconcileTurn({
    promptText: promptEvent ? promptEvent.text : '',
    claimText: claimEvent ? claimEvent.text : '',
    turnEvents: events,
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
