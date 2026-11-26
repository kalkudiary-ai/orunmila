#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { renderSessionHtml } = require('../src/render/html');
const { listSessionReports } = require('../src/reconcile');
const { listArchives, listArchivedSessionReports } = require('../src/reconcile/rescore');
const { trailForSession } = require('../src/trail');
const { redactForRender } = require('../src/render/redact');

// NI1 (LD264): the model-benchmark section is gone. Its results came from scripts/bench.js, which calls AI models over
// the internet and is not shipped; the free version makes no internet call (O, 2026-11-24).
const PORT = process.env.PORT || 3773;
const ORUNMILA_HOME = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');

/**
 * DOC3 (LD340; MR3, LD316): a session's witness gap from its odù log in <home>/sessions/<id>/, as `orunmila trail` and
 * the session report give it, or null when it has none that verifies (the trail page then says the gap is not shown).
 */
function witnessGapOf(sessionId) {
  try {
    const { sessionFolderName } = require('../src/opon/intake/paths');
    const text = fs.readFileSync(path.join(ORUNMILA_HOME, 'sessions', sessionFolderName(sessionId), 'odu.jsonl'), 'utf8');
    if (!require('../src/verify/chain').verifyText(text).ok) return null;
    return require('../src/babalawo/report').witnessGap(text.split('\n').slice(0, -1).map((l) => JSON.parse(l)));
  } catch {
    return null;
  }
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function loadSessions() {
  const eventsPath = path.join(ORUNMILA_HOME, 'events.jsonl');
  const reportsDir = path.join(ORUNMILA_HOME, 'reports');
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const sessionMap = new Map();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!e.session_id) continue;
      if (!sessionMap.has(e.session_id))
        sessionMap.set(e.session_id, { id: e.session_id, firstTs: e.ts, lastTs: e.ts, events: 0, turns: new Set(), agent: e.agent || '?' });
      const s = sessionMap.get(e.session_id);
      s.events++; s.lastTs = e.ts;
      if (e.turn_id) s.turns.add(e.turn_id);
    } catch { /* skip */ }
  }
  const sessions = [];
  for (const [id, s] of sessionMap) {
    const turnReports = [];
    const reportDir = path.join(reportsDir, id);
    if (fs.existsSync(reportDir)) {
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.json')).sort((a, b) => {
        return (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0);
      });
      for (const f of files) {
        try {
          const report = JSON.parse(fs.readFileSync(path.join(reportDir, f), 'utf8'));
          const sm = report.summary || report;
          turnReports.push({ turn: f.replace('.json', ''),
            verified: sm.verified || 0, partial: sm.partial || 0, phantom: sm.phantom || 0,
            phantom_verification: sm.phantom_verification || 0, unverifiable: sm.unverifiable || 0,
            silently_dropped: sm.silently_dropped || 0, untracked_writes: sm.untracked_writes || 0 });
        } catch { /* skip */ }
      }
    }
    let totV = 0, totPa = 0, totPh = 0, totPhv = 0, totDr = 0, totWild = 0, totClaims = 0;
    for (const t of turnReports) {
      totV += t.verified; totPa += t.partial; totPh += t.phantom; totPhv += t.phantom_verification;
      totDr += t.silently_dropped; totWild += t.untracked_writes;
      totClaims += t.verified + t.partial + t.phantom + t.phantom_verification + t.unverifiable;
    }
    const reliability = totClaims ? Math.round(100 * (totV + totPa * 0.5) / totClaims) : null;
    const phantoms = totPh + totPhv;
    const phRate = totClaims ? Math.round(100 * phantoms / totClaims) : null;
    sessions.push({ id, agent: s.agent, firstTs: s.firstTs, lastTs: s.lastTs,
      eventCount: s.events, turnCount: s.turns.size, reportedTurns: turnReports.length,
      turnReports, verified: totV, partial: totPa, phantom: totPh, phv: totPhv,
      dropped: totDr, wild: totWild, claims: totClaims, reliability, phRate, witnesses: witnessGapOf(id) });
  }
  return sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
}

// ── verdict helpers ──

function verdictLabel(reliability) {
  if (reliability === null) return { text: 'No data', cls: 'verdict-none' };
  if (reliability >= 70) return { text: 'Trustworthy', cls: 'verdict-good' };
  if (reliability >= 50) return { text: 'Review recommended', cls: 'verdict-warn' };
  return { text: 'Low trust', cls: 'verdict-bad' };
}

function timeDiff(a, b) {
  const ms = new Date(b) - new Date(a);
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h + 'h ' + m + 'm';
}

