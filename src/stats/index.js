'use strict';

/**
 * stats/index.js — cross-session, cross-agent aggregate statistics.
 *
 * Reads every persisted report, groups by agent (and optionally by task tag),
 * and computes outcome rates, tool-use profiles, and reliability scores.
 * This is the engine behind `orunmila stats` and the benchmark comparisons.
 *
 * Every number this module emits is deterministic and derived from the same
 * reconciled reports the HTML renderer uses — no separate scoring pipeline,
 * no LLM in the loop, no sampling. The stat IS the report, aggregated.
 */

const fs = require('fs');
const path = require('path');
const { readAll, dataDir, TYPES } = require('../store/eventlog');

// --- outcome weights for the reliability score ---
// A single 0-100 number that answers "how much can I trust this agent's claims?"
// Verified = full credit, partial = half, everything stained = zero or negative.
const OUTCOME_WEIGHT = {
  verified: 1.0,
  partial: 0.5,
  phantom: 0,
  phantom_verification: 0,
  unverifiable: 0, // excluded from denominator — can't judge, don't penalize
  unverifiable_ask: 0,
};

function loadAllReports() {
  const reportsDir = path.join(dataDir(), 'reports');
  if (!fs.existsSync(reportsDir)) return [];
  const reports = [];
  for (const sessionDir of fs.readdirSync(reportsDir)) {
    const absDir = path.join(reportsDir, sessionDir);
    if (!fs.statSync(absDir).isDirectory()) continue;
    for (const file of fs.readdirSync(absDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        reports.push(JSON.parse(fs.readFileSync(path.join(absDir, file), 'utf8')));
      } catch { /* skip corrupt report */ }
    }
  }
  return reports;
}

function agentForSession(sessionId, eventsBySession) {
  const events = eventsBySession.get(sessionId);
  if (!events || !events.length) return 'unknown';
  const agentEvent = events.find((e) => e.agent);
  return agentEvent ? agentEvent.agent : 'unknown';
}

function toolProfile(events) {
  const counts = { reads: 0, writes: 0, commands: 0, network: 0, other: 0 };
  for (const e of events) {
    if (e.type === TYPES.FILE_READ) counts.reads++;
    else if (e.type === TYPES.FILE_WRITE) counts.writes++;
    else if (e.type === TYPES.COMMAND_RUN) counts.commands++;
    else if (e.type === TYPES.NETWORK_CALL) counts.network++;
    else if (e.type === TYPES.TOOL_CALL) counts.other++;
  }
  return counts;
}

function reliabilityScore(summary) {
  const judged = (summary.verified || 0) + (summary.partial || 0) +
    (summary.phantom || 0) + (summary.phantom_verification || 0);
  if (judged === 0) return null;
  const score = (
    (summary.verified || 0) * OUTCOME_WEIGHT.verified +
    (summary.partial || 0) * OUTCOME_WEIGHT.partial
  ) / judged;
  return Math.round(score * 1000) / 10;
}

function aggregate(reports, eventsBySession) {
  const byAgent = new Map();

  for (const report of reports) {
    const agent = agentForSession(report.session_id, eventsBySession);
    if (!byAgent.has(agent)) {
      byAgent.set(agent, {
        agent,
        sessions: new Set(),
        turns: 0,
        totals: {
          verified: 0, partial: 0, phantom: 0, phantom_verification: 0,
          unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0,
          undisclosed_changes: 0, untracked_writes: 0,
        },
        tools: { reads: 0, writes: 0, commands: 0, network: 0, other: 0 },
      });
    }
    const bucket = byAgent.get(agent);
    bucket.sessions.add(report.session_id);
    bucket.turns++;
    if (report.summary) {
      for (const key of Object.keys(bucket.totals)) {
        bucket.totals[key] += report.summary[key] || 0;
      }
    }
    const sessionEvents = eventsBySession.get(report.session_id) || [];
    const turnEvents = sessionEvents.filter((e) => e.turn_id === report.turn_id);
    const tp = toolProfile(turnEvents);
    for (const key of Object.keys(bucket.tools)) {
      bucket.tools[key] += tp[key];
    }
  }

  const results = [];
  for (const bucket of byAgent.values()) {
    const t = bucket.totals;
    const totalClaims = t.verified + t.partial + t.phantom + t.phantom_verification + t.unverifiable;
    const stainedClaims = t.phantom + t.phantom_verification;
    results.push({
      agent: bucket.agent,
      sessions: bucket.sessions.size,
      turns: bucket.turns,
      totalClaims,
      outcomes: { ...t },
      phantomRate: totalClaims > 0 ? Math.round((stainedClaims / totalClaims) * 1000) / 10 : 0,
      reliability: reliabilityScore(t),
      tools: { ...bucket.tools },
    });
  }

  return results.sort((a, b) => b.sessions - a.sessions);
}

