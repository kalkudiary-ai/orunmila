'use strict';

const graph3d = require('./graph3d');
const graph2d = require('./graph2d');

// HTML1 (LD305): one palette for the whole page (html.js reads it too), calmer than the first neon one: colour is
// for what needs a look, so the reds and ambers stand out and the rest recedes.
const STAIN_COLORS = {
  untracked_write: '#ff5c5c',
  phantom_verification: '#f2545b',
  phantom: '#f47c7c',
  silently_dropped: '#b39ddb',
  undisclosed: '#ce93d8',
  partial: '#e6c35c',
  unverifiable: '#9aa4ae',
  verified: '#5cc38a',
  clean: '#5cc38a',
};

const CHANNEL_COLORS = {
  read: '#64b5f6',
  write: '#81c995',
  disk: '#4db6ac',
  command: '#e0a458',
  network: '#ba8fd6',
  tool: '#9aa4ae',
};

// Plain symbols, not emoji: an emoji draws in colour on one OS, as a box or not at all on another (Windows and Linux
// fonts differ), so the same page read differently by OS.
const CHANNEL_GLYPH = { read: '○', write: '✎', disk: '▣', command: '$', network: '⇄', tool: '◇' };

const EXPLAIN = {
  verified: 'The agent said it did this, and the evidence backs it up.',
  partial: 'Touched, but the change looks like scaffolding only.',
  phantom: 'Claimed, but nothing in the session actually did it.',
  phantom_verification: 'Claimed it was tested/works, but no passing check ran.',
  unverifiable: 'The claim was too vague to check.',
  undisclosed: 'This file changed but no claim or request mentioned it.',
  silently_dropped: 'Part of your request no later message seems to cover. Often wrong: pasted text can look like a request.',
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
    // F17 (LD303): whether any turn was checked; the tabs say "Not checked" rather than "clean" when none was.
    checked: !!(reports && reports.length),
    checkedTurns: (reports || []).length,
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
  .gv-tab.on { background:#161c25; color:#fff; box-shadow:inset 0 2px 0 #64b5f6; }
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
  .gv-dot { width:10px; height:10px; border-radius:50%; }
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
  .gv-edge { stroke-opacity:var(--o,.06); transition:stroke-opacity .1s, stroke-width .1s; }
  .gv-edge.hot { stroke-opacity:.9; stroke-width:2.1; }
  /* the Graph tab's levels (G2D) */
  svg.gv-levels { background:#0a0d12; cursor:default; }
  .gv-lvl-band { fill:#0e1219; stroke:#1a212b; }
  .gv-lvl-title { fill:#cfd8e3; font-size:13px; font-weight:700; letter-spacing:.02em; }
  .gv-lvl-count { fill:#6f7b88; font-size:10.5px; }
  .gv-folder { fill:#5b6672; font-size:10px; font-family:ui-monospace,Menlo,monospace; }
  .gv-nlabel { fill:#aeb8c4; font-size:11px; }
  .gv-node.flagged .gv-nlabel { font-weight:700; }
  .gv-node.match circle { stroke:#ffffff; stroke-width:2.2; }
  .gv-levels .gv-node { transition:opacity .12s; }
  .gv-levels.focus .gv-node { opacity:.2; }
  .gv-levels.focus .gv-node.near { opacity:1; }
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

  /* 3D map (V3D, LD300): Orunmila's own WebGL2 engine, src/render/graph3d.js */
  .g3-wrap { position:relative; width:100%; height:560px; border-radius:12px; overflow:hidden; background:#05070b; outline:none; cursor:grab; touch-action:none; box-shadow:inset 0 0 0 1px #1a212b; }
  .g3-wrap:focus-visible { box-shadow:inset 0 0 0 2px #40c4ff; }
  .g3-wrap:fullscreen { height:100vh; border-radius:0; }
  .g3-canvas { display:block; width:100%; height:100%; }
  .g3-labels { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
  .g3-label { position:absolute; left:0; top:0; font:600 11px/1.2 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; color:#dfe7ef; background:rgba(8,11,16,.62); border:1px solid rgba(120,150,190,.18); padding:2px 7px; border-radius:6px; white-space:nowrap; backdrop-filter:blur(4px); transition:opacity .2s; }
  .g3-label.on { color:#fff; border-color:#40c4ff; box-shadow:0 0 12px rgba(64,196,255,.45); }
  .g3-hud { position:absolute; left:12px; bottom:12px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; background:rgba(8,11,16,.66); border:1px solid #1f2630; border-radius:10px; padding:7px 12px; font-size:.74rem; color:#aeb8c4; backdrop-filter:blur(6px); }
  .g3-hud label { display:flex; align-items:center; gap:5px; cursor:pointer; }
  .g3-hud input[type=range] { width:92px; accent-color:#40c4ff; }
  .g3-look button { padding:4px 10px; font-size:.72rem; }
  .g3-hud input[type=checkbox], .g3-replay input[type=checkbox] { accent-color:#40c4ff; }
  .g3-msg[hidden] { display:none; }
  .g3-msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:40px; color:#9aa6b2; font-size:.9rem; background:#070809; }
  .g3-replay { display:flex; align-items:center; gap:10px; margin-top:10px; flex-wrap:wrap; font-size:.78rem; color:#9aa6b2; }
  .g3-replay input[type=range] { flex:1; min-width:160px; accent-color:#00e676; }
  .g3-replay select { background:#11151c; color:#cfd8e3; border:1px solid #28313d; border-radius:7px; padding:4px 6px; font-size:.76rem; }
  .g3-replay label { display:flex; align-items:center; gap:5px; cursor:pointer; }
  .g3-step { color:#cfd8e3; font-family:ui-monospace,Menlo,monospace; font-size:.74rem; min-width:220px; }
  .g3-step.turn { color:#00e676; }

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
  .gv-tree .bar { height:8px; border-radius:4px; opacity:.85; }
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
  .gv-tdot .pip { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
  .gv-tdot .tx { color:#c4cdd8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .gv-tdot .cnt { color:#7d8694; font-size:.7rem; margin-left:auto; padding-left:6px; }
  .gv-tmore { margin-top:8px; }
  .gv-unchecked { color:#8b96a3; font-size:.86rem; line-height:1.5; }
  .gv-nothing.gv-unchecked { color:#8b96a3; }

  /* dashboard */
  .gv-dash { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:18px; }
  .gv-card { background:#0e1219; border:1px solid #1f2630; border-radius:12px; padding:16px; }
  .gv-card h5 { margin:0 0 12px; font-size:.82rem; color:#aeb8c4; text-transform:uppercase; letter-spacing:.04em; }
  .gv-bars .b { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:.8rem; }
  .gv-bars .b .fill { height:12px; border-radius:3px; opacity:.9; }
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
    <button class="gv-tab" data-view="map3d">3D Map</button>
    <button class="gv-tab" data-view="dashboard">Dashboard</button>
    <button class="gv-tab" data-view="report">Report</button>
    <button class="gv-tab" data-view="glossary">Glossary</button>
  </div>
  <div class="gv-stage">
    <p class="gv-hint" id="gv-hint"></p>
    <div class="gv-view on" data-view="timeline" id="gv-timeline"></div>
    <div class="gv-view" data-view="tree" id="gv-tree"></div>
    <div class="gv-view" data-view="graph" id="gv-graph"></div>
    <div class="gv-view" data-view="map3d" id="gv-map3d"></div>
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
    graph: 'The session left to right: what the agent read, what it ran, what it changed, each in its folders, flagged things first. Hover to follow a thing\\u2019s links, click for details. Scroll to zoom, drag to pan.',
    map3d: 'The same map in 3D, drawn on this computer with no internet. Drag to turn it, right-drag or Shift-drag to move, scroll or pinch to zoom, click a sphere to fly to it. Flagged things pulse. Replay starts from a blank canvas and builds the map in the order the agent worked: each thing appears when first touched, each link grows when both its ends are there, the camera following the agent from file to file.',
    glossary: 'What every color, label, and metric means.',
    tree: 'Your project as folders. Each bar glows by how the agent touched that file. Click a file for details.',
    timeline: 'The session left to right, one column per turn. Click any pip for details.',
    dashboard: 'The numbers at a glance: outcome proportions, channel breakdown, busiest turns, and most-touched things.',
    report: 'What needs a second look in the checked turns, and a prompt you can paste back to the agent: it asks for the evidence or a fix on each item.'
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

  // ---- GRAPH (G2D: levels left to right, links as curves; the layout is src/render/graph2d.js) ----
  // The ring it replaces drew every link through one centre point, so a busy session became one knot.
  var graphMode = 'flagged';
  var graphSearch = '';
  var vb = { x:0, y:0, w:960, h:520 };
${graph2d.source()}
  function isFlaggedNode(n){ return !!(n.stain && n.stain !== 'verified' && n.stain !== 'clean'); }

  function renderGraph(){
    var el = document.getElementById('gv-graph');

    var filtered = DATA.nodes.filter(nodePassesFilter);
    var stainedCount = filtered.filter(isFlaggedNode).length;
    var keep = {};
    var flaggedNote = '';
    if (graphMode==='flagged' && stainedCount){
      // HTML1: linked things come along only while they do not swamp the view (on 860f51e9 it showed 104 of 106).
      var fv = orunmilaGraph2DCore.flaggedView(filtered, DATA.edges, { grow: 3 });
      fv.ids.forEach(function(id){ keep[id] = true; });
      flaggedNote = fv.withLinks ? ' &middot; flagged and what they link to' : ' &middot; flagged only (they link to too much to show)';
    } else {
      filtered.forEach(function(n){ keep[n.id]=true; });
    }
    var visible = DATA.nodes.filter(function(n){ return keep[n.id] && nodePassesFilter(n); });
    var Lay = orunmilaGraph2DCore.layered(visible, DATA.edges, { cap: 60, search: graphSearch, width: 960 });
    var W = Lay.width, H = Lay.height;
    vb = { x:0, y:0, w:W, h:H };

    var controls = renderFilterBar('graph');
    controls += '<div class="gv-gctl">'
      + '<button class="gv-gbtn'+(graphMode==='flagged'?' on':'')+'" data-gmode="flagged">Flagged</button>'
      + '<button class="gv-gbtn'+(graphMode==='all'?' on':'')+'" data-gmode="all">Everything</button>'
      + '<span class="gv-gcount">'+Lay.placed.length+' shown of '+DATA.nodes.length+' things'
      + (graphMode==='flagged'&&!stainedCount ? ' &middot; nothing flagged, showing all' : flaggedNote)+'</span>'
      + '<input class="gv-search" id="gv-search" placeholder="Search files\\u2026" autocomplete="off" value="'+escjs(graphSearch)+'">'
      + '<div class="gv-zoom-ctrl"><button id="gv-zin" title="Zoom in">+</button><button id="gv-zout" title="Zoom out">&minus;</button><button id="gv-zreset" title="Reset view">&#8634;</button></div>'
      + '</div>';

    // A dense session's links would cover everything: each link's ink scales with the square root of their count.
    var density = Math.min(1, 21 / Math.sqrt(Math.max(Lay.links.length, 1)));
    // Full width at its natural height: a long session makes a long picture, and the page scrolls.
    var svg = '<svg class="gv-svg gv-levels" id="gv-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMin meet" style="height:auto;aspect-ratio:'+W+' / '+H+'">';
    Lay.levels.forEach(function(L, i){
      svg += '<rect class="gv-lvl-band" x="'+(L.x+2).toFixed(1)+'" y="8" width="'+(L.width-4).toFixed(1)+'" height="'+(H-16)+'" rx="10"/>';
      svg += '<text class="gv-lvl-title" x="'+(L.x+16).toFixed(1)+'" y="30">'+(i+1)+' &middot; '+escjs(L.title)+'</text>';
      svg += '<text class="gv-lvl-count" x="'+(L.x+16).toFixed(1)+'" y="45">'+L.shown+' shown'+(L.hidden ? ' &middot; '+L.hidden+' more: search to find one' : '')+'</text>';
      L.groups.forEach(function(g){ svg += '<text class="gv-folder" x="'+(L.x+16).toFixed(1)+'" y="'+g.y.toFixed(1)+'">'+escjs(trunc(g.folder, 44))+'</text>'; });
    });
    Lay.links.forEach(function(l){
      var t = DATA.nodes[l.to];
      var c = colorOf(t.stain, t.primaryChannel);
      svg += '<path class="gv-edge" data-from="'+l.from+'" data-to="'+l.to+'" d="'+l.d+'" fill="none" stroke="'+c+'" stroke-width="1.1" style="--o:'+(0.2*density).toFixed(3)+'"/>';
    });
    Lay.placed.forEach(function(p){
      var nd = DATA.nodes[p.id];
      var c = colorOf(nd.stain, nd.primaryChannel);
      svg += '<g class="gv-node'+(p.flagged?' flagged':'')+(p.match?' match':'')+'" data-i="'+p.id+'" transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')">';
      svg += '<circle r="'+p.r.toFixed(1)+'" fill="'+c+'" fill-opacity="'+(p.flagged?'0.9':'0.5')+'" stroke="'+c+'" stroke-width="'+(p.flagged?'2':'1')+'"/>';
      svg += '<text class="gv-nlabel" x="'+(p.r+6).toFixed(1)+'" dy="3.5"'+(p.flagged?' fill="'+c+'"':'')+'>'+escjs(trunc(nd.label, 34))+'</text>';
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

    // search: lay the levels out again with the matches ringed, and brought in when a level was full
    var searchEl = document.getElementById('gv-search');
    if (searchEl) searchEl.addEventListener('input', function(){
      graphSearch = searchEl.value;
      var at = searchEl.selectionStart;
      rendered.graph = false; renderGraph();
      var again = document.getElementById('gv-search');
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* not a text field */ } }
    });

    // node interaction: hovering a thing lights its links and its neighbours and dims the rest
    var paths = el.querySelectorAll('.gv-edge');
    var nodesEls = el.querySelectorAll('.gv-node');
    el.querySelectorAll('.gv-node').forEach(function(g){
      g.addEventListener('mouseenter', function(){
        var i = +g.dataset.i;
        var near = {}; near[i] = true;
        paths.forEach(function(p){
          var hot = +p.dataset.from===i || +p.dataset.to===i;
          p.classList.toggle('hot', hot);
          if (hot) { near[+p.dataset.from] = true; near[+p.dataset.to] = true; }
        });
        nodesEls.forEach(function(n){ n.classList.toggle('near', !!near[+n.dataset.i]); });
        svgEl.classList.add('focus');
      });
      g.addEventListener('mousemove', function(ev){
        var nd = DATA.nodes[+g.dataset.i]; var xy=stageXY(ev);
        var label = (nd.stain ? nd.stain.replace(/_/g,' ') : nd.primaryChannel);
        tipShow('<b>'+escjs(nd.label)+'</b> &mdash; '+escjs(label)+'<br>'+nd.touches+' touches'+(nd.tainted_by?(' &middot; stained by '+nd.tainted_by):'')+'<span class="ex">'+escjs(explainOf(nd.stain,nd.primaryChannel))+'</span>', xy[0], xy[1]);
      });
      g.addEventListener('mouseleave', function(){ paths.forEach(function(p){ p.classList.remove('hot'); }); svgEl.classList.remove('focus'); tipHide(); });
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

  // ---- 3D MAP (V3D, LD300) ----
  // NI1 (LD264) removed the old 3D graph, which loaded a library from a CDN. This one is Orunmila's own WebGL2 code,
  // put into the page whole (src/render/graph3d.js): no library, no internet.
${graph3d.source()}
  var map3d = null;
  function renderMap3D(){
    map3d = orunmilaGraph3D({
      DATA: DATA, el: document.getElementById('gv-map3d'), colorOf: colorOf, explainOf: explainOf,
      nodePassesFilter: nodePassesFilter, renderFilterBar: renderFilterBar, bindFilters: bindFilters,
      showDetail: showDetail, tipShow: tipShow, tipHide: tipHide, stageXY: stageXY, escjs: escjs, trunc: trunc, legend: legend,
      flaggedView: orunmilaGraph2DCore.flaggedView
    });
  }

  // ---- GLOSSARY ----
  function renderGlossary(){
    var el = document.getElementById('gv-glossary');
    var outcomes = [
      { key: 'verified', label: 'Verified', severity: 'None', desc: 'The agent said it did this, and the evidence backs it up. File changes, command output, or test results confirm the claim.' },
      { key: 'partial', label: 'Partial', severity: 'Low', desc: 'The agent touched the file, but the change looks like scaffolding only \\u2014 a comment, an empty function, a stub with no real logic. The claim is technically \\u201Cdone\\u201D but the implementation is hollow.' },
      { key: 'phantom', label: 'Phantom', severity: 'High', desc: 'The agent said it did something (edited a file, added a function, fixed a bug) and nothing in the record shows it: no file changed, no command ran, no tool call supports it. Recheck it: the evidence may sit outside what Orunmila sees.' },
      { key: 'phantom_verification', label: 'Phantom Verification', severity: 'High', desc: 'The agent said \\u201Ctested and passing\\u201D or \\u201Cverified it works\\u201D and no passing test or command ran in that turn. Run the check and read its result.' },
      { key: 'silently_dropped', label: 'Silently Dropped', severity: 'Low', desc: 'Part of your request that no later message or action seems to cover. This check is often wrong: it can take pasted text, quotes or command output for a request. Treat it as a prompt to look, not a finding.' },
      { key: 'undisclosed', label: 'Undisclosed', severity: 'Medium', desc: 'This file changed during the session, but no claim or request mentioned it. The agent made a change it never told you about. Could be benign (auto-formatting) or concerning (unintended side effects).' },
      { key: 'untracked_write', label: 'Untracked Write', severity: 'Critical', desc: 'The disk changed and no tool call in that turn disclosed it. The independent disk watcher saw a change the agent\\u2019s own tool stream never reported. It may be another program, another session, or a change made inside a shell command.' },
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
    // HTML1: the Metrics section described three scores from the model comparison NI1 removed (LD264); nothing on
    // this page shows them, so it is gone. What the page counts:
    html += '<h4 style="color:#e7edf3;font-size:1rem;margin:28px 0 6px;">Counts on this page</h4>';
    html += '<div style="padding:8px 16px;margin:4px 0;background:#0e1219;border-radius:8px;font-size:.84rem;color:#cfd8e3;">'
      + '<b>Touches</b>: every recorded contact (a read, a write, a command, a network call, a tool use). '
      + '<b>Things</b>: the distinct files, commands and endpoints touched. '
      + '<b>Turns checked</b>: turns whose claims were compared with the record; with none, the page says <b>Not checked</b>, never clean.</div>';
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
      // HTML1: the Graph's folders (src/render/graph2d.js): the project's prefix off, one row per file however written.
      var Fo = orunmilaGraph2DCore.folders(withPath);
      var byDir={};
      withPath.forEach(function(n){
        if (Fo.repOf(n.id) !== n.id) return;
        var f = String(n.path).split(/[\\\\/]/).pop();
        var d = Fo.folder.get(n.id);
        (byDir[d]=byDir[d]||[]).push({f:f,n:n,t:Fo.touches.get(n.id)});
      });
      var maxT = 1;
      Object.keys(byDir).forEach(function(d){ byDir[d].forEach(function(it){ if (it.t > maxT) maxT = it.t; }); });
      Object.keys(byDir).sort().forEach(function(d){
        rows += '<div class="row"><span class="dir">'+escjs(d)+'/</span></div>';
        byDir[d].sort(function(a,b){ return b.t - a.t; }).forEach(function(it){
          var c=colorOf(it.n.stain, it.n.primaryChannel);
          var w=8+Math.round(160*it.t/maxT);
          rows += '<div class="row" style="padding-left:16px" data-ni="'+it.n.id+'" title="'+escjs(explainOf(it.n.stain,it.n.primaryChannel))+'">'
            + '<span class="bar" style="width:'+w+'px;background:'+c+'"></span>'
            + '<span class="nm">'+escjs(it.f)+'</span> <span class="dir">&middot; '+it.t+'</span></div>';
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
  // HTML1: touches of one thing in a row fold into one line with a count, and a turn shows its first 150 lines with
  // a button for the rest (860f51e9's one turn was a single column of 877 lines).
  var timelineAll = {};
  function renderTimeline(){
    var el = document.getElementById('gv-timeline');
    var CAP = 150;
    var cols = DATA.turns.map(function(t){
      var rows = DATA.trail.filter(function(r){ return r.turn===t.turn_id && trailPassesFilter(r); });
      var runs = orunmilaGraph2DCore.runs(rows);
      var shown = timelineAll[t.turn_id] ? runs : runs.slice(0, CAP);
      var pips = shown.map(function(run){
        var r = rows[run.first];
        var c=colorOf(r.stain, r.channel);
        return '<div class="gv-tdot" data-turn="'+escjs(t.turn_id)+'" data-first="'+run.first+'" title="'+escjs(r.channel+': '+r.label)+'"><span class="pip" style="background:'+c+'"></span><span class="tx">'+escjs(trunc(r.label,22))+'</span>'+(run.count > 1 ? '<span class="cnt">&times;'+run.count+'</span>' : '')+'</div>';
      }).join('');
      var more = runs.length > shown.length ? '<button class="gv-gbtn gv-tmore" data-turn="'+escjs(t.turn_id)+'">Show all '+runs.length+' lines</button>' : '';
      return '<div class="gv-tcol"><h5>'+escjs(t.turn_id)+' &middot; '+t.touches+' touches</h5><div class="prompt">'+escjs(trunc(t.prompt,70))+'</div>'+(pips||'<span class="dir" style="font-size:.72rem">no touches</span>')+more+'</div>';
    }).join('');
    el.innerHTML = renderFilterBar('timeline') + legend() + '<div class="gv-time">'+cols+'</div>';

    el.querySelectorAll('.gv-tdot').forEach(function(dot){
      dot.addEventListener('click', function(){
        var turnId = dot.dataset.turn, first = parseInt(dot.dataset.first, 10);
        var matching = DATA.trail.filter(function(r){ return r.turn===turnId && trailPassesFilter(r); });
        if (matching[first]) showTrailDetail(matching[first]);
      });
    });
    el.querySelectorAll('.gv-tmore').forEach(function(b){
      b.addEventListener('click', function(){ timelineAll[b.dataset.turn] = true; rendered.timeline=false; renderTimeline(); });
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
      + (DATA.checked
        ? '<div class="gv-card"><h5>What orunmila found</h5><div class="gv-donut-wrap">'+donutSvg+'<div class="gv-donut-legend">'+donutLegend+'</div></div></div>'
        : '<div class="gv-card"><h5>What orunmila found</h5><p class="gv-unchecked">Not checked: no turn of this session has a report, so nothing here is called clean.</p></div>')
      + '<div class="gv-card"><h5>Kinds of contact</h5><div class="gv-bars">'+bars(DATA.channelTally,'channel')+'</div></div>'
      + '<div class="gv-card"><h5>Busiest turns</h5><div class="gv-bars">'+turnBars+'</div></div>'
      + '<div class="gv-card"><h5>Most-touched things</h5><div class="gv-bars">'+topBars+'</div></div>'
      + '</div>';
  }

  function renderReport() {
    var el = document.getElementById('gv-report');
    var findings = DATA.findings || [];
    if (!DATA.checked) {
      el.innerHTML = '<div class="gv-nothing gv-unchecked">Not checked: no turn of this session has a report, so no claim was compared with the record.</div>';
      return;
    }
    if (!findings.length) {
      el.innerHTML = '<div class="gv-nothing">✓ No findings in the ' + DATA.checkedTurns + ' checked turn' + (DATA.checkedTurns === 1 ? '' : 's') + '.</div>';
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
    promptLines.push('Orunmila compared what you said in our last session with what its record shows. These ' + findings.length + ' item' + (findings.length === 1 ? '' : 's') + ' need a second look. For each one: show me the evidence, or fix it, or tell me it was not done.\\n');

    var phantoms = findings.filter(function(f){ return f.type === 'phantom'; });
    var pvs = findings.filter(function(f){ return f.type === 'phantom_verification'; });
    var partials = findings.filter(function(f){ return f.type === 'partial'; });
    var dropped = findings.filter(function(f){ return f.type === 'silently_dropped'; });
    var undiscl = findings.filter(function(f){ return f.type === 'undisclosed'; });
    var untracked = findings.filter(function(f){ return f.type === 'untracked_write'; });

    if (phantoms.length) {
      promptLines.push('## Claims the record does not show');
      for (var pi = 0; pi < phantoms.length; pi++) {
        promptLines.push('- You said: "' + phantoms[pi].text + '". No file change, command or tool call in that turn shows it.');
      }
      promptLines.push('');
    }
    if (pvs.length) {
      promptLines.push('## Checks claimed with no passing run');
      for (var vi = 0; vi < pvs.length; vi++) {
        promptLines.push('- You said: "' + pvs[vi].text + '". No passing test or command ran in that turn. Run it and show me the result.');
      }
      promptLines.push('');
    }
    if (partials.length) {
      promptLines.push('## Changes that look like scaffolding only');
      for (var ai = 0; ai < partials.length; ai++) {
        var pp = partials[ai].paths.length ? ' (' + partials[ai].paths.join(', ') + ')' : '';
        promptLines.push('- "' + partials[ai].text + '"' + pp + ': the change looks like a stub. Is the work finished?');
      }
      promptLines.push('');
    }
    if (dropped.length) {
      promptLines.push('## Parts of my request that may have been missed (this check is often wrong: skip any line that was not a request)');
      for (var di = 0; di < dropped.length; di++) {
        promptLines.push('- "' + dropped[di].text + '": done, not done, or not a request?');
      }
      promptLines.push('');
    }
    if (undiscl.length) {
      promptLines.push('## Files changed that no claim or request mentions');
      for (var ui = 0; ui < undiscl.length; ui++) {
        promptLines.push('- ' + undiscl[ui].text + ': why did it change?');
      }
      promptLines.push('');
    }
    if (untracked.length) {
      promptLines.push('## Disk changes no tool call reported');
      for (var ti = 0; ti < untracked.length; ti++) {
        promptLines.push('- ' + untracked[ti].text + ' changed on disk, and no tool call in that turn reported it. What changed it?');
      }
      promptLines.push('');
    }

    promptLines.push('Answer item by item, with the command or file that shows each answer.');

    var promptText = promptLines.join('\\n');

    var promptHtml = '<div class="gv-report-section"><h4>Copy-paste prompt</h4>'
      + '<p style="color:#7d8694;font-size:.78rem;margin:0 0 10px;">Paste this back to the agent. It asks, item by item, for the evidence or a fix.</p>'
      + '<div class="gv-prompt-wrap">'
      + '<button class="gv-copy-btn" id="gv-copy-prompt">Copy</button>'
      + '<pre class="gv-prompt" id="gv-prompt-text">' + escjs(promptText) + '</pre>'
      + '</div></div>';

    el.innerHTML = statHtml + promptHtml + findingsHtml;

    document.getElementById('gv-copy-prompt').addEventListener('click', function() {
      var text = promptText;
      var btn = this;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          btn.textContent = '✓ Copied';
          btn.classList.add('copied');
          setTimeout(function(){ btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
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
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(function(){ btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      }
    });
  }

  // HTML1: closed by default (it sat open above every tab), and every channel the tabs draw (disk and tool were missing).
  function legend(){
    var stains=['verified','partial','phantom','undisclosed','untracked_write'];
    var chans=['read','write','disk','command','network','tool'];
    var s = stains.map(function(k){return '<span class="it" style="color:'+P.stain[k]+'" title="'+escjs(P.explain[k])+'"><span class="gv-dot" style="background:'+P.stain[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k.replace(/_/g,' ')+'</span></span>';}).join('');
    var c = chans.map(function(k){return '<span class="it" style="color:'+P.channel[k]+'" title="'+escjs(P.explain[k])+'"><span class="gv-dot" style="background:'+P.channel[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k+'</span></span>';}).join('');
    return '<details class="gv-legbox"><summary>Colour legend</summary><div class="gv-legend">'+s+c+'</div></details>';
  }

  function trunc(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'\\u2026' : s; }
  function escjs(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var RENDERERS = { graph:renderGraph, map3d:renderMap3D, tree:renderTree, timeline:renderTimeline, dashboard:renderDashboard, report:renderReport, glossary:renderGlossary };
  var rendered = {};
  function show(view){
    document.querySelectorAll('.gv-tab').forEach(function(t){ t.classList.toggle('on', t.dataset.view===view); });
    document.querySelectorAll('.gv-view').forEach(function(v){ v.classList.toggle('on', v.dataset.view===view); });
    if (map3d) { if (view === 'map3d') map3d.resume(); else map3d.pause(); }
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

  // A link may name the tab to open (#map3d, #graph, ...); anything else opens the timeline.
  var asked = String(location.hash || '').slice(1);
  show(Object.prototype.hasOwnProperty.call(RENDERERS, asked) ? asked : 'timeline');
})();
</script>
`;
}

module.exports = { buildVizData, renderTrailVisual, STAIN_COLORS, CHANNEL_COLORS, CHANNEL_GLYPH };
