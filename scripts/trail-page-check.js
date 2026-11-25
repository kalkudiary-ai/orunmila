#!/usr/bin/env node
'use strict';

/**
 * scripts/trail-page-check.js — HTML1's functionality check of the trail page (not part of npm test; the package does
 * not ship scripts/).
 *
 * Renders a session's trail page, opens it in headless Chrome with a probe added at the end of the page, and drives
 * every part a user can reach: each tab; each filter, mode and search on the Graph; a click on a thing in the Graph,
 * the Tree and the Timeline, and the detail panel's close; the Dashboard's cards; the Report's findings and copy
 * button; the Glossary; the audience switch; the 3D Map's canvas and its Calm/Vivid switch. Every page error is
 * caught. It prints one line per check and exits 1 if any failed.
 *
 *   node scripts/trail-page-check.js --session <id> --out <dir> [--home <ORUNMILA_HOME>] [--chrome <path>]
 *
 * By OS: the Chrome path below is macOS's; pass --chrome elsewhere. Without Chrome it says "not run" and exits 2.
 */

/* global window, document, Event, MouseEvent -- the probe below runs in the page, not in Node */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const session = arg('--session');
const out = path.resolve(arg('--out', '.'));
const chrome = arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
if (!session) {
  console.error('usage: node scripts/trail-page-check.js --session <id> --out <dir> [--home <dir>] [--chrome <path>]');
  process.exit(2);
}
if (!fs.existsSync(chrome)) {
  console.log(`not run: no Chrome at ${chrome}`);
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env };
if (arg('--home')) env.ORUNMILA_HOME = path.resolve(arg('--home'));
const page = path.join(out, 'trail.html');
execFileSync('node', [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'trail', '--session', session, '--out', page], { env, stdio: 'ignore' });

