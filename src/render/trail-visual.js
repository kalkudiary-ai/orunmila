'use strict';

const STAIN_COLORS = {
  untracked_write: '#ff1744',
  phantom_verification: '#d50000',
  phantom: '#ff5252',
  silently_dropped: '#aa00ff',
  undisclosed: '#d500f9',
  partial: '#ffd600',
  unverifiable: '#9e9e9e',
  verified: '#00e676',
  clean: '#00e676',
};

const CHANNEL_COLORS = {
  read: '#40c4ff',
  write: '#69f0ae',
  disk: '#1de9b6',
  command: '#ffab40',
  network: '#e040fb',
  tool: '#b0bec5',
};

const CHANNEL_GLYPH = { read: '\u{1F441}', write: '✎', disk: '\u{1F4BE}', command: '$', network: '\u{1F310}', tool: '⚙' };

const EXPLAIN = {
  verified: 'The agent said it did this, and the evidence backs it up.',
  partial: 'Touched, but the change looks like scaffolding only.',
  phantom: 'Claimed, but nothing in the session actually did it.',
  phantom_verification: 'Claimed it was tested/works, but no passing check ran.',
  unverifiable: 'The claim was too vague to check.',
  undisclosed: 'This file changed but no claim or request mentioned it.',
  silently_dropped: 'Part of your request that was never done or mentioned again.',
  untracked_write: 'The disk changed but no tool call ever disclosed it.',
  clean: 'Touched during the session; nothing flagged.',
  read: 'A file the agent read (a source of information).',
  write: 'A file the agent changed.',
  disk: 'A change seen directly on disk by the independent watcher.',
  command: 'A shell command the agent ran.',
  network: 'The agent reached out to the internet.',
  tool: 'Another tool the agent used.',
};

function buildVizData(model, stainByKey, reports) {
  const nodes = [];
  const seen = new Map();
  const nodeIndex = (key) => {
    if (seen.has(key)) return seen.get(key);
    const i = nodes.length;
    seen.set(key, i);
    nodes.push(null);
    return i;
  };

  for (const a of model.artifacts || []) {
    const i = nodeIndex(a.key);
    const stain = (stainByKey && (stainByKey.get(a.path) || stainByKey.get(a.key))) || null;
    const primaryChannel = (a.channels && a.channels[0]) || 'tool';
    nodes[i] = {
      id: i, key: a.key, label: a.label || a.key, path: a.path || null,
      channels: a.channels || [], primaryChannel,
      touches: a.touch_count || 0, stain,
      tainted_by: (a.touched_by || []).length,
    };
  }

  const edgeSet = new Map();
  const trail = [];
  for (const t of model.turns || []) {
    for (const e of t.edges || []) {
      const fi = nodeIndex(e.from);
      const ti = nodeIndex(e.to);
      const k = fi + '->' + ti;
      edgeSet.set(k, { from: fi, to: ti, kind: e.kind });
    }
    for (const row of t.trail || []) {
      trail.push({
        turn: t.turn_id, key: row.key, node: nodeIndex(row.key),
        channel: row.channel,
        label: row.path || row.host || row.command || row.target || row.key,
        failed: !!row.failed,
        stain: (stainByKey && (stainByKey.get(row.path) || stainByKey.get(row.key))) || null,
      });
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i]) {
      const key = [...seen.entries()].find(([, idx]) => idx === i)[0];
      nodes[i] = { id: i, key, label: key, path: null, channels: ['tool'], primaryChannel: 'tool', touches: 0, stain: null, tainted_by: 0 };
    }
  }

  const turns = (model.turns || []).map((t) => ({
    turn_id: t.turn_id, prompt: t.prompt || '', touches: (t.trail || []).length,
  }));

  const channelTally = {};
  const stainTally = {};
  for (const n of nodes) {
    channelTally[n.primaryChannel] = (channelTally[n.primaryChannel] || 0) + 1;
    const s = n.stain || 'clean';
    stainTally[s] = (stainTally[s] || 0) + 1;
  }

  // Extract findings from reconciliation reports for the Report tab
  const findings = [];
  if (reports && reports.length) {
    for (const r of reports) {
      for (const c of (r.claims || [])) {
        if (c.outcome === 'phantom' || c.outcome === 'phantom_verification' || c.outcome === 'partial') {
          const paths = (c.evidence || []).filter(e => e.path).map(e => e.path);
          const targets = (c.claim.targets || []).map(t => t.raw || t.value);
          findings.push({
            type: c.outcome,
            turn: r.turn_id,
            text: c.claim.text,
            targets: targets,
            paths: paths,
            verificationClaim: c.claim.verificationClaim || false,
          });
        }
      }
      for (const st of (r.subtasks || [])) {
        if (st.outcome === 'silently_dropped') {
          findings.push({
            type: 'silently_dropped',
            turn: r.turn_id,
            text: st.task.text,
            targets: (st.task.targets || []).map(t => t.raw || t.value),
            paths: [],
          });
        }
      }
      for (const u of (r.undisclosed || [])) {
        findings.push({
          type: 'undisclosed',
          turn: r.turn_id,
          text: u.path,
          targets: [],
          paths: [u.path],
        });
      }
      for (const u of (r.untracked || [])) {
        findings.push({
          type: 'untracked_write',
          turn: r.turn_id,
          text: u.rel_path || u.path,
          targets: [],
          paths: [u.rel_path || u.path],
        });
      }
    }
  }

  return {
    session: model.session_id,
    totals: model.totals || { turns: turns.length, artifacts: nodes.length, touches: trail.length },
    nodes, edges: [...edgeSet.values()], trail, turns,
    channelTally, stainTally, findings,
    palette: { stain: STAIN_COLORS, channel: CHANNEL_COLORS, glyph: CHANNEL_GLYPH, explain: EXPLAIN },
  };
}