function proportionBar(v, pa, ph, phv, unv) {
  const total = v + pa + ph + phv + unv;
  if (!total) return '';
  const pct = n => Math.max((n / total) * 100, n > 0 ? 1.5 : 0).toFixed(1);
  return `<div class="prop-bar">
    ${v ? `<div class="seg-verified" style="width:${pct(v)}%" title="${v} verified"></div>` : ''}
    ${pa ? `<div class="seg-partial" style="width:${pct(pa)}%" title="${pa} partial"></div>` : ''}
    ${ph ? `<div class="seg-phantom" style="width:${pct(ph)}%" title="${ph} phantom"></div>` : ''}
    ${phv ? `<div class="seg-phv" style="width:${pct(phv)}%" title="${phv} phantom verification"></div>` : ''}
    ${unv ? `<div class="seg-unverifiable" style="width:${pct(unv)}%" title="${unv} unverifiable"></div>` : ''}
  </div>`;
}

// ── page render ──

function html() {
  const sessions = loadSessions();

  const activeSessions = sessions.filter(s => s.lastTs && (Date.now() - new Date(s.lastTs).getTime()) < 3600000);
  const recentSessions = sessions.filter(s => s.claims > 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orunmila</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #1c2333; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --text3: #484f58; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --orange: #db6d28; --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }

  /* ── layout ── */
  .page-header { padding: 24px 32px 0; }
  .page-header h1 { font-size: 24px; font-weight: 600; }
  .page-header h1 span { color: var(--accent); }
  .page-header .sub { color: var(--text2); font-size: 13px; margin-top: 2px; }

  .section { padding: 0 32px; }
  .section-divider { margin: 40px 32px 0; border: none; border-top: 1px solid var(--border); }

  .section-head { display: flex; align-items: baseline; gap: 12px; margin: 32px 0 8px; }
  .section-head h2 { font-size: 18px; font-weight: 600; margin: 0; }
  .section-head .label { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--text3); font-weight: 600; }
  .section-head .count { font-size: 12px; color: var(--text2); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
  .section-desc { color: var(--text2); font-size: 13px; margin-bottom: 16px; max-width: 720px; }

  /* ── nav ── */
  .nav { display: flex; gap: 2px; margin-bottom: 16px; }
  .nav-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--text2); cursor: pointer; font-size: 13px; font-weight: 500; transition: all .12s; }
  .nav-btn:hover { color: var(--text); background: var(--surface); }
  .nav-btn.active { color: var(--text); background: var(--surface); border-color: var(--border); }
  .sub-panel { display: none; }
  .sub-panel.active { display: block; }

  /* ── session cards ── */
  .session-grid { display: flex; flex-direction: column; gap: 8px; }
  .s-card { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 14px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; text-decoration: none; color: var(--text); transition: border-color .12s; }
  .s-card:hover { border-color: var(--accent); }
  .s-card-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .s-card-right { display: flex; align-items: center; gap: 20px; }
  .s-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; flex-shrink: 0; }
  .s-pulse.inactive { background: var(--text3); animation: none; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
  .s-info { min-width: 0; }
  .s-agent { font-size: 14px; font-weight: 600; }
  .s-id { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 11px; color: var(--text3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-narrative { font-size: 12px; color: var(--text2); margin-top: 2px; line-height: 1.4; max-width: 420px; }
  .s-meta { font-size: 12px; color: var(--text2); white-space: nowrap; }
  .s-verdict { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 6px; white-space: nowrap; }
  .verdict-good { background: #3fb95022; color: var(--green); }
  .verdict-warn { background: #d2992222; color: var(--yellow); }
  .verdict-bad { background: #f8514922; color: var(--red); }
  .verdict-none { background: var(--surface2); color: var(--text3); }
  .s-reliability { font-size: 20px; font-weight: 700; min-width: 48px; text-align: right; }
  .s-bar-wrap { width: 100px; }
  .prop-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--border); gap: 1px; }
  .prop-bar > div { height: 100%; }
  .seg-verified { background: var(--green); }
  .seg-partial { background: #2ea04388; }
  .seg-phantom { background: var(--orange); }
  .seg-phv { background: var(--red); }
  .seg-unverifiable { background: #484f58; }

  /* ── benchmark tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border); color: var(--text3); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; position: sticky; top: 0; background: var(--bg); cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--accent); }
  th.num, td.num { text-align: right; }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--surface); }
  tr.expandable { cursor: pointer; }
  tr.detail-row td { padding: 0; background: var(--surface); }
  tr.detail-row .detail-inner { padding: 12px 20px; }
  tr.detail-row table { font-size: 13px; }
  tr.detail-row th { background: var(--surface); }

  .bar-cell { position: relative; width: 110px; }
  .bar { height: 20px; border-radius: 4px; display: inline-block; vertical-align: middle; min-width: 2px; }
  .bar-label { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-weight: 600; font-size: 13px; }
  .pass { color: var(--green); } .fail { color: var(--red); }
  .r-high { background: var(--green); } .r-mid { background: var(--yellow); } .r-low { background: var(--orange); } .r-bad { background: var(--red); }

  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: .3px; }
  .pill-direct { background: #1f6feb22; color: var(--accent); }
  .pill-aider { background: #3fb95022; color: var(--green); }
  .pill-claude { background: #d2992222; color: var(--yellow); }
  .pill-other { background: #30363d; color: var(--text2); }

  .search { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 13px; width: 220px; margin-bottom: 12px; outline: none; }
  .search:focus { border-color: var(--accent); }

  /* ── framework effect ── */
  .fw-group { margin-bottom: 12px; padding: 14px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
  .fw-group h3 { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .fw-bar-wrap { flex: 1; min-width: 180px; }
  .fw-bar-label { font-size: 12px; color: var(--text2); margin-bottom: 2px; display: flex; justify-content: space-between; }
  .fw-bar-track { background: var(--border); border-radius: 4px; height: 22px; overflow: hidden; }
  .fw-bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 600; color: #fff; }

  /* ── legend ── */
  .legend { display: flex; gap: 14px; font-size: 11px; color: var(--text2); flex-wrap: wrap; margin-bottom: 12px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }

  @media (max-width: 768px) {
    .page-header, .section { padding-left: 16px; padding-right: 16px; }
    .section-divider { margin-left: 16px; margin-right: 16px; }
    .s-card { grid-template-columns: 1fr; }
    .s-card-right { justify-content: flex-start; }
  }
</style>
</head>
<body>

<!-- ═══════════════════ HEADER ═══════════════════ -->
<div class="page-header">
  <h1><span>◉</span> Orunmila</h1>
  <div class="sub">Claim vs. reality reconciliation for AI coding agents</div>
  <p style="color:var(--text2);font-size:13px;max-width:680px;margin-top:8px;line-height:1.6;">
    Orunmila watches AI coding agents at work and checks every claim against reality.
    When an agent says <em>"I fixed the bug and ran the tests"</em>, Orunmila checks: was the file actually changed? Did a test actually run and pass?
    <strong>Monitor</strong> shows live and recent work sessions.
  </p>
</div>

<!-- ═══════════════════ SESSIONS ═══════════════════ -->
<div class="section">
  <div class="section-head">
    <div class="label">Monitor</div>
    <h2>Work Sessions</h2>
    <span class="count">${sessions.length}</span>
  </div>
  <p class="section-desc">
    Real coding sessions captured by Orunmila hooks. Each row is one conversation with an AI agent —
    click to open the full report with Graph, Tree, Timeline, and Dashboard views.
  </p>

  <div class="legend">
    <span><span class="legend-dot seg-verified"></span>Verified</span>
    <span><span class="legend-dot seg-partial"></span>Partial</span>
    <span><span class="legend-dot seg-phantom"></span>Phantom</span>
    <span><span class="legend-dot seg-phv"></span>False verification</span>
    <span><span class="legend-dot seg-unverifiable"></span>Unverifiable</span>
  </div>

  <div class="session-grid">
    ${recentSessions.length ? recentSessions.map(s => renderSessionRow(s, activeSessions)).join('\n')
      : '<p style="color:var(--text3);font-size:13px;">No sessions with reconciliation data yet. Hook up an agent and start working.</p>'}
  </div>
  ${sessions.length > recentSessions.length ? `<p style="color:var(--text3);font-size:12px;margin-top:8px;">${sessions.length - recentSessions.length} session(s) with no reconciliation data hidden</p>` : ''}
</div>

<div style="height:48px"></div>

<script>
// auto-refresh sessions every 15 seconds
setInterval(() => {
  fetch('/api/sessions').then(r => r.json()).then(sessions => {
    const grid = document.querySelector('.session-grid');
    if (!grid || !sessions.length) return;
    const indicator = document.getElementById('refresh-indicator');
    if (indicator) indicator.style.opacity = '1';
    setTimeout(() => { if (indicator) indicator.style.opacity = '0'; }, 800);
  }).catch(() => {});
}, 15000);
</script>
</body>
</html>`;
}

// ── session row ──

function narrativeFor(s) {
  const parts = [];
  const phantoms = s.phantom + s.phv;
  if (phantoms > 0) {
    parts.push(`${phantoms} claim${phantoms === 1 ? '' : 's'} with no evidence behind ${phantoms === 1 ? 'it' : 'them'}`);
  }
  if (s.phv > 0) {
    parts.push(`claimed "tested and works" ${s.phv} time${s.phv === 1 ? '' : 's'} without running a test`);
  }
  if (s.dropped > 0) {
    parts.push(`${s.dropped} part${s.dropped === 1 ? '' : 's'} of the original request with no evidence and not mentioned again`);
  }
  if (s.wild > 0) {
    parts.push(`${s.wild} file${s.wild === 1 ? '' : 's'} changed on disk without disclosure`);
  }
  if (!parts.length && s.verified > 0) {
    parts.push(`all ${s.verified} claims verified — nothing flagged`);
  }
  return parts.join('. ') + (parts.length ? '.' : '');
}

function renderSessionRow(s, activeSessions) {
  const isActive = activeSessions.some(a => a.id === s.id);
  const v = verdictLabel(s.reliability);
  const dateStr = s.lastTs ? new Date(s.lastTs).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const elapsed = s.firstTs && s.lastTs ? timeDiff(s.firstTs, s.lastTs) : '';
  const rColor = s.reliability >= 70 ? 'var(--green)' : s.reliability >= 50 ? 'var(--yellow)' : s.reliability !== null ? 'var(--red)' : 'var(--text3)';
  const narrative = narrativeFor(s);

  return `<a href="/session/${encodeURIComponent(s.id)}" class="s-card" target="_blank">
    <div class="s-card-left">
      <div class="s-pulse ${isActive ? '' : 'inactive'}"></div>
      <div class="s-info">
        <div class="s-agent">${esc(s.agent)}</div>
        <div class="s-id">${esc(s.id)}</div>
        ${narrative ? `<div class="s-narrative">${esc(narrative)}</div>` : ''}
        ${s.witnesses ? `<div class="s-narrative">${esc(s.witnesses.sentence)}</div>` : ''}
      </div>
    </div>
    <div class="s-card-right">
      <div class="s-meta">${dateStr} · ${s.turnCount} turns · ${elapsed}</div>
      <div class="s-bar-wrap" title="Proportion of claim outcomes: ${s.verified} verified, ${s.partial} partial, ${s.phantom} phantom, ${s.phv} false verification">
        ${proportionBar(s.verified, s.partial, s.phantom, s.phv, s.claims - s.verified - s.partial - s.phantom - s.phv)}
      </div>
      <div class="s-reliability" style="color:${rColor}" title="Reliability: weighted score 0-100. Verified claims score 1.0, partial 0.5, phantom/dropped score 0.">${s.reliability !== null ? s.reliability + '%' : '—'}</div>
      <div class="s-verdict ${v.cls}">${v.text}</div>
    </div>
  </a>`;
}


// ── server ──

const server = http.createServer((req, res) => {
  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(loadSessions()));
  }
  if (req.url === '/api/archives') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listArchives().map((a) => ({ stamp: a.stamp, manifest: a.manifest }))));
  }
  // Optional archive snapshot: /session/<id>?archive=<stamp>
  const sessionMatch = req.url.match(/^\/session\/([a-f0-9-]+)(?:\?(.*))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const params = new URLSearchParams(sessionMatch[2] || '');
    const stamp = params.get('archive');
    try {
      const rawTrail = trailForSession(sessionId);
      const liveReports = stamp ? listArchivedSessionReports(stamp, sessionId) : listSessionReports(sessionId);
      const { reports, trail } = redactForRender(liveReports, rawTrail, { home: true, root: process.cwd() });
      if (!reports.length) { res.writeHead(404); return res.end('No reports for session ' + sessionId + (stamp ? ` (archive ${stamp})` : '')); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderSessionHtml(sessionId, reports, trail, { witnesses: witnessGapOf(sessionId) })); // DOC3: as orunmila trail
    } catch (e) { res.writeHead(500); return res.end('Error: ' + e.message); }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html());
});

// Loopback only (0.2.2). With no host, Node listens on every interface, which
// served session ids, prompts and reports to anyone on the same network.
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => { console.log(`Orunmila dashboard → http://${HOST}:${server.address().port}`); }); // the port it got (PORT=0: any free one)