function computeStats() {
  const allEvents = readAll();
  const eventsBySession = new Map();
  for (const e of allEvents) {
    const sid = e.session_id;
    if (!sid) continue;
    if (!eventsBySession.has(sid)) eventsBySession.set(sid, []);
    eventsBySession.get(sid).push(e);
  }

  const reports = loadAllReports();
  if (!reports.length) return { agents: [], totalSessions: 0, totalTurns: 0, totalEvents: allEvents.length };

  const agents = aggregate(reports, eventsBySession);
  return {
    agents,
    totalSessions: new Set(reports.map((r) => r.session_id)).size,
    totalTurns: reports.length,
    totalEvents: allEvents.length,
  };
}

function formatStats(stats) {
  const lines = [];

  if (!stats.agents.length) {
    lines.push('No reconciled sessions yet. Run an agent with orunmila hooks installed, then check back.');
    return lines.join('\n');
  }

  lines.push(`=== orunmila cross-agent statistics ===\n`);
  lines.push(`Sessions: ${stats.totalSessions}  |  Turns: ${stats.totalTurns}  |  Events: ${stats.totalEvents}\n`);

  for (const a of stats.agents) {
    const o = a.outcomes;
    lines.push(`--- ${a.agent} (${a.sessions} session${a.sessions === 1 ? '' : 's'}, ${a.turns} turn${a.turns === 1 ? '' : 's'}) ---`);
    lines.push('');

    // Reliability headline
    if (a.reliability !== null) {
      const bar = renderBar(a.reliability, 100);
      lines.push(`  Reliability:    ${bar} ${a.reliability}%`);
    }
    if (a.totalClaims > 0) {
      const bar = renderBar(a.phantomRate, 50);
      lines.push(`  Phantom rate:   ${bar} ${a.phantomRate}% (${o.phantom + o.phantom_verification}/${a.totalClaims} claims)`);
    }

    lines.push('');
    lines.push('  Claims:');
    lines.push(`    verified              ${o.verified}`);
    lines.push(`    partial               ${o.partial}`);
    lines.push(`    phantom               ${o.phantom}`);
    lines.push(`    phantom_verification  ${o.phantom_verification}`);
    lines.push(`    unverifiable          ${o.unverifiable}`);

    lines.push('  Tasks:');
    lines.push(`    silently_dropped      ${o.silently_dropped}`);
    lines.push(`    unverifiable_ask      ${o.unverifiable_ask}`);

    lines.push('  Integrity:');
    lines.push(`    undisclosed_changes   ${o.undisclosed_changes}`);
    lines.push(`    untracked_writes      ${o.untracked_writes}`);

    lines.push('  Tool usage:');
    const t = a.tools;
    lines.push(`    reads ${t.reads}  writes ${t.writes}  commands ${t.commands}  network ${t.network}  other ${t.other}`);
    lines.push('');
  }

  if (stats.agents.length > 1) {
    lines.push('--- comparison ---');
    lines.push('');
    lines.push(padRow('Agent', 'Sessions', 'Turns', 'Reliability', 'Phantom %', 'Untracked'));
    lines.push(padRow('-----', '--------', '-----', '-----------', '---------', '---------'));
    for (const a of stats.agents) {
      lines.push(padRow(
        a.agent,
        String(a.sessions),
        String(a.turns),
        a.reliability !== null ? `${a.reliability}%` : 'n/a',
        `${a.phantomRate}%`,
        String(a.outcomes.untracked_writes)
      ));
    }
    lines.push('');
  }

  lines.push('Sample sizes shown. Statistical significance requires 30+ turns per agent.');
  return lines.join('\n');
}

function renderBar(value, max) {
  const width = 20;
  const filled = Math.round((Math.min(value, max) / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function padRow(...cols) {
  const widths = [16, 10, 8, 13, 11, 10];
  return cols.map((c, i) => String(c).padEnd(widths[i] || 12)).join('');
}

module.exports = { computeStats, formatStats, aggregate, reliabilityScore, loadAllReports };