function renderTrailVisual(vizData) {
  const json = JSON.stringify(vizData)
    .replace(/</g, '\\u003c')
    .replace(/`/g, '\\u0060')
    .replace(/\$/g, '\\u0024')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `
<style>
  .gv { background:#0c0e12; border:1px solid #1f2630; border-radius:14px; padding:0; margin:18px 0 34px; overflow:hidden; }
  .gv-top { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; background:linear-gradient(90deg,#11151c,#0c0e12); border-bottom:1px solid #1f2630; flex-wrap:wrap; }
  .gv-title { font-weight:700; font-size:1.05rem; letter-spacing:.02em; }
  .gv-title small { color:#7d8694; font-weight:400; }
  .gv-controls { display:flex; gap:8px; align-items:center; }
  .gv-seg { display:flex; background:#0c0e12; border:1px solid #28313d; border-radius:10px; overflow:hidden; }
  .gv-seg button { background:transparent; color:#9aa6b2; border:0; padding:7px 13px; font-size:.82rem; cursor:pointer; font-weight:600; }
  .gv-seg button.on { background:#1c2530; color:#fff; }
  .gv-tabs { display:flex; gap:6px; padding:10px 18px 0; flex-wrap:wrap; }
  .gv-tab { background:#11151c; color:#9aa6b2; border:1px solid #1f2630; border-bottom:none; border-radius:9px 9px 0 0; padding:9px 16px; cursor:pointer; font-weight:600; font-size:.86rem; }
  .gv-tab.on { background:#161c25; color:#fff; box-shadow:inset 0 2px 0 #00e676; }
  .gv-stage { background:#0a0c10; min-height:440px; padding:16px 18px; position:relative; }
  .gv-view { display:none; }
  .gv-view.on { display:block; }

  /* filter bar */
  .gv-filters { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px; align-items:center; }
  .gv-filters .lbl { font-size:.72rem; color:#6f7b88; text-transform:uppercase; letter-spacing:.06em; font-weight:600; margin-right:4px; }
  .gv-fbtn { background:#11151c; color:#9aa6b2; border:1px solid #28313d; border-radius:7px; padding:4px 10px; font-size:.74rem; cursor:pointer; font-weight:600; display:flex; align-items:center; gap:5px; transition:all .1s; }
  .gv-fbtn:hover { border-color:#40c4ff; }
  .gv-fbtn.on { background:#1c2530; color:#fff; border-color:#40c4ff; }
  .gv-fbtn .fdot { width:8px; height:8px; border-radius:50%; }

  /* legend */
  .gv-legend { display:flex; gap:14px; flex-wrap:wrap; margin:4px 0 14px; font-size:.78rem; color:#aeb8c4; }
  .gv-legend .it { display:flex; align-items:center; gap:6px; }
  .gv-dot { width:11px; height:11px; border-radius:50%; box-shadow:0 0 8px currentColor; }
  .gv-hint { color:#7d8694; font-size:.82rem; margin:0 0 12px; }
  .gv-explainable .gv-hint { display:block; }
  .gv-power .gv-hint { display:none; }
  .gv-power .gv-legend .lbl-long { display:none; }
  .gv-explainable .gv-legend .lbl-short { display:none; }

  /* graph svg */
  svg.gv-svg { width:100%; height:520px; display:block; background:radial-gradient(circle at 50% 40%,#0e1219,#070809); border-radius:10px; cursor:grab; }
  svg.gv-svg:active { cursor:grabbing; }
  .gv-node { cursor:pointer; }
  .gv-node circle { transition:r .12s, filter .12s; }
  .gv-node:hover circle { filter:brightness(1.4); }
  .gv-edge { stroke-opacity:.06; transition:stroke-opacity .1s, stroke-width .1s; }
  .gv-edge.hot { stroke-opacity:.85; stroke-width:2.1; }
  .gv-gctl { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
  .gv-gbtn { background:#11151c; color:#9aa6b2; border:1px solid #28313d; border-radius:8px; padding:5px 11px; font-size:.78rem; cursor:pointer; font-weight:600; }
  .gv-gbtn.on { background:#1c2530; color:#fff; }
  .gv-gcount { color:#6f7b88; font-size:.76rem; }
  .gv-zoom-ctrl { display:flex; gap:4px; margin-left:auto; }
  .gv-zoom-ctrl button { background:#11151c; color:#9aa6b2; border:1px solid #28313d; border-radius:6px; width:28px; height:28px; cursor:pointer; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; }
  .gv-zoom-ctrl button:hover { color:#fff; border-color:#40c4ff; }
  .gv-search { background:#11151c; color:#e7edf3; border:1px solid #28313d; border-radius:7px; padding:5px 10px; font-size:.78rem; width:160px; outline:none; margin-left:8px; }
  .gv-search:focus { border-color:#40c4ff; }
  .gv-search::placeholder { color:#6f7b88; }
  .gv-edge-label { font-size:8px; fill:#6f7b88; pointer-events:none; opacity:0; transition:opacity .1s; }
  .gv-edge.hot + .gv-edge-label, .gv-svg:hover .gv-edge-label { opacity:1; }

  /* 3D container */
  .gv-3d-wrap { width:100%; height:520px; border-radius:10px; overflow:hidden; position:relative; background:#070809; }
  .gv-3d-wrap canvas { display:block; width:100%!important; height:100%!important; }

  /* detail panel */
  .gv-detail { background:#0e1219; border:1px solid #1f2630; border-radius:10px; padding:14px 18px; margin:12px 0 0; animation:gv-slide .15s ease-out; }
  @keyframes gv-slide { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
  .gv-detail h4 { margin:0 0 8px; font-size:.88rem; font-weight:600; color:#e7edf3; }
  .gv-detail .close { float:right; background:none; border:none; color:#7d8694; cursor:pointer; font-size:16px; padding:0 4px; }
  .gv-detail .close:hover { color:#fff; }
  .gv-detail .d-row { display:flex; gap:10px; align-items:center; padding:4px 0; font-size:.82rem; }
  .gv-detail .d-tag { font-size:.7rem; font-weight:600; padding:2px 8px; border-radius:8px; color:#fff; text-transform:uppercase; }
  .gv-detail .d-text { color:#cfd8e3; flex:1; }
  .gv-detail .d-meta { color:#6f7b88; font-size:.76rem; }

  /* legend box */
  .gv-legbox { margin:2px 0 12px; }
  .gv-legbox summary { color:#7d8694; font-size:.78rem; cursor:pointer; font-weight:600; list-style:none; }
  .gv-legbox summary::before { content:'\\25B8 '; }
  .gv-legbox[open] summary::before { content:'\\25BE '; }
  .gv-legbox .gv-legend { margin-top:8px; }

  /* tooltip */
  .gv-tip { position:absolute; pointer-events:none; background:#0b0e13; border:1px solid #2a3340; border-radius:8px; padding:8px 11px; font-size:.8rem; color:#e7edf3; max-width:300px; box-shadow:0 8px 26px rgba(0,0,0,.6); opacity:0; transition:opacity .1s; z-index:5; }
  .gv-tip b { color:#fff; } .gv-tip .ex { color:#9ad; display:block; margin-top:4px; }

  /* tree */
  .gv-tree { font-family:ui-monospace,Menlo,monospace; font-size:.86rem; line-height:1.7; }
  .gv-tree .row { display:flex; align-items:center; gap:8px; padding:1px 0; cursor:pointer; border-radius:4px; }
  .gv-tree .row:hover { background:#11151c; }
  .gv-tree .bar { height:9px; border-radius:5px; box-shadow:0 0 8px currentColor; }
  .gv-tree .nm { color:#cfd8e3; } .gv-tree .dir { color:#6f7b88; }

  /* timeline */
  .gv-time { display:flex; gap:18px; overflow-x:auto; padding-bottom:10px; scroll-behavior:smooth; }
  .gv-time::-webkit-scrollbar { height:6px; }
  .gv-time::-webkit-scrollbar-track { background:#0a0c10; border-radius:3px; }
  .gv-time::-webkit-scrollbar-thumb { background:#28313d; border-radius:3px; }
  .gv-time::-webkit-scrollbar-thumb:hover { background:#40c4ff; }
  .gv-tcol { min-width:150px; flex:0 0 auto; }
  .gv-tcol h5 { margin:0 0 8px; font-size:.78rem; color:#9aa6b2; font-weight:700; }
  .gv-tcol .prompt { color:#6f7b88; font-size:.72rem; margin-bottom:8px; min-height:2.2em; }
  .gv-tdot { display:flex; align-items:center; gap:7px; padding:4px 7px; border-radius:7px; background:#0e1219; margin:3px 0; font-size:.76rem; cursor:pointer; transition:background .1s; }
  .gv-tdot:hover { background:#161c25; }
  .gv-tdot .pip { width:9px; height:9px; border-radius:50%; box-shadow:0 0 7px currentColor; flex:0 0 auto; }
  .gv-tdot .tx { color:#c4cdd8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* dashboard */
  .gv-dash { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:18px; }
  .gv-card { background:#0e1219; border:1px solid #1f2630; border-radius:12px; padding:16px; }
  .gv-card h5 { margin:0 0 12px; font-size:.82rem; color:#aeb8c4; text-transform:uppercase; letter-spacing:.04em; }
  .gv-bars .b { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:.8rem; }
  .gv-bars .b .fill { height:14px; border-radius:4px; box-shadow:0 0 8px currentColor; }
  .gv-bars .b .v { color:#9aa6b2; min-width:1.6em; }
  .gv-kpi { display:flex; gap:22px; }
  .gv-kpi .k { text-align:center; } .gv-kpi .k .n { font-size:1.9rem; font-weight:800; } .gv-kpi .k .l { font-size:.72rem; color:#7d8694; text-transform:uppercase; }
  .gv-donut-wrap { display:flex; align-items:center; gap:18px; }
  .gv-donut-legend { font-size:.78rem; color:#aeb8c4; }
  .gv-donut-legend .it { display:flex; align-items:center; gap:6px; margin:3px 0; }

  /* report tab */
  .gv-report-section { margin-bottom:20px; }
  .gv-report-section h4 { margin:0 0 10px; font-size:.88rem; font-weight:600; color:#e7edf3; display:flex; align-items:center; gap:8px; }
  .gv-report-section h4 .cnt { font-size:.72rem; background:#1c2530; color:#9aa6b2; padding:2px 8px; border-radius:10px; font-weight:600; }
  .gv-finding { display:flex; gap:10px; align-items:flex-start; padding:8px 12px; margin:4px 0; background:#0e1219; border-left:3px solid #888; border-radius:0 6px 6px 0; font-size:.82rem; }
  .gv-finding .f-tag { font-size:.68rem; font-weight:700; padding:2px 8px; border-radius:8px; color:#fff; text-transform:uppercase; white-space:nowrap; flex-shrink:0; margin-top:1px; }
  .gv-finding .f-text { color:#cfd8e3; line-height:1.5; }
  .gv-finding .f-meta { color:#6f7b88; font-size:.74rem; }
  .gv-prompt-wrap { position:relative; }
  .gv-prompt { background:#0e1219; border:1px solid #1f2630; border-radius:10px; padding:16px; font-family:ui-monospace,Menlo,monospace; font-size:.78rem; color:#cfd8e3; white-space:pre-wrap; line-height:1.6; max-height:400px; overflow-y:auto; cursor:text; user-select:all; }
  .gv-prompt::-webkit-scrollbar { width:6px; }
  .gv-prompt::-webkit-scrollbar-track { background:#0a0c10; }
  .gv-prompt::-webkit-scrollbar-thumb { background:#28313d; border-radius:3px; }
  .gv-copy-btn { position:absolute; top:8px; right:8px; background:#1c2530; color:#9aa6b2; border:1px solid #28313d; border-radius:8px; padding:6px 14px; font-size:.78rem; cursor:pointer; font-weight:600; display:flex; align-items:center; gap:6px; z-index:2; }
  .gv-copy-btn:hover { color:#fff; border-color:#40c4ff; }
  .gv-copy-btn.copied { color:#00e676; border-color:#00e676; }
  .gv-summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-bottom:20px; }
  .gv-summary-stat { background:#0e1219; border:1px solid #1f2630; border-radius:10px; padding:12px 16px; text-align:center; }
  .gv-summary-stat .n { font-size:1.6rem; font-weight:800; }
  .gv-summary-stat .l { font-size:.72rem; color:#7d8694; text-transform:uppercase; margin-top:2px; }
  .gv-nothing { text-align:center; color:#00e676; padding:40px; font-size:.92rem; }
</style>

<div class="gv gv-explainable" id="gv-root">
  <div class="gv-top">
    <div class="gv-title">Session map <small id="gv-sub"></small></div>
    <div class="gv-controls">
      <div class="gv-seg" id="gv-aud">
        <button data-aud="explain" class="on">Explain it to me</button>
        <button data-aud="power">Power user</button>
      </div>
    </div>
  </div>
  <div class="gv-tabs" id="gv-tabs">
    <button class="gv-tab on" data-view="timeline">Timeline</button>
    <button class="gv-tab" data-view="tree">Tree</button>
    <button class="gv-tab" data-view="graph">Graph</button>
    <button class="gv-tab" data-view="graph3d">3D Graph</button>
    <button class="gv-tab" data-view="dashboard">Dashboard</button>
    <button class="gv-tab" data-view="report">Report</button>
    <button class="gv-tab" data-view="glossary">Glossary</button>
  </div>
  <div class="gv-stage">
    <p class="gv-hint" id="gv-hint"></p>
    <div class="gv-view on" data-view="timeline" id="gv-timeline"></div>
    <div class="gv-view" data-view="tree" id="gv-tree"></div>
    <div class="gv-view" data-view="graph" id="gv-graph"></div>
    <div class="gv-view" data-view="graph3d" id="gv-graph3d"></div>
    <div class="gv-view" data-view="dashboard" id="gv-dashboard"></div>
    <div class="gv-view" data-view="report" id="gv-report"></div>
    <div class="gv-view" data-view="glossary" id="gv-glossary"></div>
    <div class="gv-tip" id="gv-tip"></div>
    <div id="gv-detail-slot"></div>
  </div>
</div>

<script>
(function(){
  var DATA = ${json};
  var P = DATA.palette;
  function colorOf(stain, channel){ return (stain && P.stain[stain]) || P.channel[channel] || '#888'; }
  function explainOf(stain, channel){ return (stain && P.explain[stain]) || P.explain[channel] || ''; }
  var root = document.getElementById('gv-root');
  var tip = document.getElementById('gv-tip');
  var detailSlot = document.getElementById('gv-detail-slot');
  document.getElementById('gv-sub').textContent = DATA.totals.touches + ' touches / ' + DATA.totals.artifacts + ' things / ' + DATA.totals.turns + ' turns';

  // ---- FILTER STATE ----
  var channelFilters = { read:true, write:true, disk:true, command:true, network:true, tool:true };
  var stainFilters = { verified:true, partial:true, phantom:true, phantom_verification:true, unverifiable:true, undisclosed:true, untracked_write:true, silently_dropped:true, clean:true };

  function nodePassesFilter(n) {
    var chOk = n.channels.some(function(c){ return channelFilters[c]; }) || channelFilters[n.primaryChannel];
    var stOk = stainFilters[n.stain || 'clean'];
    return chOk && stOk;
  }
  function trailPassesFilter(r) {
    return channelFilters[r.channel] && stainFilters[r.stain || 'clean'];
  }

  function renderFilterBar(target) {
    var chans = ['read','write','disk','command','network','tool'];
    var stains = ['verified','partial','phantom','phantom_verification','undisclosed','untracked_write'];
    var html = '<div class="gv-filters"><span class="lbl">Channel</span>';
    chans.forEach(function(c){
      html += '<button class="gv-fbtn'+(channelFilters[c]?' on':'')+'" data-ftype="channel" data-fkey="'+c+'">'
        + '<span class="fdot" style="background:'+P.channel[c]+'"></span>'+c+'</button>';
    });
    html += '<span class="lbl" style="margin-left:10px">Outcome</span>';
    stains.forEach(function(s){
      html += '<button class="gv-fbtn'+(stainFilters[s]?' on':'')+'" data-ftype="stain" data-fkey="'+s+'">'
        + '<span class="fdot" style="background:'+(P.stain[s]||'#888')+'"></span>'+s.replace(/_/g,' ')+'</button>';
    });
    html += '</div>';
    return html;
  }

  function bindFilters(el, rerender) {
    el.querySelectorAll('.gv-fbtn').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        var ftype = b.dataset.ftype, fkey = b.dataset.fkey;
        if (ftype === 'channel') channelFilters[fkey] = !channelFilters[fkey];
        else stainFilters[fkey] = !stainFilters[fkey];
        b.classList.toggle('on');
        rerender();
      });
    });
  }

  var HINTS = {
    graph: 'Each dot is something the agent touched. Hover to light up connections, click for details. Scroll to zoom, drag to pan. Filter by channel or outcome above.',
    graph3d: 'Drag to rotate, scroll to zoom, click a node for details. Loads a small 3D library from a CDN — needs internet.',
    glossary: 'What every color, label, and metric means.',
    tree: 'Your project as folders. Each bar glows by how the agent touched that file. Click a file for details.',
    timeline: 'The session left to right, one column per turn. Click any pip for details.',
    dashboard: 'The numbers at a glance: outcome proportions, channel breakdown, busiest turns, and most-touched things.',
    report: 'Everything the agent got wrong, plus a ready-to-paste prompt to send it back to fix its mistakes.'
  };
  function setHint(v){ document.getElementById('gv-hint').textContent = HINTS[v] || ''; }

  function tipShow(html, x, y){ tip.innerHTML = html; tip.style.opacity='1'; tip.style.left=(x+14)+'px'; tip.style.top=(y+10)+'px'; }
  function tipHide(){ tip.style.opacity='0'; }
  function stageXY(e){ var r = root.querySelector('.gv-stage').getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; }

  // ---- DETAIL PANEL ----
  function showDetail(nd) {
    var c = colorOf(nd.stain, nd.primaryChannel);
    var outcomeLabel = (nd.stain || nd.primaryChannel).replace(/_/g, ' ');
    var trails = DATA.trail.filter(function(r){ return r.node === nd.id; });
    var html = '<div class="gv-detail"><button class="close" id="gv-detail-close">&times;</button>';
    html += '<h4 style="color:'+c+'">'+escjs(nd.label)+'</h4>';
    html += '<div class="d-row"><span class="d-tag" style="background:'+c+'">'+escjs(outcomeLabel)+'</span>';
    html += '<span class="d-meta">'+nd.touches+' touches &middot; '+nd.channels.join(', ')+'</span></div>';
    if (nd.stain) html += '<div class="d-row"><span class="d-text" style="color:#9ad">'+escjs(explainOf(nd.stain, nd.primaryChannel))+'</span></div>';
    if (trails.length) {
      html += '<div style="margin-top:10px;font-size:.76rem;color:#7d8694;font-weight:600;">ACTIVITY LOG</div>';
      trails.forEach(function(r){
        var rc = colorOf(r.stain, r.channel);
        html += '<div class="d-row"><span class="fdot" style="width:8px;height:8px;border-radius:50%;background:'+rc+';flex:0 0 auto"></span>';
        html += '<span class="d-text">'+escjs(r.channel)+' &middot; turn '+escjs(r.turn)+'</span>';
        if (r.failed) html += '<span style="color:#ff5252;font-size:.72rem;font-weight:700">FAILED</span>';
        html += '</div>';
      });
    }
    var edges = DATA.edges.filter(function(e){ return e.from===nd.id || e.to===nd.id; });
    if (edges.length) {
      html += '<div style="margin-top:10px;font-size:.76rem;color:#7d8694;font-weight:600;">CONNECTIONS</div>';
      edges.forEach(function(e){
        var other = e.from === nd.id ? DATA.nodes[e.to] : DATA.nodes[e.from];
        var dir = e.from === nd.id ? '\\u2192' : '\\u2190';
        html += '<div class="d-row"><span class="d-text">'+dir+' '+escjs(other.label)+' <span style="color:#6f7b88">('+escjs(e.kind)+')</span></span></div>';
      });
    }
    html += '</div>';
    detailSlot.innerHTML = html;
    document.getElementById('gv-detail-close').addEventListener('click', function(){ detailSlot.innerHTML = ''; });
  }

  function showTrailDetail(r) {
    var nd = DATA.nodes[r.node];
    if (nd) { showDetail(nd); return; }
    var c = colorOf(r.stain, r.channel);
    var html = '<div class="gv-detail"><button class="close" id="gv-detail-close">&times;</button>';
    html += '<h4 style="color:'+c+'">'+escjs(r.label)+'</h4>';
    html += '<div class="d-row"><span class="d-tag" style="background:'+c+'">'+escjs(r.channel)+'</span>';
    html += '<span class="d-meta">Turn '+escjs(r.turn)+'</span></div>';
    if (r.stain) html += '<div class="d-row"><span class="d-text" style="color:#9ad">'+escjs(explainOf(r.stain, r.channel))+'</span></div>';
    html += '</div>';
    detailSlot.innerHTML = html;
    document.getElementById('gv-detail-close').addEventListener('click', function(){ detailSlot.innerHTML = ''; });
  }

  // ---- GRAPH (2D radial + zoom/pan) ----
  var graphMode = 'flagged';
  var vb = { x:0, y:0, w:900, h:520 };

  function renderGraph(){
    var el = document.getElementById('gv-graph');
    var W=900, H=520, cx=W/2, cy=H/2;
    vb = { x:0, y:0, w:W, h:H };

    var filtered = DATA.nodes.filter(nodePassesFilter);
    var stainedCount = filtered.filter(function(n){return n.stain;}).length;
    var keep = {};
    if (graphMode==='flagged' && stainedCount){
      filtered.forEach(function(n){ if(n.stain) keep[n.id]=true; });
      DATA.edges.forEach(function(e){ if(keep[e.from]||keep[e.to]){ keep[e.from]=true; keep[e.to]=true; } });
    } else {
      filtered.forEach(function(n){ keep[n.id]=true; });
    }
    var visible = DATA.nodes.filter(function(n){ return keep[n.id] && nodePassesFilter(n); });
    var m = visible.length || 1;

    var maxT = Math.max.apply(null, visible.map(function(x){return x.touches;}).concat([1]));
    var positions = {};
    visible.forEach(function(nd, k){
      var ang = (k / m) * Math.PI * 2 - Math.PI/2;
      var rad = 70 + (1 - nd.touches/maxT) * 150;
      positions[nd.id] = { x: cx + Math.cos(ang)*rad, y: cy + Math.sin(ang)*rad };
    });

    var controls = renderFilterBar('graph');
    controls += '<div class="gv-gctl">'
      + '<button class="gv-gbtn'+(graphMode==='flagged'?' on':'')+'" data-gmode="flagged">Flagged only</button>'
      + '<button class="gv-gbtn'+(graphMode==='all'?' on':'')+'" data-gmode="all">Everything</button>'
      + '<span class="gv-gcount">'+visible.length+' of '+DATA.nodes.length+' things'
      + (graphMode==='flagged'&&!stainedCount ? ' &middot; nothing flagged, showing all' : '')+'</span>'
      + '<input class="gv-search" id="gv-search" placeholder="Search files\\u2026" autocomplete="off">'
      + '<div class="gv-zoom-ctrl"><button id="gv-zin" title="Zoom in">+</button><button id="gv-zout" title="Zoom out">&minus;</button><button id="gv-zreset" title="Reset view">&#8634;</button></div>'
      + '</div>';

    var svg = '<svg class="gv-svg" id="gv-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">';
    DATA.edges.forEach(function(e){
      if(!keep[e.from]||!keep[e.to]) return;
      if(!nodePassesFilter(DATA.nodes[e.from]) || !nodePassesFilter(DATA.nodes[e.to])) return;
      var a=positions[e.from], b=positions[e.to]; if(!a||!b) return;
      var c = colorOf(DATA.nodes[e.to].stain, DATA.nodes[e.to].channels[0]);
      svg += '<path class="gv-edge" data-from="'+e.from+'" data-to="'+e.to+'" data-kind="'+escjs(e.kind)+'" d="M'+a.x.toFixed(1)+' '+a.y.toFixed(1)+' Q '+cx+' '+cy+' '+b.x.toFixed(1)+' '+b.y.toFixed(1)+'" fill="none" stroke="'+c+'" stroke-width="1.3"/>';
      var mx = (a.x+b.x)/2*0.5 + cx*0.5, my = (a.y+b.y)/2*0.5 + cy*0.5;
      svg += '<text class="gv-edge-label" x="'+mx.toFixed(1)+'" y="'+my.toFixed(1)+'" text-anchor="middle">'+escjs(e.kind)+'</text>';
    });
    visible.forEach(function(nd){
      var p=positions[nd.id]; var c=colorOf(nd.stain, nd.primaryChannel);
      var r = 6 + Math.min(18, nd.touches*1.4);
      var g = P.glyph[nd.primaryChannel] || '';
      svg += '<g class="gv-node" data-i="'+nd.id+'" transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')">';
      svg += '<circle r="'+r+'" fill="'+c+'" fill-opacity="0.28" stroke="'+c+'" stroke-width="1.8" style="filter:drop-shadow(0 0 6px '+c+')"/>';
      svg += '<text text-anchor="middle" dy="3" font-size="11" fill="#dfe7ef">'+g+'</text>';
      svg += '<text text-anchor="middle" y="'+(r+12)+'" font-size="9.5" fill="#8d99a6">'+escjs(trunc(nd.label,16))+'</text>';
      svg += '</g>';
    });
    svg += '</svg>';
    el.innerHTML = legend() + controls + svg;

    // zoom/pan
    var svgEl = document.getElementById('gv-svg');
    var dragging = false, dragStart = {};
    svgEl.addEventListener('wheel', function(e){
      e.preventDefault();
      var scale = e.deltaY > 0 ? 1.12 : 0.89;
      var rect = svgEl.getBoundingClientRect();
      var mx = (e.clientX - rect.left) / rect.width * vb.w + vb.x;
      var my = (e.clientY - rect.top) / rect.height * vb.h + vb.y;
      vb.w *= scale; vb.h *= scale;
      vb.x = mx - (mx - vb.x) * scale;
      vb.y = my - (my - vb.y) * scale;
      svgEl.setAttribute('viewBox', vb.x+' '+vb.y+' '+vb.w+' '+vb.h);
    });
    svgEl.addEventListener('mousedown', function(e){
      if (e.button !== 0) return;
      var target = e.target.closest('.gv-node');
      if (target) return;
      dragging = true;
      dragStart = {x:e.clientX, y:e.clientY, vbx:vb.x, vby:vb.y};
      e.preventDefault();
    });
    svgEl.addEventListener('mousemove', function(e){
      if (!dragging) return;
      var rect = svgEl.getBoundingClientRect();
      var dx = (e.clientX - dragStart.x) / rect.width * vb.w;
      var dy = (e.clientY - dragStart.y) / rect.height * vb.h;
      vb.x = dragStart.vbx - dx;
      vb.y = dragStart.vby - dy;
      svgEl.setAttribute('viewBox', vb.x+' '+vb.y+' '+vb.w+' '+vb.h);
    });
    svgEl.addEventListener('mouseup', function(){ dragging = false; });
    svgEl.addEventListener('mouseleave', function(){ dragging = false; });

    document.getElementById('gv-zin').addEventListener('click', function(){ applyZoom(0.75); });
    document.getElementById('gv-zout').addEventListener('click', function(){ applyZoom(1.33); });
    document.getElementById('gv-zreset').addEventListener('click', function(){ vb={x:0,y:0,w:W,h:H}; svgEl.setAttribute('viewBox','0 0 '+W+' '+H); });
    function applyZoom(s){ var mx=vb.x+vb.w/2, my=vb.y+vb.h/2; vb.w*=s; vb.h*=s; vb.x=mx-vb.w/2; vb.y=my-vb.h/2; svgEl.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.w+' '+vb.h); }

    // search: highlight matching nodes, dim everything else
    var searchEl = document.getElementById('gv-search');
    if (searchEl) searchEl.addEventListener('input', function(){
      var q = searchEl.value.toLowerCase();
      el.querySelectorAll('.gv-node').forEach(function(g){
        var nd = DATA.nodes[+g.dataset.i];
        var match = !q || (nd.label||'').toLowerCase().includes(q) || (nd.path||'').toLowerCase().includes(q);
        g.style.opacity = match ? '1' : '0.15';
      });
    });

    // node interaction
    var paths = el.querySelectorAll('.gv-edge');
    el.querySelectorAll('.gv-node').forEach(function(g){
      g.addEventListener('mouseenter', function(){
        var i = +g.dataset.i;
        paths.forEach(function(p){ p.classList.toggle('hot', +p.dataset.from===i || +p.dataset.to===i); });
      });
      g.addEventListener('mousemove', function(ev){
        var nd = DATA.nodes[+g.dataset.i]; var xy=stageXY(ev);
        var label = (nd.stain ? nd.stain.replace(/_/g,' ') : nd.primaryChannel);
        tipShow('<b>'+escjs(nd.label)+'</b> &mdash; '+escjs(label)+'<br>'+nd.touches+' touches'+(nd.tainted_by?(' &middot; stained by '+nd.tainted_by):'')+'<span class="ex">'+escjs(explainOf(nd.stain,nd.primaryChannel))+'</span>', xy[0], xy[1]);
      });
      g.addEventListener('mouseleave', function(){ paths.forEach(function(p){ p.classList.remove('hot'); }); tipHide(); });
      g.addEventListener('click', function(e){
        e.stopPropagation();
        showDetail(DATA.nodes[+g.dataset.i]);
      });
    });

    // mode + filter buttons
    el.querySelectorAll('.gv-gbtn').forEach(function(b){
      b.addEventListener('click', function(){ graphMode=b.dataset.gmode; rendered.graph=false; renderGraph(); });
    });
    bindFilters(el, function(){ rendered.graph=false; renderGraph(); });
  }

  // ---- 3D GRAPH ----
  // Lessons from the previous broken version:
  //  - Three.js dropped examples/js in v0.148+; loading OrbitControls that way
  //    404'd and the chain stalled.
  //  - Loading three.js separately AND letting 3d-force-graph bundle its own
  //    created two competing WebGL contexts -> the intermittent black screen.
  //  - Custom nodeThreeObject referenced a global THREE that didn't reliably
  //    exist; we now use the library's built-in spheres which need no THREE.
  // Single-file UMD bundles three internally. We try unpkg, fall back to jsdelivr.
  var fg3dLoaded = 0; // 0 not started, 1 loading, 2 ready, -1 failed
  var fg3dInstance = null; // disposed on re-render so WebGL contexts don't leak
  function load3DLib(done){
    if (fg3dLoaded === 2) return done(null);
    if (fg3dLoaded === -1) return done(new Error('previous load failed'));
    fg3dLoaded = 1;
    var urls = [
      'https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js',
      'https://cdn.jsdelivr.net/npm/3d-force-graph@1.73.4/dist/3d-force-graph.min.js',
    ];
    var i = 0;
    function tryNext(){
      if (i >= urls.length) { fg3dLoaded = -1; return done(new Error('all CDNs failed')); }
      var s = document.createElement('script');
      s.src = urls[i++];
      s.onload = function(){
        if (typeof ForceGraph3D === 'function') { fg3dLoaded = 2; done(null); }
        else tryNext();
      };
      s.onerror = tryNext;
      document.head.appendChild(s);
    }
    tryNext();
  }

  function render3DGraph(){
    var el = document.getElementById('gv-graph3d');
    el.innerHTML = renderFilterBar('graph3d')
      + '<div class="gv-3d-wrap" id="gv-3d-container">'
      + '<div id="gv-3d-status" style="text-align:center;color:#7d8694;padding:80px 20px;">Loading 3D engine\\u2026<br><span style="font-size:.72rem;color:#484f58;">Needs internet for 3d-force-graph (~150KB)</span></div>'
      + '</div>';
    bindFilters(el, function(){ rendered.graph3d=false; render3DGraph(); });

    // Dispose any previous instance so we don't stack WebGL contexts (browsers
    // cap them; stacking caused the "blacked out" symptom).
    if (fg3dInstance) {
      try { fg3dInstance._destructor && fg3dInstance._destructor(); } catch (e) {}
      fg3dInstance = null;
    }

    load3DLib(function(err){
      var container = document.getElementById('gv-3d-container');
      if (!container) return;
      if (err) {
        container.innerHTML = '<div style="text-align:center;color:#ff5252;padding:60px 20px;">'
          + 'Could not load the 3D library.<br>'
          + '<span style="color:#7d8694;font-size:.78rem">Check your internet connection, then click the 3D Graph tab again.</span></div>';
        return;
      }
      init3D(container);
    });
  }

  function init3D(container){
    container.innerHTML = '';
    var W = container.clientWidth || 800, H = 520;

    var filtered = DATA.nodes.filter(nodePassesFilter);
    var filteredIds = {};
    filtered.forEach(function(n){ filteredIds[n.id] = true; });
    var gNodes = filtered.map(function(nd){
      return {
        id: nd.id, label: nd.label, path: nd.path,
        stain: nd.stain, channel: nd.primaryChannel, channels: nd.channels,
        touches: nd.touches, tainted_by: nd.tainted_by,
        color: colorOf(nd.stain, nd.primaryChannel),
        _nd: nd,
      };
    });
    var gLinks = DATA.edges.filter(function(e){
      return filteredIds[e.from] && filteredIds[e.to];
    }).map(function(e){
      return {
        source: e.from, target: e.to, kind: e.kind,
        color: colorOf(DATA.nodes[e.to].stain, DATA.nodes[e.to].channels[0]),
      };
    });

    if (!gNodes.length) {
      container.innerHTML = '<div style="text-align:center;color:#7d8694;padding:80px 20px;">No nodes match the current filters.</div>';
      return;
    }

    var graph;
    try {
      // rendererConfig is merged with {antialias:true, alpha:true} inside
      // 3d-force-graph (confirmed by reading dist/3d-force-graph.min.js@1.73.4).
      // Lenient options for restrictive Chrome states:
      //   powerPreference 'low-power' -> integrated GPU, avoids discrete-GPU
      //     handoff issues common on macOS dual-GPU Macs.
      //   failIfMajorPerformanceCaveat false -> accept software fallback
      //     instead of refusing the context outright.
      //   antialias false -> fewer GPU requirements; quality cost is minor.
      graph = ForceGraph3D({ rendererConfig: {
        antialias: false,
        powerPreference: 'low-power',
        failIfMajorPerformanceCaveat: false,
        preserveDrawingBuffer: false,
      } })(container)
        .width(W).height(H)
        .backgroundColor('#070809')
        .graphData({ nodes: gNodes, links: gLinks })
        .nodeRelSize(4)
        .nodeVal(function(n){ return 1 + Math.min(20, n.touches * 1.2); })
        .nodeColor(function(n){ return n.color; })
        .nodeOpacity(0.92)
        .nodeLabel(function(n){
          var outcome = n.stain ? n.stain.replace(/_/g, ' ') : 'clean';
          var explain = (n.stain && P.explain[n.stain]) || '';
          return '<div style="background:#0b0e13;border:1px solid #2a3340;border-radius:8px;padding:8px 11px;font-size:13px;color:#e7edf3;max-width:280px;font-family:-apple-system,sans-serif">'
            + '<b>' + escjs(n.label) + '</b><br>'
            + '<span style="color:' + n.color + '">' + escjs(outcome) + '</span> &middot; ' + n.touches + ' touches'
            + (n.channels.length ? '<br><span style="color:#7d8694">' + escjs(n.channels.join(', ')) + '</span>' : '')
            + (explain ? '<br><span style="color:#9abbe0;font-size:12px">' + escjs(explain) + '</span>' : '')
            + '</div>';
        })
        .onNodeClick(function(n){ if (n && n._nd) showDetail(n._nd); })
        .linkColor(function(l){ return l.color; })
        .linkOpacity(0.35)
        .linkWidth(0.6)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.4)
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor(function(l){ return l.color; })
        .linkLabel(function(l){ return l.kind; })
        .enableNodeDrag(true)
        .enableNavigationControls(true)
        .showNavInfo(false);
      // Tune forces for nicer layout; wrap in try since older builds may not expose d3Force.
      try {
        if (graph.d3Force) {
          var charge = graph.d3Force('charge'); if (charge && charge.strength) charge.strength(-50);
          var link = graph.d3Force('link'); if (link && link.distance) link.distance(34);
        }
      } catch (e) {}
      graph.onNodeHover(function(node){ container.style.cursor = node ? 'pointer' : 'grab'; });
      fg3dInstance = graph;

      // Keep the canvas sized to its container on resize / tab re-show.
      var resizeObs = null;
      try {
        resizeObs = new ResizeObserver(function(){
          var w = container.clientWidth || W;
          graph.width(w);
        });
        resizeObs.observe(container);
      } catch (e) {}
    } catch (e) {
      container.innerHTML = '<div style="text-align:center;color:#ff5252;padding:60px 20px;">3D engine failed to initialize.<br><span style="color:#7d8694;font-size:.78rem">' + escjs(String(e && e.message || e)) + '</span></div>';
    }
  }

  // ---- GLOSSARY ----
  function renderGlossary(){
    var el = document.getElementById('gv-glossary');
    var outcomes = [
      { key: 'verified', label: 'Verified', severity: 'None', desc: 'The agent said it did this, and the evidence backs it up. File changes, command output, or test results confirm the claim.' },
      { key: 'partial', label: 'Partial', severity: 'Low', desc: 'The agent touched the file, but the change looks like scaffolding only \\u2014 a comment, an empty function, a stub with no real logic. The claim is technically \\u201Cdone\\u201D but the implementation is hollow.' },
      { key: 'phantom', label: 'Phantom', severity: 'High', desc: 'The agent claimed it did something (edited a file, added a function, fixed a bug) but there is zero matching evidence in the session. No file was changed, no command ran, nothing supports the claim. Pure fabrication.' },
      { key: 'phantom_verification', label: 'Phantom Verification', severity: 'High', desc: 'The agent said \\u201Ctested and passing\\u201D or \\u201Cverified it works\\u201D but no test command ran, or the command that ran did not pass. The agent is expressing false confidence about verification it never performed.' },
      { key: 'silently_dropped', label: 'Silently Dropped', severity: 'High', desc: 'Part of your original request that the agent never did and never mentioned again. It was in the ask, but the agent just ignored it without acknowledging the omission.' },
      { key: 'undisclosed', label: 'Undisclosed', severity: 'Medium', desc: 'This file changed during the session, but no claim or request mentioned it. The agent made a change it never told you about. Could be benign (auto-formatting) or concerning (unintended side effects).' },
      { key: 'untracked_write', label: 'Untracked Write', severity: 'Critical', desc: 'The disk changed but no tool call ever disclosed it. The independent file watcher (fs-sentinel) saw a modification that the agent\\u2019s own tool stream never reported. This is the strongest signal Orunmila can produce \\u2014 something changed that was completely invisible to the normal audit trail.' },
      { key: 'unverifiable', label: 'Unverifiable', severity: 'None', desc: 'The claim was too vague to check. Statements like \\u201CI improved the code\\u201D or \\u201Cthis should work better\\u201D have no concrete target to verify against.' },
    ];
    var channels = [
      { key: 'read', desc: 'A file the agent read. This is a source of information \\u2014 the agent looked at this file to understand something.' },
      { key: 'write', desc: 'A file the agent changed. The tool stream reported this modification.' },
      { key: 'disk', desc: 'A change seen directly on disk by the independent watcher (fs-sentinel), regardless of what the agent claimed.' },
      { key: 'command', desc: 'A shell command the agent ran (npm test, git commit, etc.).' },
      { key: 'network', desc: 'The agent reached out to the internet (API calls, web fetches).' },
      { key: 'tool', desc: 'Another tool the agent used that doesn\\u2019t fit the categories above.' },
    ];
    var sevColors = { None: '#2e7d32', Low: '#ffd600', Medium: '#d500f9', High: '#ff5252', Critical: '#ff1744' };

    var html = '<div style="max-width:760px;margin:0 auto;">';
    html += '<h4 style="color:#e7edf3;font-size:1rem;margin:0 0 6px;">Outcome types</h4>';
    html += '<p style="color:#7d8694;font-size:.82rem;margin:0 0 18px;">When Orunmila compares what an agent <em>claimed</em> against what <em>actually happened</em>, each claim gets one of these labels.</p>';
    for (var i = 0; i < outcomes.length; i++) {
      var o = outcomes[i];
      var c = P.stain[o.key] || '#888';
      html += '<div style="display:flex;gap:14px;align-items:flex-start;padding:12px 16px;margin:6px 0;background:#0e1219;border-left:3px solid '+c+';border-radius:0 8px 8px 0;">';
      html += '<div style="flex-shrink:0;min-width:160px;"><span style="display:inline-block;background:'+c+';color:#fff;font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:8px;text-transform:uppercase;">'+escjs(o.label)+'</span>';
      html += '<div style="margin-top:6px;"><span style="font-size:.68rem;font-weight:600;color:'+sevColors[o.severity]+';text-transform:uppercase;">'+o.severity+' severity</span></div></div>';
      html += '<div style="color:#cfd8e3;font-size:.84rem;line-height:1.55;">'+escjs(o.desc)+'</div>';
      html += '</div>';
    }
    html += '<h4 style="color:#e7edf3;font-size:1rem;margin:28px 0 6px;">Channel types</h4>';
    html += '<p style="color:#7d8694;font-size:.82rem;margin:0 0 18px;">The <em>kind</em> of contact the agent had with a resource. Separate from outcomes \\u2014 a file can be read (channel) and still be phantom (outcome).</p>';
    for (var j = 0; j < channels.length; j++) {
      var ch = channels[j];
      var cc = P.channel[ch.key] || '#888';
      var gl = P.glyph[ch.key] || '';
      html += '<div style="display:flex;gap:14px;align-items:center;padding:10px 16px;margin:4px 0;background:#0e1219;border-left:3px solid '+cc+';border-radius:0 8px 8px 0;">';
      html += '<span style="font-size:1.1rem;width:28px;text-align:center;">'+gl+'</span>';
      html += '<span style="font-weight:600;color:'+cc+';min-width:80px;font-size:.84rem;">'+escjs(ch.key)+'</span>';
      html += '<span style="color:#cfd8e3;font-size:.84rem;">'+escjs(ch.desc)+'</span>';
      html += '</div>';
    }
    html += '<h4 style="color:#e7edf3;font-size:1rem;margin:28px 0 6px;">Metrics</h4>';
    html += '<p style="color:#7d8694;font-size:.82rem;margin:0 0 18px;">Aggregate numbers shown in the dashboard and benchmark results.</p>';
    var metrics = [
      { label: 'Reliability', desc: 'Weighted score 0\\u2013100. verified = 1.0, partial = 0.5, phantom/phantom_verification = 0. Higher means more of the agent\\u2019s claims are real.' },
      { label: 'Phantom Rate', desc: 'Percentage of claims that are phantom or phantom verification. How often the agent fabricates.' },
      { label: 'ConfIdx (False Confidence Index)', desc: 'phantom_verification / (phantom + phantom_verification). What fraction of fabrications are confidence claims like \\u201Ctested and passing.\\u201D Higher means the agent doesn\\u2019t just lie \\u2014 it lies confidently.' },
      { label: 'Touches', desc: 'Total interactions: file reads, writes, commands, network calls, tool uses. Volume of activity in the session.' },
    ];
    for (var m = 0; m < metrics.length; m++) {
      html += '<div style="padding:8px 16px;margin:4px 0;background:#0e1219;border-radius:8px;font-size:.84rem;">';
      html += '<span style="color:#40c4ff;font-weight:600;">'+escjs(metrics[m].label)+'</span> \\u2014 <span style="color:#cfd8e3;">'+escjs(metrics[m].desc)+'</span></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ---- TREE ----
  function renderTree(){
    var el = document.getElementById('gv-tree');
    var withPath = DATA.nodes.filter(function(n){ return n.path && nodePassesFilter(n); });
    var rows='';
    if(!withPath.length){
      rows = '<p class="gv-hint" style="display:block">No matching files. Try adjusting the filters, or the session was mostly commands.</p>';
    } else {
      var byDir={};
      withPath.forEach(function(n){ var parts=n.path.split(/[\\\\/]/); var f=parts.pop(); var d=parts.join('/')||'.'; (byDir[d]=byDir[d]||[]).push({f:f,n:n}); });
      Object.keys(byDir).sort().forEach(function(d){
        rows += '<div class="row"><span class="dir">'+escjs(d)+'/</span></div>';
        byDir[d].forEach(function(it){
          var c=colorOf(it.n.stain, it.n.primaryChannel);
          var w=20+Math.min(160, it.n.touches*10);
          rows += '<div class="row" style="padding-left:16px" data-ni="'+it.n.id+'" title="'+escjs(explainOf(it.n.stain,it.n.primaryChannel))+'">'
            + '<span class="bar" style="width:'+w+'px;background:'+c+';color:'+c+'"></span>'
            + '<span class="nm">'+escjs(it.f)+'</span> <span class="dir">&middot; '+it.n.touches+'</span></div>';
        });
      });
    }
    el.innerHTML = renderFilterBar('tree') + legend() + '<div class="gv-tree">'+rows+'</div>';
    el.querySelectorAll('.row[data-ni]').forEach(function(row){
      row.addEventListener('click', function(){ showDetail(DATA.nodes[+row.dataset.ni]); });
    });
    bindFilters(el, function(){ rendered.tree=false; renderTree(); });
  }

  // ---- TIMELINE ----
  function renderTimeline(){
    var el = document.getElementById('gv-timeline');
    var cols = DATA.turns.map(function(t){
      var pips = DATA.trail.filter(function(r){ return r.turn===t.turn_id && trailPassesFilter(r); }).map(function(r, idx){
        var c=colorOf(r.stain, r.channel);
        return '<div class="gv-tdot" data-tidx="'+t.turn_id+'_'+idx+'" title="'+escjs(r.channel+': '+r.label)+'"><span class="pip" style="background:'+c+';color:'+c+'"></span><span class="tx">'+escjs(trunc(r.label,22))+'</span></div>';
      }).join('');
      return '<div class="gv-tcol"><h5>'+escjs(t.turn_id)+' &middot; '+t.touches+'</h5><div class="prompt">'+escjs(trunc(t.prompt,70))+'</div>'+(pips||'<span class="dir" style="font-size:.72rem">no touches</span>')+'</div>';
    }).join('');
    el.innerHTML = renderFilterBar('timeline') + legend() + '<div class="gv-time">'+cols+'</div>';

    // click-to-detail on pips
    el.querySelectorAll('.gv-tdot').forEach(function(dot){
      dot.addEventListener('click', function(){
        var parts = dot.dataset.tidx.split('_');
        var turnId = parts[0], idx = parseInt(parts[1]);
        var matching = DATA.trail.filter(function(r){ return r.turn===turnId && trailPassesFilter(r); });
        if (matching[idx]) showTrailDetail(matching[idx]);
      });
    });
    bindFilters(el, function(){ rendered.timeline=false; renderTimeline(); });
  }

  // ---- DASHBOARD ----
  function renderDashboard(){
    var el = document.getElementById('gv-dashboard');
    function bars(tally, kind){
      var keys=Object.keys(tally).sort(function(a,b){return tally[b]-tally[a];});
      var max=Math.max.apply(null, keys.map(function(k){return tally[k];}).concat([1]));
      return keys.map(function(k){
        var c = kind==='stain' ? (P.stain[k]||'#888') : (P.channel[k]||'#888');
        var w = 8 + (tally[k]/max)*150;
        return '<div class="b" title="'+escjs(P.explain[k]||k)+'"><span class="v">'+tally[k]+'</span><span class="fill" style="width:'+w+'px;background:'+c+';color:'+c+'"></span><span style="color:#aeb8c4">'+escjs(k.replace(/_/g,' '))+'</span></div>';
      }).join('');
    }

    // donut chart for stain proportions
    var stainKeys = Object.keys(DATA.stainTally);
    var stainTotal = stainKeys.reduce(function(s,k){ return s+DATA.stainTally[k]; }, 0) || 1;
    var donutR = 60, donutHole = 36, donutSvgW = 160;
    var cumAngle = 0;
    var donutPaths = stainKeys.map(function(k){
      var frac = DATA.stainTally[k] / stainTotal;
      var startAngle = cumAngle;
      cumAngle += frac * Math.PI * 2;
      var endAngle = cumAngle;
      if (frac >= 0.999) {
        return '<circle cx="'+donutSvgW/2+'" cy="'+donutSvgW/2+'" r="'+donutR+'" fill="'+(P.stain[k]||'#888')+'" />';
      }
      var x1 = donutSvgW/2 + donutR * Math.cos(startAngle);
      var y1 = donutSvgW/2 + donutR * Math.sin(startAngle);
      var x2 = donutSvgW/2 + donutR * Math.cos(endAngle);
      var y2 = donutSvgW/2 + donutR * Math.sin(endAngle);
      var ix1 = donutSvgW/2 + donutHole * Math.cos(endAngle);
      var iy1 = donutSvgW/2 + donutHole * Math.sin(endAngle);
      var ix2 = donutSvgW/2 + donutHole * Math.cos(startAngle);
      var iy2 = donutSvgW/2 + donutHole * Math.sin(startAngle);
      var large = frac > 0.5 ? 1 : 0;
      return '<path d="M'+x1+','+y1+' A'+donutR+','+donutR+' 0 '+large+',1 '+x2+','+y2+' L'+ix1+','+iy1+' A'+donutHole+','+donutHole+' 0 '+large+',0 '+ix2+','+iy2+' Z" fill="'+(P.stain[k]||'#888')+'" title="'+escjs(k)+': '+DATA.stainTally[k]+'"/>';
    }).join('');
    var donutSvg = '<svg width="'+donutSvgW+'" height="'+donutSvgW+'" viewBox="0 0 '+donutSvgW+' '+donutSvgW+'">'+donutPaths
      + '<text x="'+donutSvgW/2+'" y="'+(donutSvgW/2-4)+'" text-anchor="middle" fill="#e7edf3" font-size="18" font-weight="800">'+stainTotal+'</text>'
      + '<text x="'+donutSvgW/2+'" y="'+(donutSvgW/2+14)+'" text-anchor="middle" fill="#7d8694" font-size="10">things</text></svg>';
    var donutLegend = stainKeys.map(function(k){
      var pct = Math.round(DATA.stainTally[k]/stainTotal*100);
      return '<div class="it"><span class="gv-dot" style="background:'+(P.stain[k]||'#888')+'"></span>'+escjs(k.replace(/_/g,' '))+' '+pct+'%</div>';
    }).join('');

    var topNodes = DATA.nodes.slice().sort(function(a,b){return b.touches-a.touches;}).slice(0,8);
    var topBars = topNodes.map(function(n){
      var c=colorOf(n.stain,n.primaryChannel); var max=topNodes[0].touches||1; var w=8+(n.touches/max)*150;
      return '<div class="b" title="'+escjs(n.path||n.label)+'"><span class="v">'+n.touches+'</span><span class="fill" style="width:'+w+'px;background:'+c+';color:'+c+'"></span><span style="color:#aeb8c4">'+escjs(trunc(n.label,22))+'</span></div>';
    }).join('');
    var turnBars = DATA.turns.map(function(t){
      var max=Math.max.apply(null,DATA.turns.map(function(x){return x.touches;}).concat([1])); var w=8+(t.touches/max)*150;
      return '<div class="b"><span class="v">'+t.touches+'</span><span class="fill" style="width:'+w+'px;background:#40c4ff;color:#40c4ff"></span><span style="color:#aeb8c4">'+escjs(t.turn_id)+'</span></div>';
    }).join('');
    el.innerHTML =
      '<div class="gv-dash">'
      + '<div class="gv-card"><h5>At a glance</h5><div class="gv-kpi">'
        + '<div class="k" title="Total interactions with files, commands, network, and tools"><div class="n" style="color:#00e676">'+DATA.totals.touches+'</div><div class="l">touches</div></div>'
        + '<div class="k" title="Unique files, commands, or endpoints the agent interacted with"><div class="n" style="color:#40c4ff">'+DATA.totals.artifacts+'</div><div class="l">things</div></div>'
        + '<div class="k" title="Number of conversation turns in this session"><div class="n" style="color:#ffab40">'+DATA.totals.turns+'</div><div class="l">turns</div></div>'
      + '</div></div>'
      + '<div class="gv-card"><h5>What orunmila found</h5><div class="gv-donut-wrap">'+donutSvg+'<div class="gv-donut-legend">'+donutLegend+'</div></div></div>'
      + '<div class="gv-card"><h5>Kinds of contact</h5><div class="gv-bars">'+bars(DATA.channelTally,'channel')+'</div></div>'
      + '<div class="gv-card"><h5>Busiest turns</h5><div class="gv-bars">'+turnBars+'</div></div>'
      + '<div class="gv-card"><h5>Most-touched things</h5><div class="gv-bars">'+topBars+'</div></div>'
      + '</div>';
  }

  function renderReport() {
    var el = document.getElementById('gv-report');
    var findings = DATA.findings || [];
    if (!findings.length) {
      el.innerHTML = '<div class="gv-nothing">✔ Nothing flagged &mdash; every claim checked out.</div>';
      return;
    }

    var typeLabels = {
      phantom: 'Phantom', phantom_verification: 'Phantom Test',
      partial: 'Partial', silently_dropped: 'Dropped',
      undisclosed: 'Undisclosed', untracked_write: 'Untracked Write'
    };
    var typeColors = {
      phantom: P.stain.phantom, phantom_verification: P.stain.phantom_verification,
      partial: P.stain.partial, silently_dropped: P.stain.silently_dropped,
      undisclosed: P.stain.undisclosed, untracked_write: P.stain.untracked_write
    };

    var counts = {};
    for (var i = 0; i < findings.length; i++) {
      counts[findings[i].type] = (counts[findings[i].type] || 0) + 1;
    }

    var statHtml = '<div class="gv-summary-grid">';
    var order = ['phantom','phantom_verification','partial','silently_dropped','undisclosed','untracked_write'];
    for (var o = 0; o < order.length; o++) {
      var k = order[o];
      if (!counts[k]) continue;
      statHtml += '<div class="gv-summary-stat"><div class="n" style="color:' + (typeColors[k] || '#fff') + '">' + counts[k] + '</div><div class="l">' + (typeLabels[k] || k).replace(/_/g, ' ') + '</div></div>';
    }
    statHtml += '</div>';

    var findingsHtml = '<div class="gv-report-section"><h4>Findings <span class="cnt">' + findings.length + '</span></h4>';
    for (var f = 0; f < findings.length; f++) {
      var fd = findings[f];
      var col = typeColors[fd.type] || '#888';
      var meta = 'Turn ' + escjs(String(fd.turn));
      if (fd.paths && fd.paths.length) meta += ' &middot; ' + fd.paths.map(function(p){ return escjs(trunc(p, 60)); }).join(', ');
      if (fd.targets && fd.targets.length) meta += ' &middot; ' + fd.targets.map(function(t){ return escjs(trunc(t, 40)); }).join(', ');
      findingsHtml += '<div class="gv-finding" style="border-left-color:' + col + '">'
        + '<span class="f-tag" style="background:' + col + '">' + escjs(typeLabels[fd.type] || fd.type) + '</span>'
        + '<div><div class="f-text">' + escjs(fd.text) + '</div><div class="f-meta">' + meta + '</div></div>'
        + '</div>';
    }
    findingsHtml += '</div>';

    var promptLines = [];
    promptLines.push('I ran Orunmila (a claim-vs-reality verifier) on our last session and found ' + findings.length + ' issue' + (findings.length === 1 ? '' : 's') + '. Please address each one:\\n');

    var phantoms = findings.filter(function(f){ return f.type === 'phantom'; });
    var pvs = findings.filter(function(f){ return f.type === 'phantom_verification'; });
    var partials = findings.filter(function(f){ return f.type === 'partial'; });
    var dropped = findings.filter(function(f){ return f.type === 'silently_dropped'; });
    var undiscl = findings.filter(function(f){ return f.type === 'undisclosed'; });
    var untracked = findings.filter(function(f){ return f.type === 'untracked_write'; });

    if (phantoms.length) {
      promptLines.push('## Phantom claims (said you did it, but no evidence exists)');
      for (var pi = 0; pi < phantoms.length; pi++) {
        promptLines.push('- You claimed: "' + phantoms[pi].text + '" but no file change, command, or tool call supports this.');
      }
      promptLines.push('');
    }
    if (pvs.length) {
      promptLines.push('## Phantom verifications (said it was tested/working, but no test ran)');
      for (var vi = 0; vi < pvs.length; vi++) {
        promptLines.push('- You claimed: "' + pvs[vi].text + '" but no passing test or command backs this up. Actually run the verification.');
      }
      promptLines.push('');
    }
    if (partials.length) {
      promptLines.push('## Partial implementations (touched the file, but it is mostly scaffolding)');
      for (var ai = 0; ai < partials.length; ai++) {
        var pp = partials[ai].paths.length ? ' (' + partials[ai].paths.join(', ') + ')' : '';
        promptLines.push('- "' + partials[ai].text + '"' + pp + ' — the change is stub/scaffolding only. Provide a real implementation.');
      }
      promptLines.push('');
    }
    if (dropped.length) {
      promptLines.push('## Silently dropped tasks (part of the original request, never addressed)');
      for (var di = 0; di < dropped.length; di++) {
        promptLines.push('- "' + dropped[di].text + '" was in my original request but was never done or mentioned.');
      }
      promptLines.push('');
    }
    if (undiscl.length) {
      promptLines.push('## Undisclosed changes (files changed that no claim or request covers)');
      for (var ui = 0; ui < undiscl.length; ui++) {
        promptLines.push('- ' + undiscl[ui].text + ' was changed but you never mentioned why.');
      }
      promptLines.push('');
    }
    if (untracked.length) {
      promptLines.push('## Untracked writes (disk changed with no tool call disclosed)');
      for (var ti = 0; ti < untracked.length; ti++) {
        promptLines.push('- ' + untracked[ti].text + ' was modified on disk but no tool call reported it.');
      }
      promptLines.push('');
    }

    promptLines.push('Go back and actually complete each item above. For phantom claims, either do the work or remove the claim. For dropped tasks, implement them. For partial implementations, finish them. For phantom verifications, actually run the tests.');

    var promptText = promptLines.join('\\n');

    var promptHtml = '<div class="gv-report-section"><h4>Copy-paste prompt</h4>'
      + '<p style="color:#7d8694;font-size:.78rem;margin:0 0 10px;">Copy this and paste it back into the agent to have it fix everything above.</p>'
      + '<div class="gv-prompt-wrap">'
      + '<button class="gv-copy-btn" id="gv-copy-prompt">\u{1F4CB} Copy</button>'
      + '<pre class="gv-prompt" id="gv-prompt-text">' + escjs(promptText) + '</pre>'
      + '</div></div>';

    el.innerHTML = statHtml + promptHtml + findingsHtml;

    document.getElementById('gv-copy-prompt').addEventListener('click', function() {
      var text = promptText;
      var btn = this;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          btn.textContent = '✔ Copied!';
          btn.classList.add('copied');
          setTimeout(function(){ btn.textContent = '\u{1F4CB} Copy'; btn.classList.remove('copied'); }, 2000);
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✔ Copied!';
        btn.classList.add('copied');
        setTimeout(function(){ btn.textContent = '\u{1F4CB} Copy'; btn.classList.remove('copied'); }, 2000);
      }
    });
  }

  function legend(){
    var stains=['verified','partial','phantom','undisclosed','untracked_write'];
    var chans=['read','write','command','network'];
    var s = stains.map(function(k){return '<span class="it" style="color:'+P.stain[k]+'" title="'+escjs(P.explain[k])+'"><span class="gv-dot" style="background:'+P.stain[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k.replace(/_/g,' ')+'</span></span>';}).join('');
    var c = chans.map(function(k){return '<span class="it" style="color:'+P.channel[k]+'" title="'+escjs(P.explain[k])+'"><span class="gv-dot" style="background:'+P.channel[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k+'</span></span>';}).join('');
    return '<details class="gv-legbox" open><summary>Colour legend</summary><div class="gv-legend">'+s+c+'</div></details>';
  }

  function trunc(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'\\u2026' : s; }
  function escjs(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var RENDERERS = { graph:renderGraph, tree:renderTree, timeline:renderTimeline, dashboard:renderDashboard, graph3d:render3DGraph, report:renderReport, glossary:renderGlossary };
  var rendered = {};
  function show(view){
    document.querySelectorAll('.gv-tab').forEach(function(t){ t.classList.toggle('on', t.dataset.view===view); });
    document.querySelectorAll('.gv-view').forEach(function(v){ v.classList.toggle('on', v.dataset.view===view); });
    if(!rendered[view]){ RENDERERS[view](); rendered[view]=true; }
    setHint(view); tipHide(); detailSlot.innerHTML='';
  }
  document.getElementById('gv-tabs').addEventListener('click', function(e){ if(e.target.dataset.view) show(e.target.dataset.view); });
  document.getElementById('gv-aud').addEventListener('click', function(e){
    if(!e.target.dataset.aud) return;
    document.querySelectorAll('#gv-aud button').forEach(function(b){ b.classList.toggle('on', b===e.target); });
    root.classList.toggle('gv-explainable', e.target.dataset.aud==='explain');
    root.classList.toggle('gv-power', e.target.dataset.aud==='power');
  });

  show('timeline');
})();
</script>
`;
}

module.exports = { buildVizData, renderTrailVisual, STAIN_COLORS, CHANNEL_COLORS };
