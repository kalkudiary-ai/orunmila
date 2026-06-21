#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const eventlog = require('../src/store/eventlog');
const { loadReport, listSessionReports } = require('../src/reconcile');
const { renderTurn } = require('../src/render/terminal');
const { renderSessionHtml } = require('../src/render/html');
const { redactForRender } = require('../src/render/redact');
const { trailForSession } = require('../src/trail');
const transcript = require('../src/capture/transcript');
const { startSentinel } = require('../src/capture/fs-sentinel');
const { effectiveIgnore } = require('../src/capture/fs-sentinel/ignore');
const { getAdapter, listAgents, configPath } = require('../src/capture/agents');

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Claude Code's settings.json hook shape: { hooks: { EventName: [{matcher, hooks:[{type,command}]}] } }
function mergeClaudeHook(settings, eventName, matcher, command) {
  settings.hooks = settings.hooks || {};
  settings.hooks[eventName] = settings.hooks[eventName] || [];
  const already = settings.hooks[eventName].some(
    (entry) => entry.matcher === matcher && (entry.hooks || []).some((h) => h.command === command)
  );
  if (already) return;
  settings.hooks[eventName].push({ matcher, hooks: [{ type: 'command', command }] });
}

// Claude Code keeps its four purpose-named scripts (its hook system wants one
// command per event and they're the test entry points). Every other agent maps
// each of its own event names to `connector.js <agent> <phase>`.
function installClaudeCode(root, p) {
  const settings = readJson(p, {});
  // Quote the script path: it can contain spaces (e.g. C:\Users\Jane Doe\...)
  // and, on Windows, backslash separators. Both are safe inside double quotes
  // for the shell that runs the hook command on every platform.
  const s = (name) => `node "${path.join(root, 'src/capture/claude-code', name)}"`;
  mergeClaudeHook(settings, 'UserPromptSubmit', '*', s('user-prompt-submit.js'));
  mergeClaudeHook(settings, 'PreToolUse', 'Write|Edit|MultiEdit', s('pre-tool-use.js'));
  mergeClaudeHook(settings, 'PostToolUse', '*', s('post-tool-use.js'));
  mergeClaudeHook(settings, 'PostToolUseFailure', '*', s('post-tool-use.js'));
  mergeClaudeHook(settings, 'Stop', '*', s('stop.js'));
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

// Generic agents: a flat { hooks: { <theirEventName>: "node connector.js <agent> <phase>" } }
// JSON. Each adapter's `events` map declares which of its hook names maps to
// which lifecycle phase; we expand array values (e.g. two postTool variants).
function installGeneric(adapter, root, p) {
  const settings = readJson(p, {});
  settings.hooks = settings.hooks || {};
  const connector = path.join(root, 'src/capture/connector.js');
  for (const [phase, eventNames] of Object.entries(adapter.events)) {
    for (const eventName of [].concat(eventNames)) {
      settings.hooks[eventName] = `node "${connector}" ${adapter.id} ${phase}`;
    }
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

function cmdInstall() {
  const root = path.resolve(__dirname, '..');
  const agentId = flag('agent', 'claude-code');
  const adapter = getAdapter(agentId);
  if (!adapter) {
    console.error(`Unknown agent "${agentId}". Known agents:`);
    for (const a of listAgents()) console.error(`  ${a.id}\t${a.label}`);
    process.exit(1);
  }

  const global = args.includes('--global');
  const p = configPath(adapter, { global, home: os.homedir(), cwd: process.cwd() });
  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (adapter.id === 'claude-code') {
    installClaudeCode(root, p);
  } else {
    installGeneric(adapter, root, p);
  }

  console.log(`Capture hooks for ${adapter.label} installed into ${p}`);
  console.log(`Restart ${adapter.label} (or start a new session) for them to take effect.`);
}

function logSizeKB() {
  try {
    return Math.round(fs.statSync(eventlog.logPath()).size / 1024);
  } catch {
    return 0;
  }
}

function cmdStatus() {
  const all = eventlog.readAll();
  const sessions = new Set(all.map((e) => e.session_id));
  console.log(`Event log: ${eventlog.logPath()}`);
  console.log(`Events captured: ${all.length}`);
  console.log(`Log size: ${logSizeKB()} KB`);
  console.log(`Sessions seen: ${sessions.size}`);
  if (sessions.size) console.log(`Most recent session: ${eventlog.latestSessionId()}`);
  if (sessions.size > 50) {
    console.log(`\nThe log holds ${sessions.size} sessions. To cap it: orunmila prune [--keep N] (default 20).`);
  }

  // The sentinel's one deliberate blind spot, printed so it's never a mystery
  // what the "skin" cannot feel (PRD 6.4: ignore list must be visible).
  const root = process.cwd();
  const ignore = effectiveIgnore(root);
  console.log(`\nFilesystem Sentinel ignore list (root: ${root}):`);
  for (const entry of ignore) console.log(`  - ${entry}`);
  console.log('Override in .orunmila/ignore (one path per line; "!entry" un-ignores a default).');
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

// Privacy pass shared by html/trail: collapse the home-dir prefix to ~ (on by
// default; --no-redact-home opts out) and apply any `.orunmila/redact` list, on
// COPIES of the models. The event log stays complete; only the SHARED report is
// sanitised. Reports the effective redact list so what's hidden is never a mystery.
function applyRedaction(reports, trail) {
  const home = !args.includes('--no-redact-home');
  const { reports: r, trail: t, redactList } = redactForRender(reports, trail, { home, root: process.cwd() });
  if (redactList.length) {
    console.log(`Redacting ${redactList.length} path pattern(s) from the report (.orunmila/redact): ${redactList.join(', ')}`);
  }
  if (home) console.log('Home-directory prefix collapsed to ~ in the report (disable with --no-redact-home).');
  return { reports: r, trail: t };
}

function cmdHtml() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const { reports } = applyRedaction(listSessionReports(sessionId), null);
  const html = renderSessionHtml(sessionId, reports);
  const outPath = flag('out', path.join(process.cwd(), `orunmila-${sessionId}.html`));
  fs.writeFileSync(outPath, html);
  console.log(`Wrote ${outPath}`);
}

function cmdTrail() {
  // The unified report: orunmila's skeptical stain PLUS the glove's complete
  // trail + lineage, both built from the one events.jsonl — one global truth.
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const rawTrail = trailForSession(sessionId);
  const { reports, trail } = applyRedaction(listSessionReports(sessionId), rawTrail);
  const html = renderSessionHtml(sessionId, reports, trail);
  const outPath = flag('out', path.join(process.cwd(), `orunmila-trail-${sessionId}.html`));
  fs.writeFileSync(outPath, html);
  const t = rawTrail.totals;
  console.log(`Wrote ${outPath}`);
  console.log(`Trail (the glove): ${t.touches} touches across ${t.artifacts} artifacts in ${t.turns} turns.`);
}

function cmdDemo() {
  // The visual demo: seed a realistic sample session into an ISOLATED event log
  // (never the user's real ~/.orunmila) and render the genuine unified report
  // from it. The page is the real renderer output — every stain category and
  // every trail channel — so it's a faithful, regenerable preview, not a mock.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-demo-'));
  const prevHome = process.env.ORUNMILA_HOME;
  process.env.ORUNMILA_HOME = tmpHome;
  try {
    const { seedDemoSession } = require('../src/demo/seed');
    const sessionId = seedDemoSession();
    const rawTrail = trailForSession(sessionId);
    // Demo paths are already relative (src/…) and carry no real home dir, so the
    // redaction pass is a no-op here, but run it so the demo matches live output.
    const { reports, trail } = redactForRender(listSessionReports(sessionId), rawTrail, { home: true, root: process.cwd() });
    const html = renderSessionHtml(sessionId, reports, trail);
    const outPath = flag('out', path.join(process.cwd(), 'orunmila-demo.html'));
    fs.writeFileSync(outPath, html);
    const t = rawTrail.totals;
    console.log(`Wrote ${outPath}`);
    console.log(`Demo: ${t.touches} touches across ${t.artifacts} artifacts in ${t.turns} turns — open it in a browser.`);
  } finally {
    // Restore the real home and clean up the throwaway log.
    if (prevHome === undefined) delete process.env.ORUNMILA_HOME;
    else process.env.ORUNMILA_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
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
  if (!p) return console.log('Usage: orunmila debug-transcript <transcript-path>');
  const lines = transcript.readLines(p);
  console.log(`${lines.length} raw lines parsed as JSON.`);
  lines.slice(-6).forEach((l, i) => {
    const norm = transcript.normalize(l);
    console.log(`--- line ${lines.length - 6 + i} ---`);
    console.log('raw keys:', Object.keys(l));
    console.log('normalized:', norm ? `${norm.role}: ${norm.text.slice(0, 120)}` : '(no extractor matched - adjust transcript.js)');
  });
}

function cmdPrune() {
  // Explicit, opt-in log rotation. The flat JSONL log is the forensic trail, so
  // we NEVER trim it automatically — only when the user runs this, and only by
  // whole sessions (keeping a partial session would corrupt its turn lineage).
  const keep = Math.max(1, parseInt(flag('keep', '20'), 10) || 20);
  const before = logSizeKB();
  const res = eventlog.pruneToRecentSessions(keep);
  if (!res.removedSessions.length) {
    console.log(`Nothing to prune: ${res.keptSessions.length} session(s) <= keep=${keep}.`);
    return;
  }
  console.log(`Pruned ${res.removedSessions.length} old session(s), kept the ${keep} most recent.`);
  console.log(`Events: ${res.before} -> ${res.after}.  Log: ${before} KB -> ${logSizeKB()} KB.`);
  console.log('Per-session reports/cache/output sidecars for removed sessions can be deleted from');
  console.log(`  ${eventlog.dataDir()}  (reports/, cache/, output/) if you no longer need them.`);
}

function cmdAgents() {
  console.log('Supported agents (use with: orunmila install --agent <id>):\n');
  for (const a of listAgents()) {
    const adapter = getAdapter(a.id);
    console.log(`  ${a.id.padEnd(12)} ${a.label}  (config: ${adapter.config.dir}/${adapter.config.file})`);
  }
}

const COMMANDS = {
  install: cmdInstall,
  agents: cmdAgents,
  status: cmdStatus,
  prune: cmdPrune,
  report: cmdReport,
  html: cmdHtml,
  trail: cmdTrail,
  glove: cmdTrail, // alias: "the glove" is the user-facing name for the trail lens
  demo: cmdDemo,
  watch: cmdWatch,
  'watch-fs': cmdWatchFs,
  'debug-transcript': cmdDebugTranscript,
};

if (!cmd || !COMMANDS[cmd]) {
  console.log(`orunmila - claim-vs-reality verification for AI coding agents

Usage:
  orunmila install [--agent ID] [--global]     install capture hooks for an agent (default: claude-code)
  orunmila agents                    list supported agents and their config locations
  orunmila status                    show event log location, size, and counts
  orunmila prune [--keep N]          cap the log to the N most-recent sessions (default 20; explicit, never automatic)
  orunmila report [--session ID] [--turn ID]   print a terminal stain report
  orunmila html [--session ID] [--out path] [--no-redact-home]   generate the mismatch-only HTML report
  orunmila trail [--session ID] [--out path] [--no-redact-home]  unified report: complete trail (the glove) + lineage + orunmila stains
  orunmila demo [--out path]         render a sample unified report from a scripted session (no setup, for a first look)
  orunmila watch [--root dir]        live-tail new turn reports + run the filesystem sentinel
  orunmila watch-fs [--root dir]     run ONLY the filesystem sentinel (independent disk observer)
  orunmila debug-transcript <path>   inspect why transcript parsing isn't matching your install
`);
  process.exit(cmd ? 1 : 0);
}

COMMANDS[cmd]();
