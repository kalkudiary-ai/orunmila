#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const eventlog = require('../src/store/eventlog');
const { loadReport, listSessionReports } = require('../src/reconcile');
const {
  rescoreAll,
  listArchives,
  loadArchivedReport,
  listArchivedSessionReports,
  KEYS: RESCORE_KEYS,
} = require('../src/reconcile/rescore');
const { renderTurn } = require('../src/render/terminal');
const { renderSessionHtml } = require('../src/render/html');
const { redactForRender } = require('../src/render/redact');
const { renderJson } = require('../src/render/json');
const { renderTrailJson } = require('../src/render/trail-json');
const feedback = require('../src/feedback');
const { trailForSession } = require('../src/trail');
const transcript = require('../src/capture/transcript');
const { startSentinel } = require('../src/capture/fs-sentinel');
const { effectiveIgnore } = require('../src/capture/fs-sentinel/ignore');
const { getAdapter, listAgents, configPath } = require('../src/capture/agents');
const { computeStats, formatStats } = require('../src/stats');

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

// The four purpose-named Claude-Code capture scripts. We detect an existing
// install by SCRIPT BASENAME (not full command string) so that a second install
// pointing at a DIFFERENT copy of orunmila (e.g. ~/.claude/orunmila/... vs
// tools/orunmila/...) is caught. Two live registrations double every captured
// event and double-bump the turn counter — the dual-install corruption — so the
// basename match is the guard, not the exact path.
const CLAUDE_HOOK_BASENAMES = [
  'user-prompt-submit.js',
  'pre-tool-use.js',
  'post-tool-use.js',
  'stop.js',
];

// Find any already-registered orunmila capture hook in a Claude settings object,
// matched by script basename. Returns [{ event, command }] for each one found so
// the caller can tell the user exactly WHERE the existing install lives.
function findExistingClaudeHooks(settings) {
  const found = [];
  const hooks = (settings && settings.hooks) || {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    for (const entry of entries || []) {
      for (const h of (entry && entry.hooks) || []) {
        const cmd = h && h.command ? String(h.command) : '';
        if (CLAUDE_HOOK_BASENAMES.some((b) => cmd.includes(b))) {
          found.push({ event: eventName, command: cmd });
        }
      }
    }
  }
  return found;
}

// Claude Code keeps its four purpose-named scripts (its hook system wants one
// command per event and they're the test entry points). Every other agent maps
// each of its own event names to `connector.js <agent> <phase>`.
//
// Returns { installed: boolean }. Refuses (installed:false) rather than adding a
// second registration when an orunmila hook already exists in this settings file
// — silently skipping would hide the dual-install; we print where it was found.
function installClaudeCode(root, p) {
  const settings = readJson(p, {});
  const existing = findExistingClaudeHooks(settings);
  if (existing.length) {
    console.error(`Refusing to install: an existing orunmila capture hook is already registered in ${p}.`);
    console.error('Two live registrations double every captured event and double-bump the turn counter (the dual-install corruption).');
    console.error('Found:');
    for (const e of existing) console.error(`  [${e.event}] ${e.command}`);
    console.error('Remove the existing registration first (or point it at this copy) before installing again.');
    return { installed: false };
  }
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
  return { installed: true };
}

