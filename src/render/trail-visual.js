'use strict';

/**
 * trail-visual.js
 *
 * The rich, stain-first visual layer for the trail report (the glove). Produces a single
 * self-contained block (style + markup + inline vanilla-JS) that renders FOUR
 * tabbed views over the same data:
 *
 *   Graph     - force-directed-ish node/line map ("sensors" = artifacts,
 *               lines = lineage). The literal "dye spreading on contact" view.
 *   Tree      - the project as a directory tree, each leaf glowing by stain.
 *   Timeline  - left-to-right, turn by turn, every touch as a dot in order.
 *   Dashboard - charts: channel donut, touches-per-turn bars, top artifacts.
 *
 * Two cross-cutting controls:
 *   - Audience toggle: "Explain it to me" (plain-language, full legend, English
 *     tooltips) vs "Power user" (dense, terse). One file serves both.
 *   - Stain-first: every node/line/bar is colored by the orunmila OUTCOME
 *     (verified/phantom/undisclosed/untracked/...) when one exists for that
 *     artifact, falling back to the trail CHANNEL color otherwise. The thing no
 *     generic trace tool can show is always the hero.
 *
 * Zero dependencies: hand-rolled SVG + DOM, no CDN, no build. Opens offline.
 *
 * It is given a pre-built `vizData` object (see buildVizData below, fed by
 * trail/index's model) so this file is pure rendering — no event-log access here.
 */

// Stain (orunmila outcome) palette — mirrors render/html.js COLORS so the two
// views speak one language. Kept local so this file stands alone.
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

// Trail channel palette (fallback when an artifact has no orunmila outcome).
const CHANNEL_COLORS = {
  read: '#40c4ff',
  write: '#69f0ae',
  disk: '#1de9b6',
  command: '#ffab40',
  network: '#e040fb',
  tool: '#b0bec5',
};

const CHANNEL_GLYPH = { read: '\u{1F441}', write: '\u270E', disk: '\u{1F4BE}', command: '$', network: '\u{1F310}', tool: '\u2699' };

// Plain-language explanations surfaced in "Explain it to me" mode.
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

/**
 * Build the compact data object the client script renders from.
 * @param {object} model   output of trailForSession (the trail/glove model)
 * @param {Map<string,string>} stainByKey  artifactKey/path -> worst orunmila outcome
 */
function buildVizData(model, stainByKey) {
  const nodes = [];
  const seen = new Map();
  const nodeIndex = (key) => {
    if (seen.has(key)) return seen.get(key);
    const i = nodes.length;
    seen.set(key, i);
    nodes.push(null); // placeholder, filled below
    return i;
  };

  for (const a of model.artifacts || []) {
    const i = nodeIndex(a.key);
    const stain = (stainByKey && (stainByKey.get(a.path) || stainByKey.get(a.key))) || null;
    const primaryChannel = (a.channels && a.channels[0]) || 'tool';
    nodes[i] = {
      id: i,
      key: a.key,
      label: a.label || a.key,
      path: a.path || null,
      channels: a.channels || [],
      primaryChannel,
      touches: a.touch_count || 0,
      stain,                       // orunmila outcome, or null
      tainted_by: (a.touched_by || []).length,
    };
  }

  // Edges: aggregate lineage across all turns, dedup by from->to.
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
        turn: t.turn_id,
        key: row.key,
        node: nodeIndex(row.key),
        channel: row.channel,
        label: row.path || row.host || row.command || row.target || row.key,
        failed: !!row.failed,
        stain: (stainByKey && (stainByKey.get(row.path) || stainByKey.get(row.key))) || null,
      });
    }
  }
  // Backfill any node referenced only by an edge/trail (defensive).
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i]) {
      const key = [...seen.entries()].find(([, idx]) => idx === i)[0];
      nodes[i] = { id: i, key, label: key, path: null, channels: ['tool'], primaryChannel: 'tool', touches: 0, stain: null, tainted_by: 0 };
    }
  }

  // Per-turn touch counts for the timeline + bar chart.
  const turns = (model.turns || []).map((t) => ({
    turn_id: t.turn_id,
    prompt: t.prompt || '',
    touches: (t.trail || []).length,
  }));

  // Channel + stain tallies for the dashboard.
  const channelTally = {};
  const stainTally = {};
  for (const n of nodes) {
    channelTally[n.primaryChannel] = (channelTally[n.primaryChannel] || 0) + 1;
    const s = n.stain || 'clean';
    stainTally[s] = (stainTally[s] || 0) + 1;
  }

  return {
    session: model.session_id,
    totals: model.totals || { turns: turns.length, artifacts: nodes.length, touches: trail.length },
    nodes,
    edges: [...edgeSet.values()],
    trail,
    turns,
    channelTally,
    stainTally,
    palette: { stain: STAIN_COLORS, channel: CHANNEL_COLORS, glyph: CHANNEL_GLYPH, explain: EXPLAIN },
  };
}

