#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/graph3d-shot.js — V3D's browser check (not part of npm test; the package does not ship scripts/).
 *
 * Renders the trail page for a session and screenshots its 3D Map tab in each headless browser found: at rest, and
 * with the replay scrubbed part-way. It judges nothing in the pictures; read them: the spheres glow, the links and sparkles show, the dust
 * drifts, the labels do not overlap, and mid-replay the untouched things are dim and the current one is lit and named.
 *
 *   node scripts/graph3d-shot.js --session <id> --out <dir> [--home <ORUNMILA_HOME>]
 *
 * By OS: the browser paths below are macOS's; on Linux and Windows pass --chrome <path> and --firefox <path>. A
 * browser that is not found is named as not run, never skipped silently. It reads the session's records and writes
 * only into --out.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}

const session = arg('--session');
const out = path.resolve(arg('--out', '.'));
if (!session) {
  console.error('usage: node scripts/graph3d-shot.js --session <id> --out <dir> [--home <dir>] [--chrome <path>] [--firefox <path>]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env };
if (arg('--home')) env.ORUNMILA_HOME = path.resolve(arg('--home'));

const page = path.join(out, 'trail.html');
execFileSync('node', [path.join(__dirname, '..', 'bin', 'orunmila.js'), 'trail', '--session', session, '--out', page], { env, stdio: 'inherit' });

// The same page with a few lines that scrub the replay to a third of the way, for the mid-replay picture.
const html = fs.readFileSync(page, 'utf8');
const scrub = "<script>window.addEventListener('load',function(){setTimeout(function(){var s=document.getElementById('g3-scrub');s.value=String(Math.floor(+s.max/3));s.dispatchEvent(new Event('input'));},200);});</script>";
const replayPage = path.join(out, 'trail-replay.html');
fs.writeFileSync(replayPage, html.replace('</body>', () => scrub + '</body>'));

const browsers = [
  {
    name: 'chrome',
    bin: arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    shot: (bin, url, png) => spawnSync(bin, ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1400,1300', '--virtual-time-budget=8000', `--screenshot=${png}`, url], { encoding: 'utf8' }),
  },
  {
    name: 'firefox',
    bin: arg('--firefox', '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox'),
    shot: (bin, url, png) => {
      const prof = fs.mkdtempSync(path.join(out, 'ff-profile-'));
      const r = spawnSync(bin, ['--headless', '--no-remote', '--profile', prof, '--window-size=1400,1300', '--screenshot', png, url], { encoding: 'utf8' });
      fs.rmSync(prof, { recursive: true, force: true });
      return r;
    },
  },
];

let failed = 0;
for (const b of browsers) {
  if (!fs.existsSync(b.bin)) {
    console.log(`${b.name}: not run (no browser at ${b.bin})`);
    continue;
  }
  for (const [label, file] of [['rest', page], ['replay', replayPage]]) {
    const png = path.join(out, `3d-${b.name}-${label}.png`);
    fs.rmSync(png, { force: true });
    const r = b.shot(b.bin, `file://${file}#map3d`, png);
    // This proves a picture was written, never what is in it: it does not judge pixels. Read each one. Firefox's
    // --screenshot does not wait for the page's timers, so its replay picture can show the map unscrubbed or blank.
    const ok = r.status === 0 && fs.existsSync(png) && fs.statSync(png).size > 0;
    if (!ok) failed++;
    console.log(`${b.name} ${label}: ${ok ? `wrote ${png} (not judged: read it)` : `FAILED (exit ${r.status})`}`);
  }
}
process.exit(failed ? 1 : 0);