// Antigravity: { "orunmila": { "EventName": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }
function installAntigravity(adapter, root, p) {
  const settings = readJson(p, {});
  settings.orunmila = settings.orunmila || {};
  const connector = path.join(root, 'src/capture/connector.js');
  for (const [phase, eventName] of Object.entries(adapter.events)) {
    const matcher = phase === 'preTool' ? (adapter.preToolMatcher || '*') : '*';
    settings.orunmila[eventName] = [
      { matcher, hooks: [{ type: 'command', command: `node "${connector}" ${adapter.id} ${phase}` }] },
    ];
  }
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

  // The law gate is a SEPARATE registration from capture, so it must be
  // installable on its own. Someone who set capture up months ago and now wants
  // the laws would otherwise be turned away by the duplicate-install guard
  // before ever reaching the gate — the feature would be unreachable for every
  // existing user, which is most of them.
  const wantsLaws = args.includes('--with-laws');
  let captureInstalled = true;

  if (adapter.id === 'claude-code') {
    const res = installClaudeCode(root, p);
    if (res && res.installed === false) {
      captureInstalled = false;
      if (!wantsLaws) {
        process.exitCode = 1;
        return;
      }
      console.log('(Capture is already installed — leaving it alone and installing the law gate only.)\n');
    }
  } else if (adapter.id === 'antigravity') {
    installAntigravity(adapter, root, p);
  } else {
    installGeneric(adapter, root, p);
  }

  if (captureInstalled) console.log(`Capture hooks for ${adapter.label} installed into ${p}`);

  // The law layer is opt-in and, when it goes in, it is READ OUT. A rule that
  // can interrupt someone's work must never be something they discover by being
  // interrupted — so installing it prints every law in force, its severity, and
  // the file to edit to change it.
  if (args.includes('--with-laws')) {
    if (adapter.id !== 'claude-code') {
      console.log('\n--with-laws currently supports claude-code only; capture is installed, the gate is not.');
    } else {
      const settings = readJson(p, {});
      const gate = `node "${path.join(root, 'src/capture/claude-code', 'law-gate.js')}"`;
      mergeClaudeHook(settings, 'Stop', '*', gate);
      fs.writeFileSync(p, JSON.stringify(settings, null, 2));
      console.log('Law gate installed on the Stop hook.\n');
      printLawsForReview({ root: process.cwd() });
    }
  } else {
    console.log('\nThe law layer is available and NOT installed. It checks your claims against the');
    console.log('evidence in each turn and speaks up at run time. See what it would enforce with:');
    console.log('  orunmila laws');
    console.log('Install it with:  orunmila install --agent claude-code --with-laws');
  }

  console.log(`\nRestart ${adapter.label} (or start a new session) for these to take effect.`);
}

/**
 * Read the law set out loud at install time. Deliberately verbose about the two
 * things a person needs to consent to: which laws can STOP their agent, and
 * where to go to change any of it.
 */
function printLawsForReview({ root }) {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const { loadLaws, activeLaws, lawPaths } = require('../src/laws/load');
  const { laws, errors } = loadLaws({ root });
  const active = activeLaws(laws);
  const blocking = active.filter((l) => l.severity === 'block');

  console.log('\x1b[1mThese are the laws you are about to be held to.\x1b[0m');
  console.log(dim('Read them now — a rule that can interrupt your work should not be a surprise later.\n'));

  if (blocking.length) {
    console.log(`\x1b[31m${blocking.length} law(s) CAN STOP A TURN:\x1b[0m`);
    for (const l of blocking) {
      console.log(`  • ${l.id} — ${l.title}`);
      if (l.remedy) console.log(dim(`      → ${l.remedy}`));
    }
  } else {
    console.log('No law is set to stop a turn. Every finding will be advice the agent can act on.');
  }

  const advisory = active.filter((l) => l.severity === 'warn');
  if (advisory.length) {
    console.log(`\n${advisory.length} law(s) advise only (surfaced at run time, never blocking):`);
    for (const l of advisory) console.log(dim(`  • ${l.id} — ${l.title}`));
  }

  if (errors.length) {
    console.log(`\n\x1b[31m${errors.length} law(s) failed to load and are NOT in force:\x1b[0m`);
    for (const e of errors) console.log(`  - ${e}`);
  }

  const p = lawPaths({ root });
  console.log('\nMake them yours:');
  console.log(`  your laws     ${p.user}`);
  console.log(`  this project  ${p.project}`);
  console.log(dim('  Retune any law without restating it:  { "id": "no-grep-as-basis", "severity": "block" }'));
  console.log(dim('  Switch one off:                       { "id": "no-grep-as-basis", "enabled": false }'));
  console.log(dim('  Turn the whole gate off for a session: ORUNMILA_LAWS=off'));
  console.log(dim('  Scaffold your own file:                orunmila laws --init'));
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

// All inspection commands honor --archive <stamp>: when set, they read from the
// snapshot under <dataDir>/archive/<stamp>/ instead of the live reports. The
// archive holds the original pre-rescore scores; live always shows current.
function loadReportsForRead(sessionId) {
  const stamp = flag('archive', null);
  if (stamp) {
    const reports = listArchivedSessionReports(stamp, sessionId);
    return { reports, fromArchive: stamp };
  }
  return { reports: listSessionReports(sessionId), fromArchive: null };
}

function cmdReport() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const turn = flag('turn', null);
  const stamp = flag('archive', null);
  if (turn) {
    const report = stamp ? loadArchivedReport(stamp, sessionId, turn) : loadReport(sessionId, turn);
    if (!report) return console.log(`No report for ${sessionId}/${turn}${stamp ? ` in archive ${stamp}` : ''}.`);
    if (stamp) console.log(`(archived snapshot: ${stamp})`);
    console.log(renderTurn(report));
    return;
  }
  const { reports, fromArchive } = loadReportsForRead(sessionId);
  if (!reports.length) return console.log(`No turns reconciled yet for session ${sessionId}${fromArchive ? ` in archive ${fromArchive}` : ''}.`);
  if (fromArchive) console.log(`(archived snapshot: ${fromArchive})\n`);
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
  const rawTrail = trailForSession(sessionId);
  const { reports: rawReports, fromArchive } = loadReportsForRead(sessionId);
  const { reports, trail } = applyRedaction(rawReports, rawTrail);
  const html = renderSessionHtml(sessionId, reports, trail);
  const suffix = fromArchive ? `-archive-${fromArchive}` : '';
  const outPath = flag('out', path.join(process.cwd(), `orunmila-${sessionId}${suffix}.html`));
  fs.writeFileSync(outPath, html);
  if (fromArchive) console.log(`(archived snapshot: ${fromArchive})`);
  console.log(`Wrote ${outPath}`);
}