// The whole interactive block: CSS + tab markup + the data blob + the engine.
function renderTrailVisual(vizData) {
  // Inline the data as a JS object literal (JSON is a subset of JS), NOT inside
  // a quoted string passed to JSON.parse — that double-encoding turned the \n
  // escapes JSON.stringify emits for newline-bearing command labels back into
  // real newlines, splitting the <script> literal. We only need to neutralise
  // the few sequences that are unsafe inside a <script> element:
  //   </ (would close the script early), and the raw line separators
  //   U+2028 / U+2029 (legal in JSON, illegal as raw JS source).
  const json = JSON.stringify(vizData)
    .replace(/</g, '\\u003c')
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
  .gv-legend { display:flex; gap:14px; flex-wrap:wrap; margin:4px 0 14px; font-size:.78rem; color:#aeb8c4; }
  .gv-legend .it { display:flex; align-items:center; gap:6px; }
  .gv-dot { width:11px; height:11px; border-radius:50%; box-shadow:0 0 8px currentColor; }
  .gv-hint { color:#7d8694; font-size:.82rem; margin:0 0 12px; }
  .gv-explainable .gv-hint { display:block; }
  .gv-power .gv-hint { display:none; }
  .gv-power .gv-legend .lbl-long { display:none; }
  .gv-explainable .gv-legend .lbl-short { display:none; }
  svg.gv-svg { width:100%; height:520px; display:block; background:radial-gradient(circle at 50% 40%,#0e1219,#070809); border-radius:10px; }
  .gv-node { cursor:pointer; }
  .gv-node circle { transition:r .12s, filter .12s; }
  .gv-node:hover circle { filter:brightness(1.4); }
  .gv-edge { stroke-opacity:.34; }
  .gv-tip { position:absolute; pointer-events:none; background:#0b0e13; border:1px solid #2a3340; border-radius:8px; padding:8px 11px; font-size:.8rem; color:#e7edf3; max-width:300px; box-shadow:0 8px 26px rgba(0,0,0,.6); opacity:0; transition:opacity .1s; z-index:5; }
  .gv-tip b { color:#fff; } .gv-tip .ex { color:#9ad; display:block; margin-top:4px; }
  .gv-tree { font-family:ui-monospace,Menlo,monospace; font-size:.86rem; line-height:1.7; }
  .gv-tree .row { display:flex; align-items:center; gap:8px; padding:1px 0; }
  .gv-tree .bar { height:9px; border-radius:5px; box-shadow:0 0 8px currentColor; }
  .gv-tree .nm { color:#cfd8e3; } .gv-tree .dir { color:#6f7b88; }
  .gv-time { display:flex; gap:18px; overflow-x:auto; padding-bottom:10px; }
  .gv-tcol { min-width:150px; flex:0 0 auto; }
  .gv-tcol h5 { margin:0 0 8px; font-size:.78rem; color:#9aa6b2; font-weight:700; }
  .gv-tcol .prompt { color:#6f7b88; font-size:.72rem; margin-bottom:8px; min-height:2.2em; }
  .gv-tdot { display:flex; align-items:center; gap:7px; padding:4px 7px; border-radius:7px; background:#0e1219; margin:3px 0; font-size:.76rem; }
  .gv-tdot .pip { width:9px; height:9px; border-radius:50%; box-shadow:0 0 7px currentColor; flex:0 0 auto; }
  .gv-tdot .tx { color:#c4cdd8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .gv-dash { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:18px; }
  .gv-card { background:#0e1219; border:1px solid #1f2630; border-radius:12px; padding:16px; }
  .gv-card h5 { margin:0 0 12px; font-size:.82rem; color:#aeb8c4; text-transform:uppercase; letter-spacing:.04em; }
  .gv-bars .b { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:.8rem; }
  .gv-bars .b .fill { height:14px; border-radius:4px; box-shadow:0 0 8px currentColor; }
  .gv-bars .b .v { color:#9aa6b2; min-width:1.6em; }
  .gv-kpi { display:flex; gap:22px; }
  .gv-kpi .k { text-align:center; } .gv-kpi .k .n { font-size:1.9rem; font-weight:800; } .gv-kpi .k .l { font-size:.72rem; color:#7d8694; text-transform:uppercase; }
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
    <button class="gv-tab on" data-view="graph">Graph</button>
    <button class="gv-tab" data-view="tree">Tree</button>
    <button class="gv-tab" data-view="timeline">Timeline</button>
    <button class="gv-tab" data-view="dashboard">Dashboard</button>
  </div>
  <div class="gv-stage">
    <p class="gv-hint" id="gv-hint"></p>
    <div class="gv-view on" data-view="graph" id="gv-graph"></div>
    <div class="gv-view" data-view="tree" id="gv-tree"></div>
    <div class="gv-view" data-view="timeline" id="gv-timeline"></div>
    <div class="gv-view" data-view="dashboard" id="gv-dashboard"></div>
    <div class="gv-tip" id="gv-tip"></div>
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
  document.getElementById('gv-sub').textContent = DATA.totals.touches + ' touches / ' + DATA.totals.artifacts + ' things / ' + DATA.totals.turns + ' turns';

  var HINTS = {
    graph: 'Each glowing dot is something the agent touched. Lines mean the dye spread: the agent read one thing, then changed another in the same turn (an inferred link, not proof). Color = what orunmila found; bright red/purple = something worth a look.',
    tree: 'Your project laid out as folders. Each bar glows by how the agent touched that file and whether orunmila flagged it.',
    timeline: 'The session left to right, one column per turn. Each pip is one action, in the order it happened.',
    dashboard: 'The numbers at a glance: what kinds of contact happened, how busy each turn was, and which things got touched most.'
  };

  function setHint(v){ document.getElementById('gv-hint').textContent = HINTS[v] || ''; }

  function tipShow(html, x, y){ tip.innerHTML = html; tip.style.opacity='1'; tip.style.left=(x+14)+'px'; tip.style.top=(y+10)+'px'; }
  function tipHide(){ tip.style.opacity='0'; }
  function stageXY(e){ var r = root.querySelector('.gv-stage').getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; }

  // ---- GRAPH (radial sensor map + lineage lines) ----
  function renderGraph(){
    var el = document.getElementById('gv-graph');
    var W=900, H=520, cx=W/2, cy=H/2;
    var n = DATA.nodes.length || 1;
    // Deterministic radial layout: ring radius scales with touch count so busy
    // nodes sit toward the centre. Stable (no physics needed, zero-dep).
    var positions = DATA.nodes.map(function(nd, i){
      var ang = (i / n) * Math.PI * 2 - Math.PI/2;
      var maxT = Math.max.apply(null, DATA.nodes.map(function(x){return x.touches;}).concat([1]));
      var rad = 70 + (1 - nd.touches/maxT) * 150;
      return { x: cx + Math.cos(ang)*rad, y: cy + Math.sin(ang)*rad };
    });
    var svg = '<svg class="gv-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">';
    DATA.edges.forEach(function(e){
      var a=positions[e.from], b=positions[e.to]; if(!a||!b) return;
      var c = colorOf(DATA.nodes[e.to].stain, DATA.nodes[e.to].channels[0]);
      svg += '<path class="gv-edge" d="M'+a.x.toFixed(1)+' '+a.y.toFixed(1)+' Q '+cx+' '+cy+' '+b.x.toFixed(1)+' '+b.y.toFixed(1)+'" fill="none" stroke="'+c+'" stroke-width="1.3"/>';
    });
    DATA.nodes.forEach(function(nd,i){
      var p=positions[i]; var c=colorOf(nd.stain, nd.primaryChannel);
      var r = 6 + Math.min(18, nd.touches*1.4);
      var g = P.glyph[nd.primaryChannel] || '';
      svg += '<g class="gv-node" data-i="'+i+'" transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')">';
      svg += '<circle r="'+r+'" fill="'+c+'" fill-opacity="0.28" stroke="'+c+'" stroke-width="1.8" style="filter:drop-shadow(0 0 6px '+c+')"/>';
      svg += '<text text-anchor="middle" dy="3" font-size="11" fill="#dfe7ef">'+g+'</text>';
      svg += '<text text-anchor="middle" y="'+(r+12)+'" font-size="9.5" fill="#8d99a6">'+escjs(trunc(nd.label,16))+'</text>';
      svg += '</g>';
    });
    svg += '</svg>';
    el.innerHTML = legend() + svg;
    el.querySelectorAll('.gv-node').forEach(function(g){
      g.addEventListener('mousemove', function(ev){
        var nd = DATA.nodes[+g.dataset.i]; var xy=stageXY(ev);
        var label = (nd.stain ? nd.stain.replace(/_/g,' ') : nd.primaryChannel);
        tipShow('<b>'+escjs(nd.label)+'</b> &mdash; '+escjs(label)+'<br>'+nd.touches+' touches'+(nd.tainted_by?(' &middot; stained by '+nd.tainted_by):'')+'<span class="ex">'+escjs(explainOf(nd.stain,nd.primaryChannel))+'</span>', xy[0], xy[1]);
      });
      g.addEventListener('mouseleave', tipHide);
    });
  }

  // ---- TREE (project folders, bars glow by stain) ----
  function renderTree(){
    var el = document.getElementById('gv-tree');
    var withPath = DATA.nodes.filter(function(n){return n.path;});
    var rows='';
    if(!withPath.length){
      rows = '<p class="gv-hint" style="display:block">No file paths in this session yet (it was mostly commands / ran before the capture upgrade). File reads &amp; writes will appear here on your next session.</p>';
    } else {
      // group by directory
      var byDir={};
      withPath.forEach(function(n){ var parts=n.path.split(/[\\/]/); var f=parts.pop(); var d=parts.join('/')||'.'; (byDir[d]=byDir[d]||[]).push({f:f,n:n}); });
      Object.keys(byDir).sort().forEach(function(d){
        rows += '<div class="row"><span class="dir">'+escjs(d)+'/</span></div>';
        byDir[d].forEach(function(it){
          var c=colorOf(it.n.stain, it.n.primaryChannel);
          var w=20+Math.min(160, it.n.touches*10);
          rows += '<div class="row" style="padding-left:16px" title="'+escjs(explainOf(it.n.stain,it.n.primaryChannel))+'">'
            + '<span class="bar" style="width:'+w+'px;background:'+c+';color:'+c+'"></span>'
            + '<span class="nm">'+escjs(it.f)+'</span> <span class="dir">&middot; '+it.n.touches+'</span></div>';
        });
      });
    }
    el.innerHTML = legend() + '<div class="gv-tree">'+rows+'</div>';
  }

  // ---- TIMELINE (turn columns, pips in order) ----
  function renderTimeline(){
    var el = document.getElementById('gv-timeline');
    var cols = DATA.turns.map(function(t){
      var pips = DATA.trail.filter(function(r){return r.turn===t.turn_id;}).map(function(r){
        var c=colorOf(r.stain, r.channel);
        return '<div class="gv-tdot" title="'+escjs(explainOf(r.stain,r.channel))+'"><span class="pip" style="background:'+c+';color:'+c+'"></span><span class="tx">'+escjs(trunc(r.label,22))+'</span></div>';
      }).join('');
      return '<div class="gv-tcol"><h5>'+escjs(t.turn_id)+' &middot; '+t.touches+'</h5><div class="prompt">'+escjs(trunc(t.prompt,70))+'</div>'+(pips||'<span class="dir" style="font-size:.72rem">no touches</span>')+'</div>';
    }).join('');
    el.innerHTML = legend() + '<div class="gv-time">'+cols+'</div>';
  }

  // ---- DASHBOARD (kpis + bar charts) ----
  function renderDashboard(){
    var el = document.getElementById('gv-dashboard');
    function bars(tally, kind){
      var keys=Object.keys(tally).sort(function(a,b){return tally[b]-tally[a];});
      var max=Math.max.apply(null, keys.map(function(k){return tally[k];}).concat([1]));
      return keys.map(function(k){
        var c = kind==='stain' ? (P.stain[k]||'#888') : (P.channel[k]||'#888');
        var w = 8 + (tally[k]/max)*150;
        return '<div class="b"><span class="v">'+tally[k]+'</span><span class="fill" style="width:'+w+'px;background:'+c+';color:'+c+'"></span><span style="color:#aeb8c4">'+escjs(k.replace(/_/g,' '))+'</span></div>';
      }).join('');
    }
    var topNodes = DATA.nodes.slice().sort(function(a,b){return b.touches-a.touches;}).slice(0,8);
    var topBars = topNodes.map(function(n){
      var c=colorOf(n.stain,n.primaryChannel); var max=topNodes[0].touches||1; var w=8+(n.touches/max)*150;
      return '<div class="b"><span class="v">'+n.touches+'</span><span class="fill" style="width:'+w+'px;background:'+c+';color:'+c+'"></span><span style="color:#aeb8c4">'+escjs(trunc(n.label,22))+'</span></div>';
    }).join('');
    var turnBars = DATA.turns.map(function(t){
      var max=Math.max.apply(null,DATA.turns.map(function(x){return x.touches;}).concat([1])); var w=8+(t.touches/max)*150;
      return '<div class="b"><span class="v">'+t.touches+'</span><span class="fill" style="width:'+w+'px;background:#40c4ff;color:#40c4ff"></span><span style="color:#aeb8c4">'+escjs(t.turn_id)+'</span></div>';
    }).join('');
    el.innerHTML =
      '<div class="gv-dash">'
      + '<div class="gv-card"><h5>At a glance</h5><div class="gv-kpi">'
        + '<div class="k"><div class="n" style="color:#00e676">'+DATA.totals.touches+'</div><div class="l">touches</div></div>'
        + '<div class="k"><div class="n" style="color:#40c4ff">'+DATA.totals.artifacts+'</div><div class="l">things</div></div>'
        + '<div class="k"><div class="n" style="color:#ffab40">'+DATA.totals.turns+'</div><div class="l">turns</div></div>'
      + '</div></div>'
      + '<div class="gv-card"><h5>What orunmila found</h5><div class="gv-bars">'+bars(DATA.stainTally,'stain')+'</div></div>'
      + '<div class="gv-card"><h5>Kinds of contact</h5><div class="gv-bars">'+bars(DATA.channelTally,'channel')+'</div></div>'
      + '<div class="gv-card"><h5>Busiest turns</h5><div class="gv-bars">'+turnBars+'</div></div>'
      + '<div class="gv-card"><h5>Most-touched things</h5><div class="gv-bars">'+topBars+'</div></div>'
      + '</div>';
  }

  function legend(){
    var stains=['verified','partial','phantom','undisclosed','untracked_write'];
    var chans=['read','write','command','network'];
    var s = stains.map(function(k){return '<span class="it" style="color:'+P.stain[k]+'"><span class="gv-dot" style="background:'+P.stain[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k.replace(/_/g,' ')+'</span></span>';}).join('');
    var c = chans.map(function(k){return '<span class="it" style="color:'+P.channel[k]+'"><span class="gv-dot" style="background:'+P.channel[k]+'"></span><span class="lbl-long">'+P.explain[k]+'</span><span class="lbl-short">'+k+'</span></span>';}).join('');
    return '<div class="gv-legend">'+s+c+'</div>';
  }

  function trunc(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'\\u2026' : s; }
  function escjs(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var RENDERERS = { graph:renderGraph, tree:renderTree, timeline:renderTimeline, dashboard:renderDashboard };
  var rendered = {};
  function show(view){
    document.querySelectorAll('.gv-tab').forEach(function(t){ t.classList.toggle('on', t.dataset.view===view); });
    document.querySelectorAll('.gv-view').forEach(function(v){ v.classList.toggle('on', v.dataset.view===view); });
    if(!rendered[view]){ RENDERERS[view](); rendered[view]=true; }
    setHint(view); tipHide();
  }
  document.getElementById('gv-tabs').addEventListener('click', function(e){ if(e.target.dataset.view) show(e.target.dataset.view); });
  document.getElementById('gv-aud').addEventListener('click', function(e){
    if(!e.target.dataset.aud) return;
    document.querySelectorAll('#gv-aud button').forEach(function(b){ b.classList.toggle('on', b===e.target); });
    root.classList.toggle('gv-explainable', e.target.dataset.aud==='explain');
    root.classList.toggle('gv-power', e.target.dataset.aud==='power');
  });

  show('graph');
})();
</script>
`;
}

module.exports = { buildVizData, renderTrailVisual, STAIN_COLORS, CHANNEL_COLORS };
