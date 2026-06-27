'use strict';

/**
 * rescore.js
 *
 * Re-runs reconcileTurn over every persisted report using the CURRENT engine.
 * Before overwriting any live report it copies the original to
 *   <dataDir>/archive/<timestamp>/<sessionId>/<turnId>.json
 * and writes an archive manifest at
 *   <dataDir>/archive/<timestamp>/manifest.json
 * recording engine version, when, and aggregate before/after totals.
 *
 * The live reports under <dataDir>/reports/ remain the single source of truth
 * the dashboard and `orunmila html|trail|report` commands read. Archived
 * snapshots live alongside but are never indexed in the dashboard — they are
 * only fetched explicitly via `--archive <timestamp>` on the inspection
 * commands (see bin/orunmila.js).
 */

const fs = require('fs');
const path = require('path');
const { dataDir, readTurn, readBetween, TYPES } = require('../store/eventlog');
const { reconcileTurn } = require('./matcher');
const { extractSubtasks } = require('./task-extractor');

const KEYS = [
  'verified',
  'partial',
  'phantom',
  'phantom_verification',
  'unverifiable',
  'silently_dropped',
  'unverifiable_ask',
  'undisclosed_changes',
  'untracked_writes',
];

function reportsDir(home) {
  return path.join(home || dataDir(), 'reports');
}

function archiveRoot(home) {
  return path.join(home || dataDir(), 'archive');
}

function newArchiveDir(home) {
  // YYYYMMDD-HHMMSS, locale-stable, lex-sortable
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = path.join(archiveRoot(home), stamp);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, stamp };
}

function listArchives(home) {
  const root = archiveRoot(home);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => /^\d{8}-\d{6}$/.test(name))
    .sort()
    .map((name) => {
      const manifestPath = path.join(root, name, 'manifest.json');
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        // archive without a manifest still listable; just no metadata
      }
      return { stamp: name, dir: path.join(root, name), manifest };
    });
}

function loadArchivedReport(stamp, sessionId, turnId, home) {
  const p = path.join(archiveRoot(home), stamp, sessionId, `${turnId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listArchivedSessionReports(stamp, sessionId, home) {
  const dir = path.join(archiveRoot(home), stamp, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function sentinelWritesForTurn(hookEvents) {
  const stamps = hookEvents.map((e) => e.ts).filter(Boolean).sort();
  if (!stamps.length) return [];
  const fromTs = stamps[0];
  const toTs = stamps[stamps.length - 1];
  return readBetween(fromTs, toTs).filter(
    (e) => e.source === 'fs-sentinel' && e.type === TYPES.FILE_WRITE
  );
}

function priorSessionTargets(sessionId, currentTurnId) {
  const targets = [];
  let i = 1;
  while (true) {
    const tid = `t${i}`;
    if (tid === currentTurnId) break;
    const events = readTurn(sessionId, tid);
    if (!events.length) break;
    const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
    if (promptEvent && promptEvent.text) {
      for (const s of extractSubtasks(promptEvent.text)) {
        for (const t of s.targets || []) targets.push(t);
      }
    }
    i++;
    if (i > 1000) break;
  }
  return targets;
}

function zero() {
  const o = {};
  for (const k of KEYS) o[k] = 0;
  return o;
}

function addInto(acc, summary) {
  for (const k of KEYS) acc[k] += (summary && summary[k]) || 0;
}

/**
 * Re-reconcile every persisted report under <dataDir>/reports/. Archives the
 * originals to <dataDir>/archive/<stamp>/ first, then overwrites each live
 * report file with the new-engine output. Returns aggregate totals and the
 * archive stamp.
 *
 * Options:
 *   home    - override the orunmila data dir (defaults to dataDir()).
 *   dryRun  - compute deltas without writing.
 *   logger  - function called with per-session progress lines.
 */
function rescoreAll({ home, dryRun = false, logger } = {}) {
  const reports = reportsDir(home);
  if (!fs.existsSync(reports)) {
    return { sessions: 0, turns: 0, before: zero(), after: zero(), archive: null };
  }

  const archive = dryRun ? null : newArchiveDir(home);
  const sessions = fs.readdirSync(reports).sort();
  const before = zero();
  const after = zero();
  let turnsRescored = 0;
  let sessionsTouched = 0;

  for (const sessionId of sessions) {
    const sessionDir = path.join(reports, sessionId);
    if (!fs.statSync(sessionDir).isDirectory()) continue;
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json'));
    if (!files.length) continue;
    sessionsTouched++;

    for (const file of files) {
      const turnId = file.replace(/\.json$/, '');
      const livePath = path.join(sessionDir, file);
      const original = JSON.parse(fs.readFileSync(livePath, 'utf8'));

      const events = readTurn(sessionId, turnId);
      if (!events.length) {
        // Events for this turn aren't in the log anymore (pruned). Keep the
        // existing scored report untouched and skip — there's nothing to
        // re-derive from.
        continue;
      }
      const promptEvent = events.find((e) => e.type === TYPES.USER_PROMPT);
      const claimEvent = events.find((e) => e.type === TYPES.TURN_CLAIM);
      const sentinelEvents = sentinelWritesForTurn(events);

      const newReport = reconcileTurn({
        promptText: promptEvent ? promptEvent.text : '',
        claimText: claimEvent ? claimEvent.text : '',
        turnEvents: events.concat(sentinelEvents),
        sessionTargets: priorSessionTargets(sessionId, turnId),
      });

      const merged = {
        session_id: sessionId,
        turn_id: turnId,
        generated_at: new Date().toISOString(),
        rescored_at: new Date().toISOString(),
        engine: 'post-dogfood',
        prior_engine_generated_at: original.generated_at,
        ...newReport,
      };

      addInto(before, original.summary || {});
      addInto(after, newReport.summary);
      turnsRescored++;

      if (!dryRun) {
        // archive original
        const archDir = path.join(archive.dir, sessionId);
        fs.mkdirSync(archDir, { recursive: true });
        fs.writeFileSync(path.join(archDir, file), JSON.stringify(original, null, 2));
        // overwrite live
        fs.writeFileSync(livePath, JSON.stringify(merged, null, 2));
      }
    }

    if (logger) logger(`  ${sessionId}: ${files.length} turn(s)`);
  }

  const result = {
    sessions: sessionsTouched,
    turns: turnsRescored,
    before,
    after,
    archive: archive ? archive.stamp : null,
  };

  if (!dryRun && archive) {
    const manifest = {
      created_at: new Date().toISOString(),
      engine_before: 'pre-dogfood',
      engine_after: 'post-dogfood',
      sessions: sessionsTouched,
      turns: turnsRescored,
      totals: { before, after },
      note: 'Originals of every report rewritten by this rescore run. Inspect with `orunmila report|html|trail --archive ' + archive.stamp + '`.',
    };
    fs.writeFileSync(path.join(archive.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  return result;
}

module.exports = {
  rescoreAll,
  listArchives,
  loadArchivedReport,
  listArchivedSessionReports,
  archiveRoot,
  KEYS,
};