function cmdTrail() {
  // The unified report: orunmila's skeptical stain PLUS the glove's complete
  // trail + lineage, both built from the one events.jsonl — one global truth.
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const rawTrail = trailForSession(sessionId);
  const { reports: rawReports, fromArchive } = loadReportsForRead(sessionId);

  // --json: emit the trail model (the glove) as machine-readable JSON instead of
  // the HTML page. --facts-only drops the inferred lineage layer, leaving pure
  // recordings. Redaction (home-collapse + .orunmila/redact) is applied first,
  // exactly like the HTML path; its notice goes to stderr so stdout stays valid
  // JSON when piped.
  if (args.includes('--json')) {
    const factsOnly = args.includes('--facts-only');
    const home = !args.includes('--no-redact-home');
    const { trail, redactList } = redactForRender([], rawTrail, { home, root: process.cwd() });
    if (redactList.length) {
      process.stderr.write(`Redacting ${redactList.length} path pattern(s) from the trail (.orunmila/redact): ${redactList.join(', ')}\n`);
    }
    if (home) process.stderr.write('Home-directory prefix collapsed to ~ in the trail (disable with --no-redact-home).\n');
    const json = renderTrailJson(trail, { factsOnly });
    const out = flag('out', null);
    if (out) {
      fs.writeFileSync(out, json);
      console.log(`Wrote ${out}`);
    } else {
      process.stdout.write(json + '\n');
    }
    return;
  }

  const { reports, trail } = applyRedaction(rawReports, rawTrail);
  const html = renderSessionHtml(sessionId, reports, trail);
  const suffix = fromArchive ? `-archive-${fromArchive}` : '';
  const outPath = flag('out', path.join(process.cwd(), `orunmila-trail-${sessionId}${suffix}.html`));
  fs.writeFileSync(outPath, html);
  const t = rawTrail.totals;
  if (fromArchive) console.log(`(archived snapshot: ${fromArchive})`);
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

function cmdStats() {
  const stats = computeStats();
  console.log(formatStats(stats));
}

function cmdRescore() {
  const dryRun = args.includes('--dry-run');
  if (dryRun) console.log('Rescore (dry run — no files written):\n');
  else console.log('Re-reconciling every persisted report with the current engine.\n');
  const result = rescoreAll({ dryRun, logger: (line) => console.log(line) });
  console.log();
  if (!result.turns) {
    console.log('No persisted reports to rescore.');
    return;
  }
  console.log(`Sessions: ${result.sessions}    Turns: ${result.turns}`);
  if (result.archive) console.log(`Originals archived to: ~/.orunmila/archive/${result.archive}/`);
  console.log('\nAggregate totals (before → after):');
  for (const k of RESCORE_KEYS) {
    const b = result.before[k];
    const a = result.after[k];
    const d = a - b;
    const dStr = d > 0 ? `+${d}` : `${d}`;
    console.log(`  ${k.padEnd(24)} ${String(b).padStart(6)} → ${String(a).padStart(6)}  (${dStr})`);
  }
  if (result.archive) {
    console.log(`\nInspect originals any time with:`);
    console.log(`  orunmila report --archive ${result.archive} [--session ID]`);
    console.log(`  orunmila html   --archive ${result.archive} [--session ID]`);
    console.log(`  orunmila trail  --archive ${result.archive} [--session ID]`);
  }
}

function cmdArchives() {
  const archives = listArchives();
  if (!archives.length) {
    console.log('No archives yet. Run `orunmila rescore` to create one.');
    return;
  }
  console.log(`Archived rescore snapshots (~/.orunmila/archive/):\n`);
  for (const a of archives) {
    const m = a.manifest || {};
    console.log(`  ${a.stamp}    turns: ${m.turns ?? '?'}    sessions: ${m.sessions ?? '?'}    engine: ${m.engine_before ?? '?'} → ${m.engine_after ?? '?'}`);
  }
  console.log(`\nUse with any inspection command:  orunmila report|html|trail --archive <stamp>`);
}

/**
 * orunmila laws [--check] [--session ID] [--json]
 *
 * Without --check: print the law set actually in force and where each law came
 * from. This is the surface the installer will reuse — a user should never have
 * to guess which rules are watching them, or which file to edit to change one.
 *
 * With --check: run those laws over a captured session, read-only. No hook, no
 * blocking, no writes. It is how a law set is measured against real work BEFORE
 * anyone decides it is trustworthy enough to interrupt an agent.
 */
function cmdLaws() {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const { loadLaws, activeLaws } = require('../src/laws/load');
  const root = path.resolve(flag('root', process.cwd()));
  const { laws, errors, layers } = loadLaws({ root });

  if (errors.length) {
    console.log(`\x1b[31m${errors.length} problem(s) loading your laws — these rules are NOT in force:\x1b[0m`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log('');
  }

  // --init: scaffold the caller's own layer-5 file. Written as a WORKING
  // example rather than an empty stub, because the first thing anyone wants is
  // to retune a canon law, and the patch-by-id form is the non-obvious part.
  if (args.includes('--init')) {
    const { lawPaths } = require('../src/laws/load');
    const target = args.includes('--project') ? lawPaths({ root }).project : lawPaths({ root }).user;
    if (fs.existsSync(target)) {
      console.log(`${target} already exists — not overwriting it.`);
      console.log('Edit it directly, or see what is currently in force with: orunmila laws');
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          $comment:
            'Your own laws (layer 5). These sit on top of orunmila\'s canon (layer 4). An entry with a "detect" block defines a new law; an entry with only an "id" patches the canon law of that id. See: orunmila laws',
          laws: [
            {
              $comment: 'Patch a canon law without restating it — severity and enabled are the useful fields.',
              id: 'no-grep-as-basis',
              severity: 'warn',
            },
            {
              $comment: 'A law of your own. Lexical laws are regexes over your agent\'s claim text, its commands, or your prompt.',
              id: 'example-house-rule',
              title: 'Say what this project actually does',
              severity: 'warn',
              enabled: false,
              detect: { kind: 'lexical', scope: 'claim', patterns: ['\\bvercel\\b'], unless: [] },
              message: 'This project does not deploy to Vercel.',
              remedy: 'Check where it actually deploys before saying so.',
            },
          ],
        },
        null,
        2
      ) + '\n'
    );
    console.log(`Wrote ${target}`);
    console.log('It ships with one patch and one disabled example — edit both, then run: orunmila laws');
    return;
  }

  if (!args.includes('--check')) {
    const active = activeLaws(laws);
    console.log(`Laws in force: ${active.length} of ${laws.length} defined.\n`);
    console.log('Layers (later files override earlier ones by law id):');
    for (const l of layers) {
      const label = l.key === 'canon' ? 'canon   ' : l.key === 'user' ? 'yours   ' : 'project ';
      const state = l.present ? `${String(l.contributed).padStart(2)} law(s)` : '  absent';
      console.log(`  layer ${l.layer}  ${label}  ${state}   ${l.file}`);
    }
    console.log('\nWrite your own laws in either layer-5 file above. To retune one of the');
    console.log('canon laws without restating it, add an entry with just its id:');
    console.log('  { "id": "no-uncertainty-as-fact", "severity": "block" }\n');

    for (const law of laws) {
      const sev = law.severity === 'block' ? '\x1b[31mblock\x1b[0m' : '\x1b[33mwarn \x1b[0m';
      const off = law.enabled ? '' : dim('  (disabled)');
      console.log(`  [${sev}] ${law.id.padEnd(34)} ${law.title}${off}`);
      const how = law.kind === 'evidentiary' ? `evidentiary: ${law.rule}` : `lexical: ${law.rawPatterns.length} pattern(s) over ${law.scope}`;
      console.log(dim(`            ${how}   ·   layer ${law.layer}`));
      if (law.patchedBy) console.log(dim(`            overridden by ${law.patchedBy.join(', ')}`));
      if (law.remedy) console.log(dim(`            → ${law.remedy}`));
    }
    return;
  }

  // --check: replay the laws over a real session.
  const { evaluateTurn } = require('../src/laws/evaluate');
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) return console.log('No sessions captured yet.');
  const events = eventlog.readSession(sessionId);
  const byTurn = eventlog.groupByTurn(events.filter((e) => e.turn_id));
  const active = activeLaws(laws);

  const out = { session_id: sessionId, laws_in_force: active.length, turns: [] };
  let claimed = 0;
  let flagged = 0;
  let blocked = 0;

  for (const [turnId, turnEvents] of byTurn) {
    const claim = turnEvents.find((e) => e.type === eventlog.TYPES.TURN_CLAIM);
    const prompt = turnEvents.find((e) => e.type === eventlog.TYPES.USER_PROMPT);
    if (!claim || !claim.text || !String(claim.text).trim()) continue;
    claimed++;
    const res = evaluateTurn({
      claimText: String(claim.text),
      promptText: prompt && prompt.text ? String(prompt.text) : '',
      turnEvents,
      laws: active,
    });
    if (!res.findings.length) continue;
    flagged++;
    if (res.blocking.length) blocked++;
    out.turns.push({ turn_id: turnId, receipts: res.receipts, findings: res.findings });
  }

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  console.log(`Session ${sessionId} — ${active.length} law(s) over ${claimed} claimed turn(s).\n`);
  for (const t of out.turns) {
    console.log(`\x1b[1m${t.turn_id}\x1b[0m ${dim(`(receipts: ${t.receipts.full} full, ${t.receipts.weak} weak, ${t.receipts.passing_commands} passing cmd, ${t.receipts.unreliable_commands} laundered)`)}`);
    for (const f of t.findings) {
      const sev = f.severity === 'block' ? '\x1b[31mblock\x1b[0m' : '\x1b[33mwarn \x1b[0m';
      console.log(`  [${sev}] ${f.law_id}`);
      if (f.evidence.text) console.log(dim(`          "${String(f.evidence.text).replace(/\s+/g, ' ').slice(0, 150)}"`));
      if (f.remedy) console.log(dim(`          → ${f.remedy}`));
    }
    console.log('');
  }
  console.log(`${flagged} turn(s) raised a finding; ${blocked} would block.`);
  console.log(dim('Findings are heuristic — they read prose, not facts. They sit beside the glove, never inside it.'));
}

