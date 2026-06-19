#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const eventlog = require('../src/store/eventlog');
const { loadReport, listSessionReports } = require('../src/reconcile');
const { renderTurn } = require('../src/render/terminal');
const { renderSessionHtml } = require('../src/render/html');
const transcript = require('../src/capture/claude-code/transcript');
const { startSentinel } = require('../src/capture/fs-sentinel');
const { effectiveIgnore } = require('../src/capture/fs-sentinel/ignore');

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function settingsPath() {
  const global = args.includes('--global');
  return global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function mergeHook(settings, eventName, matcher, command) {
  settings.hooks = settings.hooks || {};
  settings.hooks[eventName] = settings.hooks[eventName] || [];
  const already = settings.hooks[eventName].some(
    (entry) => entry.matcher === matcher && (entry.hooks || []).some((h) => h.command === command)
  );
  if (already) return;
  settings.hooks[eventName].push({ matcher, hooks: [{ type: 'command', command }] });
}

function cmdInstall() {
  const root = path.resolve(__dirname, '..');
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const settings = readJson(p, {});

  mergeHook(settings, 'UserPromptSubmit', '*', `node ${path.join(root, 'src/capture/claude-code/user-prompt-submit.js')}`);
  mergeHook(settings, 'PreToolUse', 'Write|Edit|MultiEdit', `node ${path.join(root, 'src/capture/claude-code/pre-tool-use.js')}`);
  mergeHook(settings, 'PostToolUse', '*', `node ${path.join(root, 'src/capture/claude-code/post-tool-use.js')}`);
  mergeHook(settings, 'PostToolUseFailure', '*', `node ${path.join(root, 'src/capture/claude-code/post-tool-use.js')}`);
  mergeHook(settings, 'Stop', '*', `node ${path.join(root, 'src/capture/claude-code/stop.js')}`);

  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  console.log(`Hooks installed into ${p}`);
  console.log('Restart Claude Code (or start a new session) for them to take effect.');
}

function cmdStatus() {
  const all = eventlog.readAll();
  const sessions = new Set(all.map((e) => e.session_id));
  console.log(`Event log: ${eventlog.logPath()}`);
  console.log(`Events captured: ${all.length}`);
  console.log(`Sessions seen: ${sessions.size}`);
  if (sessions.size) console.log(`Most recent session: ${eventlog.latestSessionId()}`);

  // The sentinel's one deliberate blind spot, printed so it's never a mystery
  // what the "skin" cannot feel (PRD 6.4: ignore list must be visible).
  const root = process.cwd();
  const ignore = effectiveIgnore(root);
  console.log(`\nFilesystem Sentinel ignore list (root: ${root}):`);
  for (const entry of ignore) console.log(`  - ${entry}`);
  console.log('Override in .stainmap/ignore (one path per line; "!entry" un-ignores a default).');
}

function cmdReport() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const turn = flag('turn', null);
  if (turn) {
    const report = loadReport(sessionId, turn);
    if (!report) return console.log(`No report for ${sessionId}/${turn} yet.`);
    console.log(renderTurn(report));
    return;
  }
  const reports = listSessionReports(sessionId);
  if (!reports.length) return console.log(`No turns reconciled yet for session ${sessionId}.`);
  for (const r of reports) console.log(renderTurn(r));
}

function cmdHtml() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const reports = listSessionReports(sessionId);
  const html = renderSessionHtml(sessionId, reports);
  const outPath = flag('out', path.join(process.cwd(), `stainmap-${sessionId}.html`));
  fs.writeFileSync(outPath, html);
  console.log(`Wrote ${outPath}`);
}

function cmdWatchFs() {
  const root = path.resolve(flag('root', process.cwd()));
  console.log(`Starting Filesystem Sentinel on ${root} - leave running, Ctrl-C to stop.\n`);
  const sentinel = startSentinel({ root, verbose: true });
  const shutdown = () => {
    sentinel.stop();
    console.log('\nFilesystem Sentinel stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdWatch() {
  // Run the sentinel alongside report-tailing so one command gives the full
  // picture: live reports AND independent disk observation (PRD 6.4 / design §2).
  const root = path.resolve(flag('root', process.cwd()));
  const sentinel = startSentinel({ root });
  process.on('SIGINT', () => {
    sentinel.stop();
    process.exit(0);
  });

  console.log('Watching for new turn reports + filesystem - leave this running, work normally in Claude Code...\n');
  const seen = new Set();
  setInterval(() => {
    const all = eventlog.readAll();
    const sessions = new Set(all.map((e) => e.session_id));
    for (const sessionId of sessions) {
      for (const report of listSessionReports(sessionId)) {
        const key = `${sessionId}/${report.turn_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(renderTurn(report));
        }
      }
    }
  }, 1500);
}

function cmdDebugTranscript() {
  const p = args[1];
  if (!p) return console.log('Usage: stainmap debug-transcript <transcript-path>');
  const lines = transcript.readLines(p);
  console.log(`${lines.length} raw lines parsed as JSON.`);
  lines.slice(-6).forEach((l, i) => {
    const norm = transcript.normalize(l);
    console.log(`--- line ${lines.length - 6 + i} ---`);
    console.log('raw keys:', Object.keys(l));
    console.log('normalized:', norm ? `${norm.role}: ${norm.text.slice(0, 120)}` : '(no extractor matched - adjust transcript.js)');
  });
}

const COMMANDS = {
  install: cmdInstall,
  status: cmdStatus,
  report: cmdReport,
  html: cmdHtml,
  watch: cmdWatch,
  'watch-fs': cmdWatchFs,
  'debug-transcript': cmdDebugTranscript,
};

if (!cmd || !COMMANDS[cmd]) {
  console.log(`stainmap - claim-vs-reality verification for AI coding agents

Usage:
  stainmap install [--global]        merge capture hooks into .claude/settings.json
  stainmap status                    show event log location and counts
  stainmap report [--session ID] [--turn ID]   print a terminal stain report
  stainmap html [--session ID] [--out path]    generate the full HTML session report
  stainmap watch [--root dir]        live-tail new turn reports + run the filesystem sentinel
  stainmap watch-fs [--root dir]     run ONLY the filesystem sentinel (independent disk observer)
  stainmap debug-transcript <path>   inspect why transcript parsing isn't matching your install
`);
  process.exit(cmd ? 1 : 0);
}

COMMANDS[cmd]();
