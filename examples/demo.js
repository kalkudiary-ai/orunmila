'use strict';

/**
 * demo.js
 *
 * Feeds synthetic turn data straight into the matcher, bypassing the Claude
 * Code capture layer entirely. Useful for: (a) proving the reconciliation
 * logic itself works, (b) a quick look at the output format, (c) a
 * regression check after editing the heuristics.
 *
 * Run: node examples/demo.js
 */

const { reconcileTurn } = require('../src/reconcile/matcher');
const { renderTurn } = require('../src/render/terminal');
const { renderSessionHtml } = require('../src/render/html');
const fs = require('fs');
const path = require('path');

const promptText = `Add input validation to login.js, write a test for it, and update the README.`;

const claimText = `I added basic input validation to login.js. I tested it and it works. I also cleaned up a small unrelated typo in config.js.`;

const turnEvents = [
  {
    type: 'file_write',
    path: 'src/login.js',
    diff: `--- a/src/login.js\n+++ b/src/login.js\n@@\n+if (!email) throw new Error('missing email');\n+if (!password) throw new Error('missing password');\n`,
    failed: false,
  },
  // No command_run with a passing test exists - this is the phantom_verification case
  {
    type: 'file_write',
    path: 'src/config.js',
    diff: `--- a/src/config.js\n+++ b/src/config.js\n@@\n-const x=1\n+const x = 1; // fixed typo\n`,
    failed: false,
  },
  // README.js was asked for but never touched at all - silently_dropped case

  // The filesystem sentinel independently saw a write the agent's tool stream
  // never disclosed (no hook event for this path). This is the untracked_write
  // case - the headline of PRD 6.4 - and renders at the TOP of the report.
  {
    type: 'file_write',
    source: 'fs-sentinel',
    path: 'src/.env.local',
    rel_path: 'src/.env.local',
    diff: `--- a/src/.env.local\n+++ b/src/.env.local\n@@\n+SECRET_TOKEN=leaked\n`,
    change_kind: 'create',
    failed: false,
  },
];

const report = {
  session_id: 'demo-session',
  turn_id: 't1',
  generated_at: new Date().toISOString(),
  ...reconcileTurn({ promptText, claimText, turnEvents }),
};

console.log(renderTurn(report));

const outPath = path.join(__dirname, 'demo-report.html');
fs.writeFileSync(outPath, renderSessionHtml('demo-session', [report]));
console.log(`\nHTML report written to ${outPath}`);