function cmdAgents() {
  console.log('Supported agents (use with: orunmila install --agent <id>):\n');
  for (const a of listAgents()) {
    const adapter = getAdapter(a.id);
    console.log(`  ${a.id.padEnd(12)} ${a.label}  (config: ${adapter.config.dir}/${adapter.config.file})`);
  }
}

// Parse --include (and the --include-text shorthand). Comma-separated.
function parseIncludes() {
  const out = new Set();
  if (args.includes('--include-text')) out.add('claim_text');
  const i = args.indexOf('--include');
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) {
    for (const f of String(args[i + 1]).split(',').map((s) => s.trim()).filter(Boolean)) {
      out.add(f);
    }
  }
  return Array.from(out);
}

// Look up the agent id captured by the install hooks — best-effort. The
// event log carries `agent_id` when available; fall back to the most
// recently installed adapter on disk, then to null.
function detectAgent() {
  try {
    const all = eventlog.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] && all[i].agent_id) return String(all[i].agent_id);
    }
  } catch { /* ok */ }
  return null;
}

function cmdJson() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) {
    console.error('No sessions captured yet.');
    process.exit(1);
  }
  const turn = flag('turn', null);
  const include = parseIncludes();
  const home = !args.includes('--no-redact-home');
  const { reports } = loadReportsForRead(sessionId);
  const events = eventlog.readSession(sessionId);
  const json = renderJson({
    sessionId,
    agent: detectAgent(),
    reports,
    events,
    turn,
    include,
    redactOpts: { home, root: process.cwd() },
  });
  const out = flag('out', null);
  if (out) {
    fs.writeFileSync(out, json);
    console.log(`Wrote ${out}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

function cmdFeedback() {
  const sessionId = flag('session', eventlog.latestSessionId());
  if (!sessionId) {
    console.error('No sessions captured yet.');
    process.exit(1);
  }
  const include = parseIncludes();
  const home = !args.includes('--no-redact-home');
  const dir = flag('dir', path.join(process.cwd(), '.orunmila-feedback'));
  const { reports } = loadReportsForRead(sessionId);
  const events = eventlog.readSession(sessionId);
  const { file, payload } = feedback.writeFeedback({
    sessionId,
    agent: detectAgent(),
    reports,
    events,
    dir,
    include,
    redactOpts: { home, root: process.cwd() },
  });
  console.log(`Wrote ${file}`);
  console.log(`Cases: ${payload.cases.length} (claim_text included: ${payload.included_fields.includes('claim_text') ? 'yes' : 'no'})`);
  if (!payload.included_fields.includes('claim_text')) {
    console.log(`Re-run with --include claim_text to make these cases corpus-runnable.`);
  }
  console.log(`Drop folder INDEX: ${path.join(path.dirname(file), '..', 'INDEX.md')}`);
}

function cmdFeedbackImport() {
  const dir = flag('dir', path.join(process.cwd(), '.orunmila-feedback'));
  const corpusDir = flag('corpus', path.join(process.cwd(), 'test', 'cases', 'precision'));
  const force = args.includes('--force');
  const stats = feedback.importFeedback({
    dir, corpusDir, force,
    logger: (line) => console.log(line),
  });
  console.log(`\nRead: ${stats.read}    Written: ${stats.written}    Skipped: ${stats.skipped}`);
  if (stats.skipped) {
    console.log('Skips:');
    for (const r of stats.skippedReasons) console.log(`  - ${r}`);
  }
}

const COMMANDS = {
  install: cmdInstall,
  agents: cmdAgents,
  laws: cmdLaws,
  stats: cmdStats,
  status: cmdStatus,
  prune: cmdPrune,
  report: cmdReport,
  html: cmdHtml,
  trail: cmdTrail,
  glove: cmdTrail, // alias: "the glove" is the user-facing name for the trail lens
  rescore: cmdRescore,
  archives: cmdArchives,
  json: cmdJson,
  feedback: cmdFeedback,
  'feedback-import': cmdFeedbackImport,
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
  orunmila laws [--root dir]         show the laws in force and which layer each came from (layer 4 = the canon, layer 5 = yours)
  orunmila laws --check [--session ID] [--json]   replay those laws over a captured session, read-only — measure a law set before trusting it
  orunmila stats                     cross-agent reliability scores, phantom rates, and comparisons
  orunmila status                    show event log location, size, and counts
  orunmila prune [--keep N]          cap the log to the N most-recent sessions (default 20; explicit, never automatic)
  orunmila report [--session ID] [--turn ID] [--archive STAMP]   print a terminal stain report (live, or a pinned archived snapshot)
  orunmila html [--session ID] [--out path] [--archive STAMP] [--no-redact-home]   generate the mismatch-only HTML report
  orunmila trail [--session ID] [--out path] [--archive STAMP] [--no-redact-home]  unified report: complete trail (the glove) + lineage + orunmila stains
  orunmila trail --json [--facts-only] [--session ID] [--out path] [--no-redact-home]   machine-readable trail (the glove); --facts-only drops the inferred lineage layer (edges/touched_by), leaving pure recordings
  orunmila rescore [--dry-run]       re-reconcile every persisted report with the current engine (originals archived, never deleted)
  orunmila archives                  list archived rescore snapshots you can read back with --archive <stamp>
  orunmila json [--session ID] [--turn ID] [--out path] [--include claim_text] [--no-redact-home]   machine-readable per-turn stain output (schema_version 1.0)
  orunmila feedback [--session ID] [--dir path] [--include claim_text] [--no-redact-home]   write sanitized accuracy cases to a local drop folder (precision-corpus superset)
  orunmila feedback-import [--dir path] [--corpus path] [--force]   copy cases[] entries from a feedback drop folder into test/cases/precision/
  orunmila demo [--out path]         render a sample unified report from a scripted session (no setup, for a first look)
  orunmila watch [--root dir]        live-tail new turn reports + run the filesystem sentinel
  orunmila watch-fs [--root dir]     run ONLY the filesystem sentinel (independent disk observer)
  orunmila debug-transcript <path>   inspect why transcript parsing isn't matching your install
`);
  process.exit(cmd ? 1 : 0);
}

COMMANDS[cmd]();
