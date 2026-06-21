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

const { buildVizData, renderTrailVisual } = require('./trail-visual');

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

// The glove's own visual axis: not "is this a mismatch" (that's COLORS above)
// but "what KIND of contact was this". A separate vocabulary on purpose so the
// trail can be read even on files orunmila found nothing wrong with.
const CHANNEL_COLORS = {
  read: '#4fc3f7',     // light blue — observed, no change
  write: '#66bb6a',    // green — agent-announced change
  disk: '#26a69a',     // teal — independently observed on disk (sentinel)
  command: '#ffb74d',  // amber — a command ran
  network: '#ba68c8',  // purple — external contact
  tool: '#90a4ae',     // grey — other tool call
};

const CHANNEL_GLYPH = {
  read: '👁', write: '✎', disk: '💾', command: '$', network: '🌐', tool: '⚙',
};

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Display-only basename: split on both separators so a Windows path
// (src\foo.js) shows just `foo.js`, same as a posix one.
function baseLabel(p) {
  return String(p).split(/[\\/]/).pop();
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

// Index a trail model's session-level artifacts by path so the file grid can
// overlay the trail (touch count + lineage) on each cell orunmila already colored.
function indexTrailByPath(trail) {
  const byPath = new Map();
  if (!trail) return byPath;
  for (const a of trail.artifacts || []) {
    if (a.path) byPath.set(a.path, a);
  }
  return byPath;
}

function renderFileGrid(files, trailByPath) {
  if (!files.size) return '<p class="dim">No file writes captured yet.</p>';
  const items = Array.from(files.entries()).map(([p, info]) => {
    const color = COLORS[info.worstOutcome] || '#999';
    const g = trailByPath && trailByPath.get(p);
    const size = Math.min(260, 90 + info.touches * 18 + (g ? g.touch_count * 6 : 0));
    // Trail overlay: a small badge of touch count + channel glyphs, and the
    // lineage (what this file inherited the stain from) in the tooltip.
    const channels = g ? (g.channels || []).map((c) => CHANNEL_GLYPH[c] || '•').join('') : '';
    const lineage = g && g.touched_by && g.touched_by.length
      ? ` | stained by: ${g.touched_by.map((t) => baseLabel(t)).join(', ')}`
      : '';
    const agents = g && g.sub_agents && g.sub_agents.length
      ? ` | via sub-agent: ${g.sub_agents.join(', ')}`
      : '';
    const badge = g
      ? `<span class="trail-badge" title="${esc(g.touch_count)} touches${esc(lineage)}${esc(agents)}">${esc(channels)} ${esc(g.touch_count)}</span>`
      : '';
    return `<div class="stain" style="background:${color};flex-basis:${size}px;" title="${esc(p)} - worst outcome: ${esc(info.worstOutcome)}, touched ${info.touches}x${esc(lineage)}${esc(agents)}">
      <span class="stain-label">${esc(baseLabel(p))}</span>
      ${badge}
    </div>`;
  });
  return `<div class="file-grid">${items.join('\n')}</div>`;
}

// One row of the complete-trail stream: every action, in order, fully shown.
function renderTrailEntry(t) {
  const color = CHANNEL_COLORS[t.channel] || '#90a4ae';
  const glyph = CHANNEL_GLYPH[t.channel] || '•';
  const label =
    t.path ? esc(t.path) :
    t.host ? esc(t.host) :
    t.command ? esc(t.command.length > 90 ? t.command.slice(0, 90) + '…' : t.command) :
    t.target ? esc(t.target) :
    esc(t.key);
  const meta = [];
  if (typeof t.exit_code === 'number') meta.push(`exit ${t.exit_code}`);
  if (typeof t.diff_volume === 'number') meta.push(`${t.diff_volume} lines`);
  if (typeof t.bytes === 'number') meta.push(`${t.bytes} B`);
  if (t.source === 'fs-sentinel') meta.push('disk-observed');
  if (t.output_path) meta.push('full output saved');
  if (t.hash) meta.push(`sha ${t.hash.slice(0, 8)}`);
  const metaStr = meta.length ? ` <span class="dim">(${esc(meta.join(', '))})</span>` : '';
  const fail = t.failed ? ` <span class="trail-fail">FAILED</span>` : '';
  // Attribute the touch to a sub-agent (Task/sidechain) when the hook fired
  // inside one; main-thread touches carry nothing, so they read clean.
  const agentTag = t.sub_agent_id
    ? ` <span class="sub-agent" title="${esc(t.sub_agent_id)}">via ${esc(t.sub_agent_type || 'sub-agent')}</span>`
    : '';
  return `<div class="trail-row" style="border-left-color:${color}">
    <span class="trail-glyph" style="color:${color}">${esc(glyph)}</span>
    <span class="trail-channel" style="color:${color}">${esc(t.channel)}</span>
    <span class="trail-label">${label}${fail}</span>${agentTag}${metaStr}
  </div>`;
}

// The glove's per-turn complete trail + lineage edges. This is the "everything
// is documented" half of the one global truth.
function renderTrailTurn(turn) {
  const rows = (turn.trail || []).map(renderTrailEntry).join('\n') || '<p class="dim">No touches in this turn.</p>';
  const edges = (turn.edges || []).slice(0, 200).map((e) =>
    `<div class="edge"><code>${esc(baseLabel(e.from))}</code> &rarr; <code>${esc(baseLabel(e.to))}</code> <span class="dim">${esc(e.kind)} (inferred)</span></div>`
  ).join('\n');
  const touches = (turn.trail || []).length;
  return `<details class="turn trail-turn">
    <summary>Turn ${esc(turn.turn_id)} &mdash; ${touches} touches across ${(turn.artifacts || []).length} artifacts</summary>
    ${turn.prompt ? `<div class="prompt">&ldquo;${esc(turn.prompt.slice(0, 240))}${turn.prompt.length > 240 ? '…' : ''}&rdquo;</div>` : ''}
    <h4>Complete trail (every action, in order)</h4>
    ${rows}
    ${edges ? `<h4>Lineage (turn-scoped, inferred &mdash; not proven data-flow)</h4>${edges}` : ''}
  </details>`;
}

function renderTrailSection(trail) {
  if (!trail || !trail.turns || !trail.turns.length) return '';
  const t = trail.totals || {};
  return `
  <h2 class="trail-h">The glove &mdash; complete trail</h2>
  <p class="dim">Everything the agent touched, stained on contact: ${esc(t.touches || 0)} touches across ${esc(t.artifacts || 0)} artifacts in ${esc(t.turns || 0)} turns. Lineage edges below are a <strong>turn-scoped heuristic</strong> (a read + a write in the same turn is shown as an inferred touch, not proven data-flow).</p>
  ${trail.turns.map(renderTrailTurn).join('\n')}
  `;
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

// Flatten buildFileStains' Map<path,{worstOutcome,touches}> into the
// Map<path, outcome-string> shape the visual layer's buildVizData expects, so
// every node/line/bar can be colored by the orunmila stain (stain-first).
function stainByKeyFrom(files) {
  const m = new Map();
  for (const [p, info] of files.entries()) m.set(p, info.worstOutcome);
  return m;
}

function renderSessionHtml(sessionId, reports, trail) {
  const files = buildFileStains(reports);
  const trailByPath = indexTrailByPath(trail);
  // The rich, tabbed, stain-first visual (Graph/Tree/Timeline/Dashboard). Only
  // built when a trail model is present; `orunmila html` (no trail) is untouched.
  const visualBlock = trail && trail.turns && trail.turns.length
    ? renderTrailVisual(buildVizData(trail, stainByKeyFrom(files)))
    : '';
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
  /* trail (the glove) */
  .stain { position:relative; }
  .trail-badge { position:absolute; top:5px; right:6px; font-size:0.66rem; background:rgba(0,0,0,0.55); padding:1px 5px; border-radius:8px; }
  h2.trail-h { margin-top:36px; font-size:1.15rem; border-top:1px solid #333; padding-top:24px; }
  details.trail-turn { background:#161616; }
  .trail-turn .prompt { color:#9ad; font-size:0.85rem; margin:6px 0 4px; }
  .trail-row { display:flex; align-items:baseline; gap:8px; border-left:3px solid #555; padding:3px 10px; margin:2px 0; background:#161616; border-radius:4px; font-size:0.85rem; }
  .trail-glyph { width:1.2em; text-align:center; }
  .trail-channel { width:5.5em; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; }
  .trail-label { font-family: ui-monospace, Menlo, monospace; word-break:break-all; }
  .trail-fail { color:#ff5252; font-weight:700; font-size:0.72rem; }
  .sub-agent { color:#ba68c8; font-size:0.7rem; font-weight:600; }
  .edge { font-size:0.82rem; margin:2px 0; color:#ccc; }
  .edge code { background:#222; padding:1px 5px; border-radius:4px; }
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

  <h4>Where the agent actually went (color = worst outcome; badge = glove touch count + channels)</h4>
  ${renderFileGrid(files, trailByPath)}

  ${visualBlock}

  ${renderTrailSection(trail)}

  <h2 class="trail-h">orunmila &mdash; claim vs. reality</h2>
  <p class="dim">The skeptical lens: only mismatches between what was claimed and what the evidence shows.</p>
  <h4>Turn by turn</h4>
  ${reports.map(renderTurn).join('\n')}
</body>
</html>`;
}

module.exports = { renderSessionHtml };
