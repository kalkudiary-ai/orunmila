'use strict';

/**
 * html.js
 *
 * The literal dye-stain visual. Two parts:
 *   1. A file grid - every file touched this session, tinted by the worst
 *      outcome that touched it and sized by how much diff volume it carried.
 *      This is the "map of where the agent actually went" the project is
 *      named after.
 *   2. A turn-by-turn accordion with the same color language, so a quick
 *      glance at the grid and a deep-dive per turn use one consistent
 *      vocabulary.
 *
 * Output is one self-contained .html file - no CDN, no build step, just
 * open it in a browser.
 */

const COLORS = {
  untracked_write: '#d50000',
  verified: '#2e7d32',
  partial: '#f9a825',
  phantom: '#c62828',
  phantom_verification: '#b71c1c',
  unverifiable: '#757575',
  undisclosed: '#8e24aa',
  silently_dropped: '#6a1b9a',
  addressed: '#2e7d32',
  acknowledged_incomplete: '#0277bd',
  unverifiable_ask: '#757575',
};

// untracked_write outranks everything: a change the agent's tool stream never
// disclosed at all is the strongest stain the tool can find (PRD 6.4).
const SEVERITY_RANK = {
  untracked_write: 6,
  phantom_verification: 5,
  phantom: 4,
  silently_dropped: 4,
  undisclosed: 3,
  partial: 2,
  unverifiable: 1,
  unverifiable_ask: 1,
  verified: 0,
  addressed: 0,
  acknowledged_incomplete: 0,
};

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildFileStains(reports) {
  const files = new Map();
  const bump = (p, outcome) => {
    if (!p) return;
    const cur = files.get(p) || { worstOutcome: 'verified', touches: 0 };
    cur.touches += 1;
    if (SEVERITY_RANK[outcome] > SEVERITY_RANK[cur.worstOutcome]) cur.worstOutcome = outcome;
    files.set(p, cur);
  };

  for (const report of reports) {
    for (const c of report.claims) {
      for (const ev of c.evidence || []) {
        if (ev.path) bump(ev.path, c.outcome);
      }
    }
    for (const u of report.undisclosed || []) {
      bump(u.path, 'undisclosed');
    }
    for (const u of report.untracked || []) {
      bump(u.rel_path || u.path, 'untracked_write');
    }
  }
  return files;
}

function renderFileGrid(files) {
  if (!files.size) return '<p class="dim">No file writes captured yet.</p>';
  const items = Array.from(files.entries()).map(([p, info]) => {
    const color = COLORS[info.worstOutcome] || '#999';
    const size = Math.min(220, 90 + info.touches * 18);
    return `<div class="stain" style="background:${color};flex-basis:${size}px;" title="${esc(p)} - worst outcome: ${esc(info.worstOutcome)}, touched ${info.touches}x">
      <span class="stain-label">${esc(p.split('/').pop())}</span>
    </div>`;
  });
  return `<div class="file-grid">${items.join('\n')}</div>`;
}

function renderClaim(c) {
  const color = COLORS[c.outcome] || '#999';
  const hints = (c.causeHints || []).length
    ? `<div class="hints">evidence signals: ${esc(c.causeHints.join(', '))} <span class="dim">(inference, not a verdict)</span></div>`
    : '';
  return `<div class="card" style="border-left-color:${color}">
    <div class="card-head"><span class="badge" style="background:${color}">${esc(c.outcome)}</span></div>
    <div class="claim-text">&ldquo;${esc(c.claim.text)}&rdquo;</div>
    ${hints}
  </div>`;
}

function renderSubtask(t) {
  const color = COLORS[t.outcome] || '#999';
  return `<div class="card" style="border-left-color:${color}">
    <div class="card-head"><span class="badge" style="background:${color}">${esc(t.outcome)}</span></div>
    <div class="claim-text">${esc(t.task.text)}</div>
  </div>`;
}