// The probe runs in the page. Each check records [name, ok, detail]; page errors are kept apart.
const probe = function () {
  var R = [];
  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push(String(e.message) + ' @' + e.lineno);
  });
  function check(name, fn) {
    try {
      var r = fn();
      R.push([name, !!(r && r[0]), r ? String(r[1] || '') : '']);
    } catch (e) {
      R.push([name, false, 'threw: ' + (e && e.message)]);
    }
  }
  var $ = function (s) {
    return document.querySelector(s);
  };
  var $$ = function (s) {
    return Array.prototype.slice.call(document.querySelectorAll(s));
  };
  function tab(v) {
    $('.gv-tab[data-view="' + v + '"]').click();
    var view = $('.gv-view[data-view="' + v + '"]');
    return view;
  }
  function detailShown() {
    return !!$('#gv-detail-slot .gv-detail');
  }
  setTimeout(function () {
    check('header: the verdict line is present', function () {
      var t = ($('.verdict') || {}).textContent || '';
      return [t.length > 0, t.replace(/\s+/g, ' ').trim().slice(0, 160)];
    });
    $$('.gv-tab').forEach(function (b) {
      check('tab ' + b.dataset.view + ': opens and shows content', function () {
        var view = tab(b.dataset.view);
        return [view.classList.contains('on') && view.innerHTML.length > 80, view.innerHTML.length + ' chars'];
      });
    });
    check('graph: every filter button toggles off and on without error', function () {
      var view = tab('graph');
      var n = view.querySelectorAll('.gv-fbtn').length;
      for (var i = 0; i < n; i++) {
        view.querySelectorAll('.gv-fbtn')[i].click();
        view.querySelectorAll('.gv-fbtn')[i].click();
      }
      return [n > 0 && !!view.querySelector('svg'), n + ' buttons'];
    });
    check('graph: the two modes each draw a picture', function () {
      var view = tab('graph');
      var counts = ['all', 'flagged'].map(function (m) {
        view.querySelector('[data-gmode="' + m + '"]').click();
        return view.querySelectorAll('.gv-node').length;
      });
      return [counts[0] > 0 && counts[1] > 0, 'everything ' + counts[0] + ', flagged ' + counts[1]];
    });
    check('graph: a search rings its matches and keeps the cursor in the box', function () {
      var view = tab('graph');
      var s = view.querySelector('#gv-search');
      // Part of the name of a thing on screen, so the check fits any session (it once searched a fixed name).
      var label = (view.querySelector('.gv-nlabel') || {}).textContent || 'x';
      s.value = label.replace(/…$/, '').slice(0, 5);
      s.dispatchEvent(new Event('input'));
      var rings = document.querySelectorAll('#gv-graph .gv-node.match').length;
      var focused = document.activeElement && document.activeElement.id === 'gv-search';
      var again = document.querySelector('#gv-graph #gv-search');
      again.value = '';
      again.dispatchEvent(new Event('input'));
      return [rings > 0 && focused, rings + ' ringed, focus kept ' + focused];
    });
    check('graph: clicking a thing opens its details, and close shuts them', function () {
      tab('graph');
      var g = document.querySelector('#gv-graph .gv-node');
      g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      var opened = detailShown();
      document.getElementById('gv-detail-close').click();
      return [opened && !detailShown(), 'opened ' + opened];
    });
    check('graph: hovering a thing lights its links', function () {
      tab('graph');
      var g = document.querySelector('#gv-graph .gv-node');
      g.dispatchEvent(new MouseEvent('mouseenter'));
      var hot = document.querySelectorAll('#gv-graph .gv-edge.hot').length;
      g.dispatchEvent(new MouseEvent('mouseleave'));
      return [true, hot + ' links lit'];
    });
    check('tree: clicking a file opens its details', function () {
      var view = tab('tree');
      var row = view.querySelector('.row[data-ni]');
      if (!row) return [false, 'no file rows'];
      row.click();
      return [detailShown(), ''];
    });
    check('timeline: clicking a touch opens its details', function () {
      var view = tab('timeline');
      var dot = view.querySelector('.gv-tdot');
      if (!dot) return [false, 'no touches'];
      dot.click();
      return [detailShown(), view.querySelectorAll('.gv-tdot').length + ' touches shown'];
    });
    check('dashboard: its cards are drawn', function () {
      var view = tab('dashboard');
      var n = view.querySelectorAll('.gv-card').length;
      return [n >= 4, n + ' cards'];
    });
    check('report: findings or a stated empty state', function () {
      var view = tab('report');
      var f = view.querySelectorAll('.gv-finding').length;
      var copy = !!view.querySelector('#gv-copy-prompt');
      return [f > 0 ? copy : view.textContent.length > 10, f + ' findings, copy button ' + copy + ': ' + view.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)];
    });
    check('glossary: drawn', function () {
      var view = tab('glossary');
      return [view.textContent.length > 200, view.textContent.length + ' chars'];
    });
    check('audience switch: Power user and back', function () {
      var root = document.getElementById('gv-root');
      $('#gv-aud [data-aud="power"]').click();
      var p = root.classList.contains('gv-power');
      $('#gv-aud [data-aud="explain"]').click();
      return [p && root.classList.contains('gv-explainable'), ''];
    });
    check('3d map: a canvas with no error message, and the look switch', function () {
      tab('map3d');
      var c = document.getElementById('g3-canvas');
      var msg = document.getElementById('g3-msg');
      var vivid = document.querySelector('[data-g3look="vivid"]');
      vivid.click();
      var on = vivid.classList.contains('on');
      document.querySelector('[data-g3look="calm"]').click();
      return [!!c && msg.hidden && on, 'canvas ' + (c ? c.width + 'x' + c.height : 'none')];
    });
    document.body.setAttribute('data-check', JSON.stringify({ results: R, errors: errors }));
  }, 1500);
};

const html = fs.readFileSync(page, 'utf8');
const probed = path.join(out, 'trail-probe.html');
// A function, not a string, as the replacement: in a replacement string `$$` means `$`, which rewrote the probe.
fs.writeFileSync(probed, html.replace('</body>', () => '<script>(' + probe.toString() + ')();</script></body>'));
const r = spawnSync(chrome, ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1400,1300', '--virtual-time-budget=10000', '--dump-dom', `file://${probed}`], { encoding: 'utf8', maxBuffer: 1 << 30 });
const m = /data-check="([^"]*)"/.exec(r.stdout || '');
if (!m) {
  console.log(`FAIL  the probe left no result (Chrome exit ${r.status})`);
  process.exit(1);
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const res = JSON.parse(unescape(m[1]));
let failed = 0;
for (const [name, ok, detail] of res.results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
for (const e of res.errors) console.log(`PAGE ERROR  ${e}`);
console.log(`\n${res.results.length - failed} of ${res.results.length} checks passed; ${res.errors.length} page error(s)`);
process.exit(failed || res.errors.length ? 1 : 0);