function renderTurn(report) {
  const claims = report.claims.map(renderClaim).join('\n') || '<p class="dim">No checkable claims.</p>';
  const subtasks = report.subtasks.length > 1 ? report.subtasks.map(renderSubtask).join('\n') : '';
  const undisclosed = (report.undisclosed || [])
    .map((u) => `<div class="card" style="border-left-color:${COLORS.undisclosed}">
        <div class="card-head"><span class="badge" style="background:${COLORS.undisclosed}">undisclosed</span></div>
        <div class="claim-text">${esc(u.path)}</div>
      </div>`)
    .join('\n');

  // Untracked writes render FIRST, in their own loud block (PRD 6.4: never
  // buried with ordinary undisclosed changes).
  const untracked = (report.untracked || [])
    .map((u) => `<div class="card" style="border-left-color:${COLORS.untracked_write}">
        <div class="card-head"><span class="badge" style="background:${COLORS.untracked_write}">untracked write</span></div>
        <div class="claim-text">${esc(u.rel_path || u.path)}${u.change_kind ? ` <span class="dim">(${esc(u.change_kind)})</span>` : ''}</div>
      </div>`)
    .join('\n');

  const untrackedCount = (report.untracked || []).length;
  return `<details class="turn">
    <summary>Turn ${esc(report.turn_id)} - ${untrackedCount ? `<span style="color:${COLORS.untracked_write}">${untrackedCount} untracked</span> / ` : ''}${report.summary.verified} verified / ${report.summary.phantom + report.summary.phantom_verification} phantom / ${report.summary.silently_dropped} dropped / ${report.summary.undisclosed_changes} undisclosed</summary>
    ${untracked ? `<h4>Untracked writes (disk changed, no tool call disclosed it)</h4>${untracked}` : ''}
    <h4>Claims</h4>
    ${claims}
    ${subtasks ? `<h4>Original ask (checked independently)</h4>${subtasks}` : ''}
    ${undisclosed ? `<h4>Undisclosed changes</h4>${undisclosed}` : ''}
  </details>`;
}

function renderSessionHtml(sessionId, reports) {
  const files = buildFileStains(reports);
  const totals = reports.reduce((acc, r) => {
    for (const k of Object.keys(r.summary)) acc[k] = (acc[k] || 0) + r.summary[k];
    return acc;
  }, {});

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>orunmila - session ${esc(sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#111; color:#eee; margin:0; padding:24px; }
  h1 { font-size: 1.4rem; }
  h4 { margin: 18px 0 6px; color:#bbb; font-size:0.85rem; text-transform:uppercase; letter-spacing:0.04em; }
  .dim { color:#888; }
  .summary-bar { display:flex; gap:14px; flex-wrap:wrap; margin:10px 0 24px; font-size:0.9rem; }
  .summary-bar span { background:#1c1c1c; padding:4px 10px; border-radius:6px; }
  .file-grid { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:28px; }
  .stain { height:60px; border-radius:8px; display:flex; align-items:flex-end; padding:6px; opacity:0.92; cursor:default; transition:transform .1s; }
  .stain:hover { transform:scale(1.04); opacity:1; }
  .stain-label { font-size:0.72rem; background:rgba(0,0,0,0.45); padding:2px 5px; border-radius:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
  details.turn { background:#1a1a1a; border-radius:10px; padding:10px 16px; margin-bottom:10px; }
  summary { cursor:pointer; font-weight:600; }
  .card { border-left:4px solid #999; background:#1c1c1c; padding:8px 12px; border-radius:6px; margin:6px 0; }
  .card-head { margin-bottom:4px; }
  .badge { color:#111; font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:0.03em; }
  .claim-text { font-size:0.92rem; }
  .hints { font-size:0.78rem; color:#aaa; margin-top:4px; }
</style>
</head>
<body>
  <h1>orunmila &mdash; session ${esc(sessionId)}</h1>
  <div class="summary-bar">
    <span style="background:${COLORS.untracked_write};color:#fff">untracked writes: ${totals.untracked_writes || 0}</span>
    <span>verified: ${totals.verified || 0}</span>
    <span>partial: ${totals.partial || 0}</span>
    <span>phantom: ${totals.phantom || 0}</span>
    <span>phantom verification: ${totals.phantom_verification || 0}</span>
    <span>unverifiable: ${totals.unverifiable || 0}</span>
    <span>silently dropped: ${totals.silently_dropped || 0}</span>
    <span>undisclosed changes: ${totals.undisclosed_changes || 0}</span>
  </div>

  <h4>Where the agent actually went (colored by worst outcome touching that file)</h4>
  ${renderFileGrid(files)}

  <h4>Turn by turn</h4>
  ${reports.map(renderTurn).join('\n')}
</body>
</html>`;
}

module.exports = { renderSessionHtml };
