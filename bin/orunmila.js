#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const eventlog = require('../src/store/eventlog');
const legacy = require('../src/store/legacy');
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

/**
 * PM3 (LD291): the script a hook command runs, when it is one of Orunmila's (by its basename), read from the command's
 * words with their quotes taken off; and every command hook in a settings object whose script is not there (a package
 * runner's cache cleared, a copy moved), as [{ event, script }]. Such a hook runs nothing, so it records nothing.
 */
const ORUNMILA_SCRIPTS = ['orunmila-start.js', 'user-prompt-submit.js', 'pre-tool-use.js', 'post-tool-use.js', 'stop.js', 'law-gate.js', 'intake-send.js', 'connector.js'];
/** The command's words, quotes taken off, and the index of the first that names one of Orunmila's scripts (or -1). */
function scriptOf(command) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command)))) words.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return { words, at: words.findIndex((w) => ORUNMILA_SCRIPTS.includes(path.basename(w))) };
}
function missingHookScripts(settings) {
  const { starterTarget, STARTER } = require('../src/runtime/install');
  const out = [];
  for (const [event, entries] of Object.entries((settings && settings.hooks) || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of (entry && entry.hooks) || []) {
        if (!h || h.type !== 'command') continue;
        const { words, at } = scriptOf(h.command);
        const s = at >= 0 ? words[at] : null;
        if (!s || !path.isAbsolute(s)) continue;
        if (!fs.existsSync(s)) out.push({ event, script: s });
        else if (path.basename(s) === STARTER) {
          // PM2b (LD331): the starter is there; the script it runs is the current version's.
          const t = starterTarget(s, words[at + 1]);
          if (!t.ok) out.push({ event, script: t.file });
        }
      }
    }
  }
  return out;
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

// The Closeout Gate's single hook script. Detected separately from capture so
// the CLI can report the two lenses independently — someone can hold either one
// without the other, and "is the gate on?" must be answerable without guessing.
const GATE_HOOK_BASENAME = 'law-gate.js';

// The events the intake's router reads (slice B1d), each sent by intake-send.js (LD133).
const INTAKE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];
// H2 (LD140): which of them go over Claude Code's HTTP hooks, and which keep the command sender.
const INTAKE_HTTP_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const INTAKE_COMMAND_EVENTS = ['SessionStart', 'PostToolUseFailure', 'SessionEnd'];

// Find the registered Closeout Gate hook, if any. Same basename strategy as
// findExistingClaudeHooks: a gate pointing at a different copy of orunmila is
// still a gate.
function findExistingGateHooks(settings) {
  const found = [];
  const hooks = (settings && settings.hooks) || {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    for (const entry of entries || []) {
      for (const h of (entry && entry.hooks) || []) {
        const c = h && h.command ? String(h.command) : '';
        if (c.includes(GATE_HOOK_BASENAME)) found.push({ event: eventName, command: c });
      }
    }
  }
  return found;
}

// THE TWO LENSES. Orunmila is one tool with two jobs, and which job a team
// wants is genuinely not predictable — some want the record, some want the
// refusal, and the ones who want both want to turn them on separately. So the
// split is structural here, not a line in the README: each lens has its own
// install path, its own uninstall, and its own row in `orunmila lenses`.
const LENSES = {
  'stain-map': {
    name: 'The Stain Map',
    verb: 'observes',
    one_line: 'Records everything the agent touched, then checks its story against the evidence.',
    refuses: false,
    agents: 'all supported agents',
    install: 'orunmila install',
  },
  'closeout-gate': {
    name: 'The Closeout Gate',
    verb: 'refuses',
    one_line: "Stops a turn ending on a claim the turn's own evidence does not support.",
    refuses: true,
    agents: 'claude-code only',
    install: 'orunmila install --with-gate',
  },
  // BJ1 (LD326): the judge, an install option, off by default (O: "not everyone will appreciate the feature").
  babalawo: {
    name: 'The Babaláwo',
    verb: 'judges',
    one_line: "Judges each session's sealed record at its closeout: Clean, Look at this or Violation, with the reason.",
    refuses: false,
    agents: 'claude-code (through the intake)',
    install: 'orunmila install --with-judge',
  },
};

/**
 * Which lenses are actually registered, and where. Reads the agent's own config
 * file rather than inferring from anything orunmila wrote down, because the
 * user may have edited it by hand — and a lens report that trusts its own notes
 * instead of the config is exactly the kind of claim this project exists to
 * distrust.
 */
function lensState({ agentId = 'claude-code', global = false } = {}) {
  const adapter = getAdapter(agentId);
  if (!adapter) return null;
  const p = configPath(adapter, { global, home: os.homedir(), cwd: process.cwd() });
  const settings = readJson(p, null);
  if (settings === null) {
    return { configPath: p, exists: false, stainMap: [], gate: [], adapter };
  }
  // Non-claude agents register capture through connector.js; detect either shape.
  const captureHooks = adapter.id === 'claude-code'
    ? findExistingClaudeHooks(settings)
    : (JSON.stringify(settings).includes('connector.js') ? [{ event: '(connector)', command: 'connector.js' }] : []);
  return {
    configPath: p,
    exists: true,
    stainMap: captureHooks,
    gate: adapter.id === 'claude-code' ? findExistingGateHooks(settings) : [],
    adapter,
  };
}

// Claude Code keeps its four purpose-named scripts (its hook system wants one
// command per event and they're the test entry points). Every other agent maps
// each of its own event names to `connector.js <agent> <phase>`.
//
// Returns { installed: boolean }. Refuses (installed:false) rather than adding a
// second registration when an orunmila hook already exists in this settings file
// — silently skipping would hide the dual-install; we print where it was found.
/**
 * PM2b (LD331): Orunmila's home, and the hook command for one of its scripts: through the starter in the home, which
 * runs the version `install` copied there (src/runtime/install.js), never a path inside the copy that ran `install`.
 */
const orunmilaHome = () => process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
const hookFor = (rel) => require('../src/runtime/install').hookCommand(orunmilaHome(), rel);

function installClaudeCode(root, p, { tolerateExisting = false } = {}) {
  const settings = readJson(p, {});
  const existing = findExistingClaudeHooks(settings);
  if (existing.length) {
    // Two live capture registrations double every event and double-bump the
    // turn counter, so a duplicate is always refused. But WHY the caller is
    // here decides how alarming that should sound: someone running
    // `install --with-gate` over an existing Stain Map is about to get exactly
    // what they asked for, and telling them to "remove the existing
    // registration first" is wrong advice for a run that is going to succeed.
    // So the refusal only speaks when the caller has nothing else to offer.
    if (!tolerateExisting) {
      console.error(`Refusing to install: an existing orunmila capture hook is already registered in ${p}.`);
      console.error('Two live registrations double every captured event and double-bump the turn counter (the dual-install corruption).');
      console.error('Found:');
      for (const e of existing) console.error(`  [${e.event}] ${e.command}`);
      console.error('Remove the existing registration first (or point it at this copy) before installing again.');
    }
    return { installed: false, existing };
  }
  // The starter's path is quoted (hookCommand): it can contain spaces (e.g.
  // C:\Users\Jane Doe\...) and, on Windows, backslash separators. Both are safe
  // inside double quotes for the shell that runs the hook command on every platform.
  const s = (name) => hookFor(`src/capture/claude-code/${name}`);
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
  for (const [phase, eventName] of Object.entries(adapter.events)) {
    const matcher = phase === 'preTool' ? (adapter.preToolMatcher || '*') : '*';
    settings.orunmila[eventName] = [
      { matcher, hooks: [{ type: 'command', command: `${hookFor('src/capture/connector.js')} ${adapter.id} ${phase}` }] },
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
  for (const [phase, eventNames] of Object.entries(adapter.events)) {
    for (const eventName of [].concat(eventNames)) {
      settings.hooks[eventName] = `${hookFor('src/capture/connector.js')} ${adapter.id} ${phase}`;
    }
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

/**
 * BJ1 (LD326; LD300 (4)): `install --with-judge | --without-judge` sets the Babaláwo's switch in Orunmila's home and
 * touches no hook. The intake reads it at its next start; the judge only reads sealed records and never stops the agent.
 */
function installJudge(on) {
  const { setJudge } = require('../src/opon/intake/switches');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const file = setJudge(home, on);
  if (on) {
    console.log(`${LENSES.babalawo.name} is on (${file}).`);
    console.log('At each session\'s closeout the intake judges the sealed record: every event Clean, Look at this or Violation,');
    console.log('and the session as a whole, into verdict.jsonl beside the other two logs. It only reads the record; it never stops the agent.');
    console.log('Read a session\'s verdicts with: orunmila report --verdicts --session ID');
  } else {
    console.log(`${LENSES.babalawo.name} is off (${file}). No verdict log is written; the record is kept as before.`);
    console.log('Any session can still be judged by hand: orunmila judge --session ID');
  }
  console.log('It takes effect at the intake\'s next start (orunmila intake stop, then orunmila intake start; a launch agent starts it again by itself).');
  if (process.env.ORUNMILA_JUDGE_LIVE === '1' || process.env.ORUNMILA_JUDGE_LIVE === '0') {
    console.log(`Note: ORUNMILA_JUDGE_LIVE=${process.env.ORUNMILA_JUDGE_LIVE} is set in this shell, and an intake started from it follows that instead.`);
  }
}

/** PM2c2 (LD333): `install --with-updates | --without-updates`, the daily update check's switch in Orunmila's home. */
function installUpdates(on) {
  const { setUpdates } = require('../src/opon/intake/switches');
  const file = setUpdates(orunmilaHome(), on);
  if (on) {
    console.log(`Daily updates are on (${file}).`);
    console.log("Once a day the intake, or a hook where no intake runs, asks the npm registry for the latest orunmila, sending only the package's name,");
    console.log('and switches to it once it is checked and no session is being recorded. Each switch is in ~/.orunmila/updates.jsonl.');
  } else console.log(`Daily updates are off (${file}). Update by hand with: orunmila update`);
  if (process.env.ORUNMILA_UPDATES === '1' || process.env.ORUNMILA_UPDATES === '0') console.log(`Note: ORUNMILA_UPDATES=${process.env.ORUNMILA_UPDATES} is set in this shell, and wins over the switch where it is set.`);
}

function cmdInstall() {
  if (args.includes('--with-judge') || args.includes('--without-judge')) return installJudge(args.includes('--with-judge'));
  if (args.includes('--with-updates') || args.includes('--without-updates')) return installUpdates(args.includes('--with-updates'));
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

  // F19 (LD336): Orunmila's capture hooks already here. Each runs this home's starter: installing again is an upgrade
  // (the copy and `current` below, no hook added). Any names another copy: a plain install refuses, before it touches
  // Orunmila's home, so a refusal changes nothing.
  const capturing = !args.includes('--intake') && !args.includes('--gate-only') && !args.includes('--with-gate') && !args.includes('--with-laws');
  const thisStarter = path.join(orunmilaHome(), 'bin', require('../src/runtime/install').STARTER);
  const existing = adapter.id === 'claude-code' ? findExistingClaudeHooks(readJson(p, {})) : [];
  const upgrade = existing.length > 0 && existing.every((e) => {
    const { words, at } = scriptOf(e.command);
    return at >= 0 && words[at] === thisStarter;
  });
  if (capturing && existing.length && !upgrade) {
    installClaudeCode(root, p); // prints the refusal and where the other hooks are; writes nothing
    process.exitCode = 1;
    return;
  }

  // PM2b (LD331): this copy kept in Orunmila's home, so every hook below runs it through the starter, whatever
  // happens to the copy that ran `install` (npx's or pnpm's cache cleared, a global folder moved).
  const rt = require('../src/runtime/install').installRuntime({ home: orunmilaHome(), from: root });
  console.log(`Orunmila ${rt.version} is kept in ${rt.dir}${rt.fresh ? '' : ' (already there)'}; every hook runs it through ${rt.starter},`);
  console.log('so the hooks keep working if the copy that ran this install is removed.\n');
  if (capturing && upgrade) {
    console.log(`Orunmila is already installed in ${p}: its hooks run that starter, which now runs ${rt.version}. No hook was added.`);
    return;
  }

  // The Closeout Gate is a SEPARATE registration from the Stain Map, so it must
  // be installable on its own. Someone who set capture up months ago and now
  // wants the gate would otherwise be turned away by the duplicate-install
  // guard before ever reaching it — the feature would be unreachable for every
  // existing user, which is most of them.
  //
  // --with-laws is the original spelling of --with-gate. It keeps working
  // forever: it is in install instructions people have already followed.
  // --intake (slice B2, LD133): the sender to the intake, for every event the
  // intake's router reads and every tool, beside today's capture hooks, never in
  // their place. Installing it is the switch (LD122); it does not start the intake.
  if (args.includes('--intake')) {
    if (adapter.id !== 'claude-code') {
      console.error(`--intake is claude-code only for now; ${adapter.label} keeps its current capture.`);
      process.exitCode = 1;
      return;
    }
    const settings = readJson(p, {});
    const sender = hookFor('src/capture/claude-code/intake-send.js');
    const url = `http://127.0.0.1:${require('../src/opon/intake/server').intakePort()}/hook`;
    // One channel per event (H2, LD140): Claude Code's own HTTP hooks where they are
    // known to fire, so each session is pinned to the claude process; the command
    // sender for SessionStart (command-only) and the two not yet measured over HTTP.
    // Any earlier intake hook, sender or HTTP, is replaced, never doubled.
    const ours = (h) => h && ((h.type === 'command' && String(h.command || '').includes('intake-send.js')) || (h.type === 'http' && /^http:\/\/127\.0\.0\.1:[0-9]+\/hook$/.test(String(h.url || ''))));
    settings.hooks = settings.hooks || {};
    for (const ev of INTAKE_EVENTS) {
      const kept = (settings.hooks[ev] || []).map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !ours(h)) })).filter((e) => e.hooks.length);
      if (kept.length) settings.hooks[ev] = kept;
      else delete settings.hooks[ev];
    }
    for (const ev of INTAKE_COMMAND_EVENTS) mergeClaudeHook(settings, ev, '*', sender);
    for (const ev of INTAKE_HTTP_EVENTS) (settings.hooks[ev] = settings.hooks[ev] || []).push({ matcher: '*', hooks: [{ type: 'http', url, timeout: 2 }] });
    // BB5b (LD276; brief v4 line 678): an installed Closeout Gate sends its checks to the intake too, by an argument,
    // never an environment prefix (not every shell a hook runs in reads one). The gate is never installed from here.
    let gates = 0;
    for (const e of settings.hooks.Stop || []) {
      for (const h of e.hooks || []) {
        if (h.type !== 'command' || !String(h.command || '').includes(GATE_HOOK_BASENAME)) continue;
        gates++;
        if (!/\s--marks$/.test(h.command)) h.command = `${h.command} --marks`;
      }
    }
    fs.writeFileSync(p, JSON.stringify(settings, null, 2));
    console.log(`The intake is registered in ${p}, beside any hooks already there:`);
    console.log(`  HTTP hooks to ${url} for ${INTAKE_HTTP_EVENTS.join(', ')} (every tool; each session pinned to the claude process)`);
    console.log(`  the command sender for ${INTAKE_COMMAND_EVENTS.join(', ')}`);
    if (gates) console.log("  the Closeout Gate's checks go to the intake too (--marks), so each session's record shows the law gate");
    else console.log('The Closeout Gate is not installed here: with no law-gate checks, every session\'s record will be Incomplete (law gate silent). Add it with: orunmila install --gate-only');
    console.log("Nothing is recorded while no intake runs: start it with");
    console.log('  orunmila intake start');
    console.log(`\nRestart ${adapter.label} (or start a new session) for this to take effect.`);
    return;
  }

  const wantsGate = args.includes('--with-gate') || args.includes('--with-laws');
  const gateOnly = args.includes('--gate-only');
  let captureInstalled = true;

  // --gate-only: register the gate and leave capture alone. The gate JUDGES the
  // events capture records (gate.js reads them back through readTurn), so it is
  // not a standalone product — without the Stain Map underneath it there is
  // nothing to judge and it will pass every turn in silence. Say so out loud
  // rather than installing something inert.
  if (gateOnly) {
    if (adapter.id !== 'claude-code') {
      console.error(`--gate-only is claude-code only; ${adapter.label} can run the Stain Map but not the Closeout Gate.`);
      process.exitCode = 1;
      return;
    }
    const state = lensState({ agentId: adapter.id, global });
    if (!state.stainMap.length) {
      console.log('Note: the Stain Map is NOT installed in this config.');
      console.log('The Closeout Gate judges the events the Stain Map records, so on its own it has');
      console.log('nothing to read and will pass every turn silently. Install both with:');
      console.log('  orunmila install --with-gate\n');
    }
    const settings = readJson(p, {});
    const gate = hookFor('src/capture/claude-code/law-gate.js');
    mergeClaudeHook(settings, 'Stop', '*', gate);
    fs.writeFileSync(p, JSON.stringify(settings, null, 2));
    console.log(`${LENSES['closeout-gate'].name} installed on the Stop hook in ${p}.\n`);
    printLawsForReview({ root: process.cwd() });
    console.log(`\nRestart ${adapter.label} (or start a new session) for this to take effect.`);
    return;
  }

  if (adapter.id === 'claude-code') {
    const res = installClaudeCode(root, p, { tolerateExisting: wantsGate });
    if (res && res.installed === false) {
      captureInstalled = false;
      if (!wantsGate) {
        process.exitCode = 1;
        return;
      }
      console.log(`${LENSES['stain-map'].name} is already installed here — leaving it exactly as it is.`);
      console.log('Adding the second lens only.\n');
    }
  } else if (adapter.id === 'antigravity') {
    installAntigravity(adapter, root, p);
  } else {
    installGeneric(adapter, root, p);
  }

  if (captureInstalled) console.log(`${LENSES['stain-map'].name} installed for ${adapter.label} into ${p}`);

  // The law layer is opt-in and, when it goes in, it is READ OUT. A rule that
  // can interrupt someone's work must never be something they discover by being
  // interrupted — so installing it prints every law in force, its severity, and
  // the file to edit to change it.
  if (wantsGate) {
    if (adapter.id !== 'claude-code') {
      console.log(`\nThe ${LENSES['closeout-gate'].name} is claude-code only; the Stain Map is installed, the gate is not.`);
    } else {
      const settings = readJson(p, {});
      const gate = hookFor('src/capture/claude-code/law-gate.js');
      mergeClaudeHook(settings, 'Stop', '*', gate);
      fs.writeFileSync(p, JSON.stringify(settings, null, 2));
      console.log(`${LENSES['closeout-gate'].name} installed on the Stop hook.\n`);
      printLawsForReview({ root: process.cwd() });
    }
  } else {
    console.log(`\nThe second lens, ${LENSES['closeout-gate'].name}, is available and NOT installed.`);
    console.log('The Stain Map you just installed only ever reports. The gate can REFUSE a turn whose');
    console.log('claims its own evidence does not support. See exactly what it would enforce first:');
    console.log('  orunmila laws');
    console.log('Then add it with:  orunmila install --agent claude-code --with-gate');
    console.log('Compare the two lenses any time with:  orunmila lenses');
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

/**
 * `orunmila lenses` — which lens is which, what each one can do, and which of
 * them you actually have installed right now.
 *
 * This command exists because the two lenses are easy to conflate and the
 * difference is the whole decision: one records and reports, the other can
 * stop your agent. Nobody should have to read source to find out which is live.
 */
function cmdLenses() {
  const dim = (t) => `\x1b[2m${t}\x1b[0m`;
  const bold = (t) => `\x1b[1m${t}\x1b[0m`;
  const agentId = flag('agent', 'claude-code');
  const global = args.includes('--global');
  const state = lensState({ agentId, global });

  if (!state) {
    console.error(`Unknown agent "${agentId}". Try: orunmila agents`);
    process.exitCode = 1;
    return;
  }

  console.log(bold('orunmila has three lenses. They are installed separately and used for different jobs.\n'));

  // Pad on VISIBLE width: the header cells carry ANSI bold codes, and padEnd
  // counts those bytes, which knocks the header out of line with the rows.
  // eslint-disable-next-line no-control-regex -- stripping ANSI requires matching ESC
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const vis = (t) => String(t).replace(ANSI_RE, '').length;
  const pad = (t, n) => String(t) + ' '.repeat(Math.max(0, n - vis(t)));

  const rows = [
    ['', bold('The Stain Map'), bold('The Closeout Gate'), bold('The Babaláwo')],
    ['what it does', 'records + reports', 'refuses', 'judges the record'],
    ['when', 'after each turn', 'before a turn is allowed to end', "at each session's closeout"],
    ['can it stop the agent?', 'never', 'yes — 2 of its laws block', 'never'],
    ['agents', 'all supported agents', 'claude-code only', 'claude-code (through the intake)'],
    ['install', 'orunmila install', 'orunmila install --with-gate', 'orunmila install --with-judge'],
    ['add to an existing install', '—', 'orunmila install --gate-only', 'orunmila install --with-judge'],
    ['turn off', '—', 'ORUNMILA_LAWS=off (one session)', 'orunmila install --without-judge'],
    ['read it', 'orunmila trail', 'orunmila laws', 'orunmila report --verdicts --session ID'],
  ];
  const w0 = Math.max(...rows.map((r) => vis(r[0])));
  for (const [a, b, c, d] of rows) {
    console.log(`  ${pad(a, w0)}   ${pad(b, 22)} ${pad(c, 33)} ${d}`);
  }

  console.log(dim('\n  The gate judges the events the Stain Map records, so the gate needs the Stain'));
  console.log(dim('  Map underneath it. The Stain Map is useful entirely on its own. The Babaláwo'));
  console.log(dim("  judges the intake's record (install --intake), and is off until you turn it on."));

  console.log(`\n${bold('Installed right now')} ${dim(`(${state.configPath})`)}`);
  if (!state.exists) {
    console.log('  neither — no config file at that path yet.');
  } else {
    const mark = (on) => (on ? '\x1b[32m✓ installed\x1b[0m' : '\x1b[2m· not installed\x1b[0m');
    console.log(`  ${pad('The Stain Map', 20)} ${mark(state.stainMap.length)}`);
    for (const h of state.stainMap) console.log(dim(`      [${h.event}] ${h.command}`));
    if (state.adapter.id === 'claude-code') {
      console.log(`  ${pad('The Closeout Gate', 20)} ${mark(state.gate.length)}`);
      for (const h of state.gate) console.log(dim(`      [${h.event}] ${h.command}`));
    } else {
      console.log(`  ${pad('The Closeout Gate', 20)} ${dim('· unavailable for this agent (claude-code only)')}`);
    }
  }

  const j = judgeState();
  const judgeMark = j.on ? '\x1b[32m✓ installed\x1b[0m' : '\x1b[2m· not installed\x1b[0m';
  console.log(`  ${pad('The Babaláwo', 20)} ${judgeMark} ${dim(`(${j.why})`)}`);
  if (j.problem) console.log(`      \x1b[33m${j.problem}: read as off\x1b[0m`);

  if (state.exists && state.stainMap.length && !state.gate.length && state.adapter.id === 'claude-code') {
    console.log(dim('\n  To add the gate without touching capture:  orunmila install --gate-only'));
  }
}

/** BJ1 (LD326): the judge's switch as `lenses` and `status` show it, from Orunmila's home; the environment noted. */
function judgeState() {
  const { readSwitches, switchesFile } = require('../src/opon/intake/switches');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const s = readSwitches(home);
  const env = process.env.ORUNMILA_JUDGE_LIVE;
  const shell = env === '1' || env === '0' ? `; ORUNMILA_JUDGE_LIVE=${env} in this shell wins for an intake started from it` : '';
  return { on: s.judge, problem: s.problem, why: `switch: ${switchesFile(home)}${shell}` };
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
  if (legacy.isLegacy(eventlog.dataDir())) console.log(`\x1b[33m${legacy.WARNING}\x1b[0m\n`);

  // Which lenses are live, first — before any counts. A log with events in it
  // says capture ran at some point; it does not say the gate is on, and those
  // are the two separate things a person checking status actually wants.
  const ls = lensState({ agentId: flag('agent', 'claude-code'), global: args.includes('--global') });
  if (ls) {
    const mk = (on) => (on ? '\x1b[32mon\x1b[0m' : '\x1b[2moff\x1b[0m');
    const gateCell = ls.adapter.id === 'claude-code'
      ? mk(ls.gate.length)
      : '\x1b[2mn/a (claude-code only)\x1b[0m';
    console.log(`Lenses: Stain Map ${mk(ls.stainMap.length)}  |  Closeout Gate ${gateCell}  |  Babaláwo ${mk(judgeState().on)}`);
    if (String(process.env.ORUNMILA_LAWS || '').toLowerCase() === 'off') {
      console.log('  \x1b[33mORUNMILA_LAWS=off is set in this shell — the gate is disabled regardless of install.\x1b[0m');
    }
    console.log(`  config: ${ls.configPath}`);
    // PM3 (LD291): a hook whose script is gone runs nothing; name each one, and exit 1 so a self-check can rely on it.
    const missing = ls.exists ? missingHookScripts(readJson(ls.configPath, {})) : [];
    if (missing.length) {
      console.log(`  \x1b[31m${missing.length} ${missing.length === 1 ? 'hook names a script that is' : 'hooks name a script that is'} not there\x1b[0m, so ${missing.length === 1 ? 'it records' : 'they record'} nothing:`);
      for (const m of missing) console.log(`    [${m.event}] ${m.script}`);
      console.log('  Install again from a copy that stays (npm i -g orunmila, then orunmila install): a package runner\'s cache can be cleared.');
      process.exitCode = 1;
    }
    console.log('  detail: orunmila lenses\n');
  }

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

/**
 * `orunmila report --verdicts [--session ID] [--html FILE] [--json]` (Phase 6 slice BB8, LD272; brief v4 lines 688-693):
 * the session report from the session's logs in <home>/sessions/<id>/: top line first, each finding one sentence naming
 * both witnesses, the law gate's counts. With no verdict log (the judge was off at its closeout) the odù log is judged
 * for this report only, and the report says so. Exit 0 reported, 1 no session or its logs do not verify, 2 usage.
 */
function cmdReportVerdicts() {
  const { checkLog } = require('../src/verify/session');
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const { verifyText } = require('../src/verify/chain');
  const babalawo = require('../src/babalawo');
  const { buildReport, renderText, renderHtml, renderJson } = require('../src/babalawo/report');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const id = flag('session', null);
  let dir;
  try {
    dir = id ? path.join(home, 'sessions', sessionFolderName(id)) : null;
  } catch {
    dir = null; // an id unsafe as a folder name has no session log
  }
  if (!dir) {
    console.error('Usage: orunmila report --verdicts --session ID [--html FILE] [--json]');
    process.exitCode = 2;
    return;
  }
  const refuse = (words) => {
    console.log(`orunmila report: ${words}`);
    process.exitCode = 1;
  };
  const raw = checkLog(dir, 'raw');
  if (!raw.ok) return refuse(`session ${id} has no raw log here, or it does not verify (orunmila verify ${dir})`);
  const recs = raw.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec);
  const oduFile = path.join(dir, 'odu.jsonl');
  if (!fs.existsSync(oduFile)) return refuse(`session ${id} has no odù log (the intake writes one only with ORUNMILA_OPON_LIVE=1)`);
  const oduText = fs.readFileSync(oduFile, 'utf8');
  if (!verifyText(oduText).ok) return refuse(`the odù log of ${id} does not verify (orunmila verify ${dir})`);
  const { testDiffsFromMarks, oduRecords } = require('../src/opon/ledger/beside');
  const diffs = testDiffsFromMarks({ odus: oduRecords(oduText), marks: recs.slice(1), dir }); // MR2 (LD317): R27, the judge and the report
  const vFile = path.join(dir, 'verdict.jsonl');
  let vText;
  const judgedNow = !fs.existsSync(vFile);
  if (judgedNow) {
    const j = babalawo.judge({ header: recs[0], oduText, diffs });
    if (!j.ok) return refuse(j.words);
    vText = j.text;
  } else {
    vText = fs.readFileSync(vFile, 'utf8');
    if (!verifyText(vText).ok) return refuse(`the verdict log of ${id} does not verify (orunmila verify ${dir})`);
  }
  const parse = (t) => t.split('\n').slice(0, -1).map((l) => JSON.parse(l));
  const q = checkLog(dir, 'quarantine');
  const quarantined = q.records.filter((r) => !(r.part === 1 && r.line === 1) && !(r.part > 1 && r.line === 1)).length;
  const rep = buildReport({ header: recs[0], marks: recs.slice(1), odus: parse(oduText), verdicts: parse(vText), quarantined, judgedNow, diffs });
  const html = flag('html', null);
  if (html) {
    fs.writeFileSync(html, renderHtml(rep));
    console.log(`Wrote ${html}: ${rep.top_line}`);
  } else if (args.includes('--json')) process.stdout.write(renderJson(rep) + '\n');
  else process.stdout.write(renderText(rep));
}

function cmdReport() {
  if (args.includes('--verdicts')) return cmdReportVerdicts();
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
  // Ship item 5 (LD292): kept for this release; the session report from the verdict log replaces it.
  console.log('Note: orunmila html is replaced by orunmila report --verdicts --session ID --html FILE (one file, nothing loaded from the network); this command stays for this release.');
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

/**
 * MR3 (LD316): the witness gap of a session, from its odù log in <home>/sessions/<id>/ (counts and one sentence; no
 * path), or null when it has none that verifies, so the page says it is not shown rather than show nothing as clean.
 */
function witnessGapOf(sessionId) {
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const { verifyText } = require('../src/verify/chain');
  const { witnessGap } = require('../src/babalawo/report');
  try {
    const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
    const text = fs.readFileSync(path.join(home, 'sessions', sessionFolderName(sessionId), 'odu.jsonl'), 'utf8');
    if (!verifyText(text).ok) return null;
    return witnessGap(text.split('\n').slice(0, -1).map((l) => JSON.parse(l)));
  } catch {
    return null;
  }
}

function cmdTrail() {
  // --marks (slice B7, LD149): the trail from the intake's session log in
  // <home>/sessions/<id>/, both witnesses on every row. --json only.
  if (args.includes('--marks')) return cmdTrailMarks();
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
  const html = renderSessionHtml(sessionId, reports, trail, { witnesses: witnessGapOf(sessionId) });
  const suffix = fromArchive ? `-archive-${fromArchive}` : '';
  const outPath = flag('out', path.join(process.cwd(), `orunmila-trail-${sessionId}${suffix}.html`));
  fs.writeFileSync(outPath, html);
  const t = rawTrail.totals;
  if (fromArchive) console.log(`(archived snapshot: ${fromArchive})`);
  console.log(`Wrote ${outPath}`);
  console.log(`Trail (the glove): ${t.touches} touches across ${t.artifacts} artifacts in ${t.turns} turns.`);
}

function cmdTrailMarks() {
  const { trailFromSessionFolder } = require('../src/trail/from-marks');
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const sessions = path.join(home, 'sessions');
  let id = flag('session', null);
  if (!id) {
    // The session whose raw log was written last.
    let best = null;
    for (const name of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const m = fs.statSync(path.join(sessions, name, 'raw.jsonl')).mtimeMs;
        if (!best || m > best.m) best = { name, m };
      } catch {
        /* not a session folder */
      }
    }
    id = best && best.name;
  }
  let dir;
  try {
    dir = id && path.join(sessions, sessionFolderName(id));
  } catch {
    dir = null; // an id unsafe as a folder name has no session log
  }
  if (!dir || !fs.existsSync(path.join(dir, 'raw.jsonl'))) {
    console.log(`orunmila trail --marks: no session log for ${id ? JSON.stringify(id) : 'any session'} in ${sessions}`);
    process.exitCode = 1;
    return;
  }
  if (!args.includes('--json')) {
    console.log('orunmila trail --marks: only --json is built for the session logs so far');
    process.exitCode = 2;
    return;
  }
  const home2 = !args.includes('--no-redact-home');
  const { trail } = redactForRender([], trailFromSessionFolder(dir), { home: home2, root: process.cwd() });
  const json = renderTrailJson(trail, { factsOnly: args.includes('--facts-only') });
  const out = flag('out', null);
  if (out) {
    fs.writeFileSync(out, json);
    console.log(`Wrote ${out}`);
  } else process.stdout.write(json + '\n');
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
  // Ship item 5 (B6w, LD165): the per-session logs are removed whole by retention instead.
  console.log('prune trims the old event log (~/.orunmila/events.jsonl). The per-session logs the intake writes are removed whole, and recorded, by `orunmila retention`, which replaces prune for them.');
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

/**
 * `orunmila retention --keep-days N [--yes]` — retention replaces `prune` for the
 * per-session logs (slice B6w, LD165; brief v4 line 348; test 45; N4). It lists
 * the session folders in <home>/sessions/ whose last record is older than N
 * days, and with --yes removes each whole, the removal written first to
 * <home>/retention.jsonl (src/opon/ledger/retention.js). A session the running
 * intake holds is never removed. N comes from --keep-days, else
 * ORUNMILA_RETENTION_DAYS; with neither nothing is removed. Exit 0 done or
 * nothing due, 1 something due without --yes or a removal refused, 2 no period.
 */
function cmdRetention() {
  const { plan, retire, readRetentionLog } = require('../src/opon/ledger/retention');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const sessionsDir = path.join(home, 'sessions');
  const logFile = path.join(home, 'retention.jsonl');
  const given = flag('keep-days', process.env.ORUNMILA_RETENTION_DAYS || null);
  if (given === null || !/^[1-9][0-9]*$/.test(String(given))) {
    console.error('Usage: orunmila retention --keep-days N [--yes]   (or ORUNMILA_RETENTION_DAYS=N), N whole days, at least 1.');
    console.error('Nothing is removed until you choose a period.');
    process.exitCode = 2;
    return;
  }
  const keepDays = Number(given);
  const log = readRetentionLog(logFile);
  if (!log.ok) {
    console.log(`Nothing removed: ${log.words}. Retention stops until the log is looked at.`);
    process.exitCode = 1;
    return;
  }
  let held = [];
  try {
    held = JSON.parse(fs.readFileSync(path.join(home, 'intake', 'held.json'), 'utf8'));
  } catch {
    /* no held list: the intake holds nothing */
  }
  const holding = new Set(Array.isArray(held) ? held : []);
  const old = fs.existsSync(sessionsDir) ? plan({ sessionsDir, keepDays, now: new Date().toISOString() }) : [];
  for (const id of old.filter((x) => holding.has(x))) console.log(`Kept ${id}: the running intake holds it.`);
  const due = old.filter((x) => !holding.has(x));
  if (!due.length) {
    console.log(`No session log is older than ${keepDays} day(s) in ${sessionsDir}.`);
    return;
  }
  if (!args.includes('--yes')) {
    console.log(`These session logs are older than ${keepDays} day(s); --yes removes each one whole, recorded first in ${logFile}:`);
    for (const id of due) console.log(`  ${id}`);
    process.exitCode = 1;
    return;
  }
  let refused = 0;
  for (const id of due) {
    const r = retire({ sessionsDir, id, logFile, reason: `older than ${keepDays} day(s)` });
    if (r.ok) console.log(`Removed ${id} (retention record ${r.seq}${r.finished ? ', a removal cut short, finished' : ''}).`);
    else {
      refused++;
      console.log(`Kept ${id}: ${r.reason}`);
    }
  }
  console.log(`Retention log: ${readRetentionLog(logFile).words}.`);
  if (refused) process.exitCode = 1;
}

function cmdLog() {
  // The user's two explicit choices for a log written before 0.2.2 (legacy.js).
  // Nothing here runs from a hook, and delete refuses without --yes.
  const sub = args[1];
  const dir = eventlog.dataDir();
  if (sub === 'redact') {
    const res = legacy.redactAll(dir);
    const log = res.log ? `${res.log.changed} of ${res.log.lines} event lines changed` : 'no event log found';
    console.log(`Redacted ${dir}: ${log}; ${res.files_changed} of ${res.files_scanned} other stored files changed.`);
    console.log('Known secret formats only: an unknown format can survive. Rotate any credential you know an agent saw.');
    return;
  }
  if (sub === 'delete') {
    const targets = legacy.deletionTargets(dir);
    if (!args.includes('--yes')) {
      console.log(targets.length ? 'This would permanently delete:' : `Nothing to delete in ${dir}.`);
      for (const t of targets) console.log(`  ${t}`);
      if (targets.length) console.log('Re-run as `orunmila log delete --yes` to delete. Your laws.json is kept.');
      process.exit(targets.length ? 1 : 0);
    }
    const removed = legacy.deleteAll(dir);
    console.log(`Deleted ${removed.length} item(s) from ${dir}. Your laws.json is kept.`);
    return;
  }
  console.error('Usage: orunmila log redact | orunmila log delete [--yes]');
  process.exit(1);
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
    const userFile = !args.includes('--project');
    const target = userFile ? lawPaths({ root }).user : lawPaths({ root }).project;
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
      ) + '\n',
      // Your own file lives in the data dir, which is owner-only since 0.2.2. A
      // project file is repo config, so it keeps the default mode.
      userFile ? { mode: 0o600 } : {}
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
  // The same switch the live gate reads, so a replay judges as the gate did.
  const strictProof = require('../src/laws/gate').strictProofEnabled();
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
    const prompt = turnEvents.find((e) => e.type === eventlog.TYPES.USER_PROMPT);
    // Judge EVERY claim in the turn. Historical sessions captured before the
    // turn-boundary fix folded several responses into one turn_id, and taking
    // only the first left the later ones unjudged entirely.
    const claims = turnEvents.filter((e) => e.type === eventlog.TYPES.TURN_CLAIM && e.text && String(e.text).trim());
    for (const claim of claims) {
    claimed++;
    const res = evaluateTurn({
      claimText: String(claim.text),
      promptText: prompt && prompt.text ? String(prompt.text) : '',
      turnEvents,
      laws: active,
      strictProof,
    });
    if (!res.findings.length) continue;
    flagged++;
    if (res.blocking.length) blocked++;
    out.turns.push({ turn_id: turnId, receipts: res.receipts, findings: res.findings });
    }
  }

  // The replay above cannot see what the live gate declined to judge; its own
  // per-turn records can (brief Step 5: skips are counted and reported).
  const live = require('../src/laws/gate').liveGateCounts(sessionId, {
    claims: events.filter((e) => e.type === eventlog.TYPES.TURN_CLAIM),
  });
  out.live_gate = live;

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
  console.log(
    `Live gate: ${live.checked} turn(s) checked, ${live.skipped} skipped ` +
      `(${live.skipped_unconfirmed} with no confirmed text, ${live.skipped_repeat} repeating the last claim), ${live.blocked} blocked.` +
      ` ${live.unrecorded} claimed turn(s) have no gate record of their own.` +
      (live.recorded ? '' : ' The gate left no record for this session.') +
      (live.unreadable ? ` ${live.unreadable} record(s) could not be read.` : '')
  );
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
  // K6 (LD218): the odù log's feedback with ORUNMILA_FEEDBACK_FROM_ODU=1, or both with --side-by-side; else the old path, unchanged.
  const fromOdu = process.env.ORUNMILA_FEEDBACK_FROM_ODU === '1';
  const both = args.includes('--side-by-side');
  const oldJson = () => {
    const { reports } = loadReportsForRead(sessionId);
    const events = eventlog.readSession(sessionId);
    return renderJson({ sessionId, agent: detectAgent(), reports, events, turn, include, redactOpts: { home, root: process.cwd() } });
  };
  const oduJson = () => {
    const { feedbackFromOdu } = require('../src/opon/feedback/from-odu');
    const { sessionFolderName } = require('../src/opon/intake/paths');
    const file = path.join(eventlog.dataDir(), 'sessions', sessionFolderName(sessionId), 'odu.jsonl');
    if (!fs.existsSync(file)) {
      console.error(`No odù log for session ${sessionId} (${file}): the intake writes one only with ORUNMILA_OPON_LIVE=1.`);
      process.exit(1);
    }
    // F7 (LD248): the old path's generated_at is its latest event's time; here, the latest observed_at of the raw log beside
    // the odù log. F15 (LD287): read a line at a time, never as one string (a raw log can pass V8's longest, about 512 MB).
    const generatedAt = fs.existsSync(path.join(path.dirname(file), 'raw.jsonl')) ? require('../src/verify/session').latestObservedAt(path.dirname(file)) : null;
    return feedbackFromOdu({ sessionId, agent: detectAgent(), oduText: fs.readFileSync(file, 'utf8'), turn, include, generatedAt, redactOpts: { home, root: process.cwd() } });
  };
  // BB9 (LD273): the verdicts' feedback with ORUNMILA_FEEDBACK_FROM_VERDICTS=1, in the same 1.0 shape; with --side-by-side, beside the old path's.
  const fromVerdicts = process.env.ORUNMILA_FEEDBACK_FROM_VERDICTS === '1';
  const verdictJson = () => {
    const { checkLog } = require('../src/verify/session');
    const { sessionFolderName } = require('../src/opon/intake/paths');
    const { feedbackFromVerdicts } = require('../src/babalawo/report/feedback');
    const dir = path.join(eventlog.dataDir(), 'sessions', sessionFolderName(sessionId));
    const raw = checkLog(dir, 'raw');
    const oduFile = path.join(dir, 'odu.jsonl');
    if (!raw.ok || !fs.existsSync(oduFile)) {
      console.error(`No verified raw log and odù log for session ${sessionId} in ${dir}: the verdicts' feedback needs both (ORUNMILA_OPON_LIVE=1).`);
      process.exit(1);
    }
    const recs = raw.records.filter((r) => !(r.part > 1 && r.line === 1)).map((r) => r.rec);
    const oduText = fs.readFileSync(oduFile, 'utf8');
    const vFile = path.join(dir, 'verdict.jsonl');
    const judgedNow = !fs.existsSync(vFile);
    let verdictText;
    if (judgedNow) {
      const j = require('../src/babalawo').judge({ header: recs[0], oduText });
      if (!j.ok) {
        console.error(j.words);
        process.exit(1);
      }
      verdictText = j.text;
    } else verdictText = fs.readFileSync(vFile, 'utf8');
    const generatedAt = recs.reduce((a, r) => (typeof r.observed_at === 'string' && (a === null || r.observed_at > a) ? r.observed_at : a), null);
    return feedbackFromVerdicts({ sessionId, agent: detectAgent(), header: recs[0], marks: recs.slice(1), oduText, verdictText, judgedNow, generatedAt, turn, include, redactOpts: { home, root: process.cwd() } });
  };
  let json;
  if (both) {
    const { sideBySide } = require('../src/opon/feedback/from-odu');
    const old = JSON.parse(oldJson());
    const odu = fromVerdicts ? verdictJson() : oduJson();
    json = JSON.stringify({ old, [fromVerdicts ? 'verdicts' : 'odu']: odu, compare: sideBySide(old, odu) }, null, 2);
  } else json = fromVerdicts ? JSON.stringify(verdictJson(), null, 2) : fromOdu ? JSON.stringify(oduJson(), null, 2) : oldJson();
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

/**
 * `orunmila verify <session-folder> [--json]` — check a session log folder end
 * to end (src/verify/session.js) and answer in plain words. Exit 0 intact,
 * 1 broken, 2 usage. The folder format is Phase 1's; the intake writes it
 * (`orunmila intake`, `install --intake`).
 */
function cmdVerify() {
  if (args.includes('--updates')) {
    // PM2a (Q44 (a), LD329): the update log in Orunmila's home, hash-chained, each record against its schema.
    const { readUpdatesLog, updatesFile } = require('../src/opon/ledger/updates');
    const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
    const r = readUpdatesLog(home);
    console.log(`${updatesFile(home)}: ${r.words}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const dir = args[1] && !args[1].startsWith('--') ? args[1] : null;
  if (!dir) {
    console.error('Usage: orunmila verify <session-folder> [--json]');
    process.exit(2);
  }
  const { verifySession } = require('../src/verify/session');
  const r = verifySession(path.resolve(dir));
  if (args.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else console.log(r.words);
  process.exitCode = r.ok ? 0 : 1;
}

/**
 * `orunmila leak-check [--root dir] [--path p]...` — search everything Orunmila
 * stored, and the report files it wrote, for the exact values of the project's
 * `.env` files (LD93, LD95). Run by hand: nothing runs it automatically.
 * Prints names, never values. Exit 0 none found, 1 found, 2 nothing checked, a
 * path not read, or a failure.
 */
function cmdLeakCheck() {
  try {
    leakCheck();
  } catch (err) {
    // The code only: an error's message is never printed, so it cannot carry a value.
    console.log(`leak-check failed (${(err && (err.code || err.name)) || 'error'}): nothing reliable was checked.`);
    process.exitCode = 2;
  }
}

function leakCheck() {
  const lc = require('../src/opon/intake/leak-check');
  // Every argument is --root <dir> or --path <file-or-folder>; anything else
  // (--path=x, a typo) is refused, so a path is never dropped in silence.
  const paths = [];
  let root = process.cwd();
  for (let i = 1; i < args.length; i++) {
    const value = args[i + 1];
    if ((args[i] !== '--path' && args[i] !== '--root') || !value || value.startsWith('--')) {
      console.log(`Usage: orunmila leak-check [--root dir] [--path file-or-folder]...  (not understood: ${args[i]})`);
      process.exitCode = 2;
      return;
    }
    if (args[i] === '--path') paths.push(path.resolve(value));
    else root = value;
    i++;
  }
  root = path.resolve(root);
  const { entries, files: envFiles, unreadable: envUnread, sources } = lc.readEnvEntries(root);
  for (const u of envUnread) console.log(`NOT READ  ${u}`);
  if (!entries.length) {
    console.log(envFiles.length
      ? `No value in ${envFiles.join(', ')} can be checked (it needs 8+ characters, or 4+ under a secret name; true, false, null, undefined and the like are not looked for).`
      : `No readable .env file in ${root}: there is nothing to check against.`);
    console.log('Nothing was checked.');
    process.exitCode = 2;
    return;
  }
  // The data dir by the same rule as eventlog.dataDir(), which would create it.
  const data = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const targets = lc.defaultTargets({ dataDir: data, root });
  for (const p of paths) targets.push({ path: p, required: true });
  const r = lc.scan(targets, entries, { skip: sources });
  const unread = [...envUnread, ...r.unreadable];
  console.log(`Checked ${entries.length} value(s) from ${envFiles.join(', ')} in ${root}`);
  console.log(`against ${r.files} file(s): the data dir ${data}, report files in the root, and each --path.`);
  for (const h of r.hits) {
    console.log(`\x1b[31mLEAK\x1b[0m  ${h.file} line ${h.line}, byte ${h.byte}  ${h.names.join(', ')} (${h.length} characters), ${h.count} time(s) in this file`);
  }
  for (const u of r.unreadable) console.log(`NOT READ  ${u}`);
  console.log('Not checked: anything printed to the terminal or piped (trail --json, json without --out). Pass a saved copy with --path.');
  if (r.hits.length) {
    const files = new Set(r.hits.map((h) => h.file)).size;
    console.log(`\n${r.hits.length} value(s) found in ${files} file(s). Values are never printed.`);
    console.log('Rotate each secret named above. `orunmila log redact` removes known formats only, not these values.');
    process.exitCode = 1;
    return;
  }
  if (!r.files) {
    console.log('\nNo file was checked: there is no data dir, report file or --path to read.');
    process.exitCode = 2;
    return;
  }
  if (unread.length) {
    console.log(`\nNo value found, but ${unread.length} path(s) were not read, so this is not a clean result.`);
    process.exitCode = 2;
    return;
  }
  console.log('\nNo value found.');
}

/**
 * `orunmila intake run|start|status|stop` — the intake server (slice B1e,
 * LD132): one per machine, on a Unix socket in Orunmila's home. `run` serves in
 * the foreground (what a launch agent runs); `start` runs it detached and waits
 * up to 5 s for it to answer; `status` exits 0 when one answers, 1 when none
 * does; `stop` asks it to stop over its socket (TE2, LD283; SIGTERM after 2 s for an intake from before TE2) and
 * waits for it to go. A signal no one asked for is recorded as tampering and exits 1, so the launch agent restarts it.
 * Nothing sends to it yet: the hooks' sender is slice B2.
 */
/**
 * PM2c3 (LD334): what node runs for `intake run`: the starter and the current version's CLI, when `install` made them
 * (so a restart runs the version an update switched to), else this copy.
 */
function intakeArgv(home) {
  const starter = path.join(home, 'bin', 'orunmila-start.js');
  const { starterTarget } = require('../src/runtime/install');
  return fs.existsSync(starter) && starterTarget(starter, 'bin/orunmila.js').ok ? [starter, 'bin/orunmila.js', 'intake', 'run'] : [__filename, 'intake', 'run'];
}

async function cmdIntake() {
  const { createServer, intakePaths, readInstallKey, statusOf, intakePort, oponLive } = require('../src/opon/intake/server');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const p = intakePaths(home);
  const sub = args[1];
  const waitFor = async (cond, ms = 5000) => {
    for (let end = Date.now() + ms; Date.now() < end; ) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };
  if (sub === 'run') {
    const { createRouter } = require('../src/opon/intake/router');
    const { nowMono } = require('../src/opon/intake/mono');
    const { judgeOn, switchesFile } = require('../src/opon/intake/switches');
    const judge = judgeOn(process.env, home); // BJ1 (LD326): the install's switch, the environment winning where set
    const router = createRouter({
      home,
      clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }),
      checkSender: require('../src/opon/intake/peer').isAgentProgram, // the pid runs claude (LD139)
      codeRoot: path.join(__dirname, '..', 'src'),
      orunmilaVersion: require('../package.json').version,
      installKey: readInstallKey(home),
      sentinel: true, // the Sentinel runs inside the intake (B4, LD145)
      baseline: oponLive(), // the Ọpọ́n's live path, only with ORUNMILA_OPON_LIVE=1: the baseline at session start (N1b, LD170), stations 2-6 and odu.jsonl (L1c, LD200)
      guard: process.env.ORUNMILA_LOG_GUARD === '1', // TE1 (LD279): every session's logs watched for a change Orunmila did not make, and put back
      judge: judge.on, // the judge at each closeout (BB6), only when switched on (BJ1: install --with-judge, or ORUNMILA_JUDGE_LIVE=1; Q38)
      // Q12 (a) (LD289): extra folders the Sentinel watches, absolute paths joined by the path delimiter (none by default)
      watchExtra: (process.env.ORUNMILA_WATCH_EXTRA || '').split(path.delimiter).filter((x) => x && path.isAbsolute(x)),
      asyncStart: process.env.ORUNMILA_ASYNC_START === '1', // SN1 (LD294): a session's start off the intake's thread (F16)
      peerBusy: process.env.ORUNMILA_PEER_BUSY === '1', // AT1b (LD330): a peer's working time noted in each session's log
    });
    // TE2 (LD283): a stop asked for comes over the socket (`orunmila intake stop`) and exits 0; a signal with no ask is
    // a tampered mark in every held session, kept in last-stop.json for the next start's gap, and exits 1, so the
    // launch agent (KeepAlive SuccessfulExit false) starts the intake again.
    const lastStop = path.join(p.dir, 'last-stop.json');
    let resumeAlso = null;
    try {
      const k = JSON.parse(fs.readFileSync(lastStop, 'utf8'));
      if (k && typeof k.signal === 'string') resumeAlso = `the intake was stopped by ${k.signal}, which no one asked for through \`orunmila intake stop\` (at ${k.at})`;
    } catch {
      /* none kept: the last stop was asked for, or a kill no handler sees */
    }
    let stopping = false;
    let server = null;
    const onStop = async (reason) => {
      if (stopping) return;
      stopping = true;
      await server.stop(`stopped as asked: ${reason}`);
      process.exit(0);
    };
    server = createServer({ home, router, httpPort: intakePort(), onStop, resumeAlso, version: require('../package.json').version });
    const r = await server.start();
    if (!r.ok) {
      console.error(`orunmila intake: ${r.reason}`);
      process.exit(r.code === 'running' ? 3 : 1);
    }
    fs.rmSync(lastStop, { force: true }); // named once, in this start's gaps
    console.log(`orunmila intake: listening on ${r.sock} (pid ${process.pid})` + (r.squat ? `; another process held the socket: recorded in ${p.errors}` : ''));
    console.log(r.http.listening ? `orunmila intake: HTTP on 127.0.0.1:${r.http.port}` : `orunmila intake: HTTP port 127.0.0.1:${r.http.port} is held by another process (recorded in ${p.errors}); tried again every second`);
    const why = judge.from === 'environment' ? `ORUNMILA_JUDGE_LIVE=${judge.on ? 1 : 0}` : judge.from === 'switch' ? `the switch in ${switchesFile(home)}` : 'turn it on with: orunmila install --with-judge';
    console.log(`orunmila intake: the judge is ${judge.on ? 'on' : 'off'} (${why})`);
    console.log(process.env.ORUNMILA_PEER_BUSY === '1' ? "orunmila intake: each session's log notes when a peer sharing its folder is working (ORUNMILA_PEER_BUSY=1)" : "orunmila intake: a peer's busy time is not noted; ORUNMILA_PEER_BUSY=1 turns it on");
    // PM2c2 (LD333): the daily update check, read at each tick so the switch takes effect without a restart; the update
    // runs as its own process (src/runtime/daily.js), never in the intake's. ORUNMILA_UPDATE_POLL_MS is for tests.
    const { updatesOn } = require('../src/opon/intake/switches');
    const daily = require('../src/runtime/daily');
    const upd = updatesOn(process.env, home);
    console.log(`orunmila intake: the daily update check is ${upd.on ? 'on' : 'off'} (${upd.from === 'environment' ? `ORUNMILA_UPDATES=${upd.on ? 1 : 0}` : upd.from === 'switch' ? `the switch in ${switchesFile(home)}` : 'turn it on with: orunmila install --with-updates'})`);
    setInterval(() => {
      try {
        if (updatesOn(process.env, home).on && daily.due(home)) daily.startUpdate(home);
      } catch (e) {
        console.error(`orunmila intake: the daily update check could not start (${e.code || e.message})`);
      }
    }, Number(process.env.ORUNMILA_UPDATE_POLL_MS) > 0 ? Number(process.env.ORUNMILA_UPDATE_POLL_MS) : 60 * 60 * 1000).unref();
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, async () => {
        if (stopping) return;
        stopping = true;
        await server.stop(`stopped by ${sig}, which no one asked for through orunmila intake stop`, { signal: sig });
        fs.writeFileSync(lastStop, JSON.stringify({ signal: sig, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
        process.exit(1);
      });
    }
    // PM2c3 (LD334): an intake run from the copy in Orunmila's home moves onto the version an update switched to, once
    // it holds no session (so no session's record sees its code change): a stop as asked, then a start through the
    // starter; under the launch agent, exit 75 and launchd starts it again (KeepAlive after a failed exit).
    const runtimeDir = path.join(home, 'runtime');
    let ownFolder = null;
    try {
      if (path.dirname(fs.realpathSync(path.join(__dirname, '..'))) === fs.realpathSync(runtimeDir)) ownFolder = path.basename(fs.realpathSync(path.join(__dirname, '..')));
    } catch {
      ownFolder = null; // no runtime in the home: this intake runs from another copy, and stays on it
    }
    if (ownFolder) {
      const pollMs = Number(process.env.ORUNMILA_UPDATE_POLL_MS) > 0 ? Number(process.env.ORUNMILA_UPDATE_POLL_MS) : 60 * 1000;
      setInterval(async () => {
        if (stopping) return;
        let cur;
        try {
          cur = fs.readFileSync(path.join(runtimeDir, 'current'), 'utf8').trim();
        } catch {
          return;
        }
        if (cur === ownFolder || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(cur) || router.held().length) return;
        stopping = true;
        const to = cur.split('_')[0];
        console.log(`orunmila intake: moving onto ${to} (an update switched to it, and no session is held)`);
        await server.stop(`moving onto Orunmila ${to}: an update switched to it while no session was held`);
        if (process.env.XPC_SERVICE_NAME === require('../src/opon/intake/launch-agent').LABEL) process.exit(75);
        const out = fs.openSync(p.out, 'a', 0o600);
        require('child_process').spawn(process.execPath, [path.join(home, 'bin', 'orunmila-start.js'), 'bin/orunmila.js', 'intake', 'run'], { detached: true, stdio: ['ignore', out, out], env: process.env, windowsHide: true }).unref();
        process.exit(0);
      }, pollMs).unref();
    }
    return;
  }
  if (sub === 'start') {
    const st = await statusOf(p.sock);
    if (st) {
      console.log(`orunmila intake: already running (pid ${st.pid}) on ${p.sock}`);
      return;
    }
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const out = fs.openSync(p.out, 'a', 0o600);
    // PM2c3 (LD334): through the starter when `install` made one, so the intake is the starter's child and has a pid of
    // its own; none answered before this start, so the one that answers now is this one.
    const child = require('child_process').spawn(process.execPath, intakeArgv(home), { detached: true, stdio: ['ignore', out, out], env: process.env, windowsHide: true });
    child.unref();
    fs.closeSync(out);
    let seen = null;
    await waitFor(async () => (seen = await statusOf(p.sock, 300)) !== null);
    if (seen) {
      console.log(`orunmila intake: started (pid ${seen.pid}${seen.version ? `, Orunmila ${seen.version}` : ''}) on ${p.sock}`);
      return;
    }
    console.log(`orunmila intake: did not start within 5 s; its output is in ${p.out}`);
    process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    const st = await statusOf(p.sock);
    if (!st) {
      console.log(`orunmila intake: not running (nothing answers on ${p.sock})`);
      process.exitCode = 1;
      return;
    }
    const h = st.http;
    const web = h ? `; http 127.0.0.1:${h.port}${h.listening ? '' : ' (not listening: another process holds it)'}` : '; no HTTP';
    console.log(`orunmila intake: running (pid ${st.pid}) since ${st.started_at} on ${st.socket}${web}; ${st.held.length} session(s) held`);
    return;
  }
  if (sub === 'stop') {
    const st = await statusOf(p.sock);
    if (!st) {
      console.log(`orunmila intake: not running (nothing answers on ${p.sock})`);
      process.exitCode = 1;
      return;
    }
    // TE2 (LD283): ask over the socket, so the intake knows the stop was asked for. An intake from before TE2 does not
    // know the op; for it, after 2 s, the old way: SIGTERM.
    await new Promise((resolve) => {
      const c = require('net').createConnection(p.sock);
      c.on('error', resolve);
      c.on('close', resolve);
      c.on('connect', () => c.end(JSON.stringify({ op: 'stop', reason: 'orunmila intake stop' }) + '\n'));
    });
    let gone = await waitFor(async () => !fs.existsSync(p.lock) && (await statusOf(p.sock, 300)) === null, 2000);
    if (!gone) {
      process.kill(st.pid, 'SIGTERM');
      gone = await waitFor(async () => !fs.existsSync(p.lock) && (await statusOf(p.sock, 300)) === null);
    }
    console.log(gone ? `orunmila intake: stopped (pid ${st.pid})` : `orunmila intake: pid ${st.pid} did not stop within 7 s`);
    if (!gone) process.exitCode = 1;
    return;
  }
  if (sub === 'agent') {
    // The per-user launch agent (slice LA, LD143). ORUNMILA_LAUNCH_AGENTS_DIR and
    // ORUNMILA_LAUNCHCTL exist for tests: they never touch the real launchd.
    const { createLaunchAgent } = require('../src/opon/intake/launch-agent');
    const launchctl = process.env.ORUNMILA_LAUNCHCTL || '/bin/launchctl';
    const agent = createLaunchAgent({
      uid: process.getuid ? process.getuid() : null,
      dir: process.env.ORUNMILA_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents'),
      run: (a) => require('child_process').spawnSync(launchctl, a, { encoding: 'utf8' }),
    });
    const act = args[2];
    let r;
    if (act === 'install') r = agent.install({ node: process.execPath, script: __filename, home, env: process.env, args: intakeArgv(home) }); // PM2c3 (LD334)
    else if (act === 'uninstall') r = agent.uninstall();
    else if (act === 'status') r = agent.status();
    else {
      console.log('Usage: orunmila intake agent install|uninstall|status');
      process.exitCode = 2;
      return;
    }
    if (!r.ok) {
      console.error(`orunmila intake agent: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    if (act === 'install') console.log(`orunmila intake agent: installed ${r.plist} and loaded it (${agent.service}); remove with: orunmila intake agent uninstall (launchctl bootout ${agent.service})`);
    else if (act === 'uninstall') console.log(r.removed ? `orunmila intake agent: booted out ${agent.service} and removed ${r.removed}` : `orunmila intake agent: none installed (${agent.plist} is absent); booted out ${agent.service} if it was loaded`);
    else {
      console.log(r.loaded ? `orunmila intake agent: loaded (${agent.service}), state ${r.state || 'unknown'}${r.pid ? `, pid ${r.pid}` : ''}` : `orunmila intake agent: not loaded (${agent.service})`);
      if (!r.loaded) process.exitCode = 1;
    }
    return;
  }
  console.log('Usage: orunmila intake run|start|status|stop|agent');
  process.exitCode = 2;
}

/**
 * `orunmila replay <session-folder> [--out file] [--expect file]` (Phase 2
 * slice R1, LD152): the Ọpọ́n's output for a recorded raw log. With --expect,
 * compares it with an earlier output and names the first line that differs
 * (exit 1); exit 0 when they are the same. A log that does not verify is
 * refused (exit 1).
 */
function cmdReplay() {
  const { replayFolder } = require('../src/opon/replay');
  const dir = args[1] && !args[1].startsWith('--') ? args[1] : null;
  if (!dir) {
    console.error('Usage: orunmila replay <session-folder> [--out file] [--expect file]');
    process.exitCode = 2;
    return;
  }
  const r = replayFolder(dir);
  if (!r.ok) {
    console.log(r.words);
    process.exitCode = 1;
    return;
  }
  const expect = flag('expect', null);
  if (expect) {
    const want = fs.readFileSync(expect, 'utf8').split('\n');
    const got = r.text.split('\n');
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      if (want[i] !== got[i]) {
        console.log(`replay differs from ${expect} at line ${i + 1}:\n  expected: ${want[i] === undefined ? '(no line)' : want[i]}\n  replayed: ${got[i] === undefined ? '(no line)' : got[i]}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`replay matches ${expect} (${r.lines.length} lines)`);
    return;
  }
  const out = flag('out', null);
  if (out) {
    fs.writeFileSync(out, r.text);
    console.log(`Wrote ${out} (${r.words})`);
  } else process.stdout.write(r.text);
}

/**
 * `orunmila judge --session <id> [--rules <file>]` (Phase 6 slice BB6; brief v4 line 684): judge a session's sealed odù
 * log again and append to its verdict log (verdict.jsonl beside the other two): each verdict that changed supersedes
 * the old one, which is never edited. The rules are the header's (the rules file as it was at session start), or the
 * file named. Nothing else in the folder is written. Exit 0 judged, 1 refused (a session the intake still holds, TE1's
 * rest; a log that does not verify, a rules file that cannot be read), 2 usage.
 */
async function cmdJudge() {
  const { checkLog } = require('../src/verify/session');
  const { statusOf, intakePaths } = require('../src/opon/intake/server');
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const { verifyText } = require('../src/verify/chain');
  const { canonicalize } = require('../src/verify/canonical');
  const babalawo = require('../src/babalawo');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const id = flag('session', null);
  let dir;
  try {
    dir = id && path.join(home, 'sessions', sessionFolderName(id));
  } catch {
    dir = null; // an id unsafe as a folder name has no session log
  }
  if (!dir) {
    console.error('Usage: orunmila judge --session <id> [--rules <file>]');
    process.exitCode = 2;
    return;
  }
  const refuse = (words) => {
    console.log(`orunmila judge: ${words}`);
    process.exitCode = 1;
  };
  // TE1's rest (LD285): one writer per verdict log. While the intake holds the session it may write the verdict log at
  // a closeout, and with ORUNMILA_LOG_GUARD=1 it takes any other write for tampering and puts the log back.
  const st = await statusOf(intakePaths(home).sock, 1000);
  if (st && Array.isArray(st.held) && st.held.includes(id)) {
    return refuse(`not judged: the intake still holds session ${id} (it releases a session 30 minutes after its last payload), and only one process writes a session's verdict log; judge it after that`);
  }
  const raw = checkLog(dir, 'raw');
  if (!raw.ok) return refuse(`not judged: the raw log of ${id} is missing or does not verify (orunmila verify ${dir})`);
  const oduFile = path.join(dir, 'odu.jsonl');
  if (!fs.existsSync(oduFile)) return refuse(`not judged: session ${id} has no odù log (the intake writes one only with ORUNMILA_OPON_LIVE=1)`);
  const file = path.join(dir, 'verdict.jsonl');
  let prior = [];
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!verifyText(text).ok) return refuse(`not judged: the verdict log ${file} does not verify, and it is never edited`);
    prior = text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
  }
  const rulesPath = flag('rules', null);
  let rulesText;
  if (rulesPath) {
    try {
      rulesText = fs.readFileSync(rulesPath, 'utf8');
    } catch (e) {
      return refuse(`not judged: the rules file ${rulesPath} could not be read (${e.code || e.message})`);
    }
  }
  const oduText = fs.readFileSync(oduFile, 'utf8');
  const { testDiffsFromMarks, oduRecords } = require('../src/opon/ledger/beside');
  const diffs = testDiffsFromMarks({ odus: oduRecords(oduText), marks: raw.records.map((x) => x.rec), dir }); // MR2 (LD317): R27
  const r = babalawo.judge({ header: raw.records[0].rec, oduText, rulesText, prior, diffs });
  if (!r.ok) return refuse(r.words);
  if (r.added.length) fs.appendFileSync(file, r.added.map((x) => canonicalize(x) + '\n').join(''), { mode: 0o600 });
  const s = r.records.filter((x) => x.record === 'session_verdict').pop();
  console.log(`orunmila judge: judged ${id}: ${r.added.length} record(s) added to ${file}; the session's verdict: ${s.verdict} (${s.rules_source} rules, ${babalawo.name} ${babalawo.version})`);
}

/**
 * `orunmila trailer --session ID [--append FILE]` (MR4, LD318): the session's verdict as git trailers (src/render/trailer.js),
 * printed, or appended to a commit message file (a `commit-msg` hook passes it as $1). A convenience outside the evidence
 * path: it reads the session folder and writes only the file named. Exit 0 done, 1 no session here or its verdict log
 * does not verify, 2 usage.
 */
function cmdTrailer() {
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const { verifyText } = require('../src/verify/chain');
  const { trailerLines, appendTrailers } = require('../src/render/trailer');
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const id = flag('session', null);
  let dir;
  try {
    dir = id ? path.join(home, 'sessions', sessionFolderName(id)) : null;
  } catch {
    dir = null; // an id unsafe as a folder name has no session log
  }
  if (!dir) {
    console.error('Usage: orunmila trailer --session ID [--append FILE]');
    process.exitCode = 2;
    return;
  }
  const refuse = (words) => {
    console.log(`orunmila trailer: ${words}`);
    process.exitCode = 1;
  };
  if (!fs.existsSync(path.join(dir, 'raw.jsonl'))) return refuse(`session ${id} has no session log here (${dir})`);
  let footer;
  try {
    footer = JSON.parse(fs.readFileSync(path.join(dir, 'footer.json'), 'utf8'));
  } catch {
    footer = null; // not closed out yet
  }
  let sessionVerdict = null;
  const vFile = path.join(dir, 'verdict.jsonl');
  if (fs.existsSync(vFile)) {
    const text = fs.readFileSync(vFile, 'utf8');
    if (!verifyText(text).ok) return refuse(`the verdict log of ${id} does not verify (orunmila verify ${dir}), so no verdict is given`);
    sessionVerdict = text.split('\n').slice(0, -1).map((l) => JSON.parse(l)).filter((r) => r.record === 'session_verdict').pop() || null;
  }
  const lines = trailerLines({ sessionId: id, footer, sessionVerdict });
  const file = flag('append', null);
  if (!file) return void process.stdout.write(lines.join('\n') + '\n');
  fs.writeFileSync(file, appendTrailers(fs.readFileSync(file, 'utf8'), lines));
  console.log(`orunmila trailer: ${lines.length} trailers in ${file}`);
}

/**
 * `orunmila update` (PM2c1, LD332; LD268): the copy in Orunmila's home brought up to the registry's latest version
 * (src/runtime/update.js), switched to only while no session is held: none held by the running intake, or, with no
 * intake running, none it will resume (its held.json). The registry is ORUNMILA_REGISTRY, else npm's own setting, else
 * npm's public registry; it is sent the package's name and nothing else. Exit 0 up to date, switched or waiting; 1
 * refused or failed (the update log has each failed self-check).
 */
async function cmdUpdate() {
  const { statusOf, intakePaths } = require('../src/opon/intake/server');
  const home = orunmilaHome();
  // PM2c2 (LD333): `--auto`, started by the daily check: only with the switch on, one at a time (runtime/update.lock,
  // taken over after 30 minutes), its answer in runtime/last-update; it prints nothing (no one reads a detached run).
  let lock = null;
  if (args.includes('--auto')) {
    if (!require('../src/opon/intake/switches').updatesOn(process.env, home).on) return;
    lock = path.join(home, 'runtime', 'update.lock');
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < 30 * 60 * 1000) return; // another update runs
        fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
      } catch {
        return;
      }
    }
  }
  const registry = process.env.ORUNMILA_REGISTRY || process.env.npm_config_registry || 'https://registry.npmjs.org';
  const held = async () => {
    const st = await statusOf(intakePaths(home).sock, 1000);
    if (st) return Array.isArray(st.held) && st.held.length > 0;
    try {
      const h = JSON.parse(fs.readFileSync(path.join(home, 'intake', 'held.json'), 'utf8'));
      return Array.isArray(h) && h.length > 0;
    } catch {
      return false; // no held list: nothing to resume
    }
  };
  if (lock) {
    try {
      const r = await require('../src/runtime/update').updateNow({ home, registry, held });
      const file = path.join(home, 'runtime', 'last-update');
      fs.writeFileSync(`${file}.${process.pid}.tmp`, `${new Date().toISOString()} ${r.status}: ${r.words}\n`, { mode: 0o600 });
      fs.renameSync(`${file}.${process.pid}.tmp`, file);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    return;
  }
  console.log(`orunmila update: asking ${registry} for the latest orunmila (only the package's name is sent)`);
  const r = await require('../src/runtime/update').updateNow({ home, registry, held });
  console.log(`orunmila update: ${r.words}`);
  process.exitCode = r.status === 'refused' || r.status === 'failed' ? 1 : 0;
}

const COMMANDS = {
  install: cmdInstall,
  update: cmdUpdate,
  replay: cmdReplay,
  judge: cmdJudge,
  intake: cmdIntake,
  agents: cmdAgents,
  laws: cmdLaws,
  stats: cmdStats,
  status: cmdStatus,
  prune: cmdPrune,
  retention: cmdRetention,
  log: cmdLog,
  lenses: cmdLenses,
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
  verify: cmdVerify,
  'leak-check': cmdLeakCheck,
  trailer: cmdTrailer,
};

// The installed version (SECURITY.md asks a reporter to give it; OW2, LD151).
if (cmd === '--version') {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (!cmd || !COMMANDS[cmd]) {
  console.log(`orunmila - claim-vs-reality verification for AI coding agents

Usage: orunmila <command> [options]

THREE LENSES, installed separately (orunmila lenses — which do I have?):

  The Stain Map      records + reports. Never refuses. All supported agents.
  The Closeout Gate  refuses a turn whose claims its evidence doesn't support.
                     claude-code only. 2 of its 6 laws block; the rest advise.
  The Babaláwo       judges each session's record at its closeout. Never refuses. Off until you turn it on.

Install
  orunmila install [--agent ID] [--global]        the Stain Map alone (default agent: claude-code)
  orunmila install --with-gate [--agent ID]       both lenses (--with-laws is the original spelling, still works)
  orunmila install --gate-only                    add the Closeout Gate to an existing Stain Map install
  orunmila install --intake                       send every hook payload to the intake too (claude-code; start it first)
  orunmila install --with-judge | --without-judge  the Babaláwo on or off (from the intake's next start)
  orunmila install --with-updates | --without-updates  the daily update check on or off (orunmila update by hand, always)
  orunmila lenses [--agent ID] [--global]         the three lenses side by side + which are installed right now
  orunmila agents                                 list supported agents and their config locations
  orunmila --version                              the installed version

The Stain Map — read what happened
  orunmila trail [--session ID] [--out path] [--archive STAMP] [--no-redact-home]
                                                  THE REPORT: complete trail (the glove) + lineage + stains
  orunmila trail --json [--facts-only] [--session ID] [--out path]
                                                  machine-readable trail; --facts-only drops the inferred lineage layer
  orunmila trail --json --marks [--facts-only] [--session ID]
                                                  the same, from the intake's session log: both witnesses on every row
  orunmila report [--session ID] [--turn ID] [--archive STAMP]   terminal stain report (live, or a pinned snapshot)
  orunmila html [--session ID] [--out path] [--archive STAMP]    mismatch-only HTML report
  orunmila json [--session ID] [--turn ID] [--include claim_text]   per-turn stain output (schema_version 1.0)
  orunmila json --session ID --side-by-side       the same beside the odù log's (ORUNMILA_FEEDBACK_FROM_ODU=1: the odù log's alone)
  orunmila demo [--out path]                      sample report from a scripted session — no setup, for a first look
  orunmila watch [--root dir]                     live-tail new turn reports + run the filesystem sentinel
  orunmila watch-fs [--root dir]                  run ONLY the filesystem sentinel (independent disk observer)

The Closeout Gate — read and tune what it enforces
  orunmila laws [--root dir]                      the laws in force + which layer each came from (4 = canon, 5 = yours)
  orunmila laws --check [--session ID] [--json]   replay those laws over a captured session, read-only
  orunmila laws --init                            scaffold your own laws file so you can retune or add to them
                                                  ORUNMILA_LAWS=off disables the gate for one session

Both lenses
  orunmila status [--agent ID]                    which lenses are live, event log location, size, counts
  orunmila stats                                  cross-agent reliability scores, phantom rates, comparisons
  orunmila prune [--keep N]                       cap the log to the N most-recent sessions (explicit, never automatic)
  orunmila retention --keep-days N [--yes]        remove session logs older than N days, each whole and recorded first
  orunmila log redact                             scrub known secret formats from everything already stored
  orunmila log delete [--yes]                     delete stored session data (lists it first; --yes to delete)
  orunmila leak-check [--root dir] [--path p]     search stored data and report files for this project's .env
                                                  values (names printed, never values; exit 1 if any found)
  orunmila rescore [--dry-run]                    re-reconcile every persisted report (originals archived, never deleted)
  orunmila archives                               list archived rescore snapshots, readable with --archive <stamp>
  orunmila feedback [--session ID] [--include claim_text]   write sanitized accuracy cases to a local drop folder
  orunmila feedback-import [--dir path] [--force]  copy those cases into test/cases/precision/
  orunmila debug-transcript <path>                inspect why transcript parsing isn't matching your install
  orunmila verify <session-folder> [--json]       check a session log folder's hash chains, records and kept files
                                                  (the per-session logs the intake writes, in ~/.orunmila/sessions/)
  orunmila verify --updates                       check the update log (~/.orunmila/updates.jsonl): each update, chained
  orunmila update                                 bring the copy in ~/.orunmila up to npm's latest; switched only while
                                                  no session is held (the one network call: the package's name is sent)
  orunmila intake run|start|status|stop           the intake server, one per machine (install --intake sends to it)
  orunmila intake agent install|uninstall|status  keep the intake running at login with a launch agent (macOS)
  orunmila replay <session-folder> [--expect file]  the Opon's settled groups for a session log, replayed (Phase 2)
  orunmila judge --session ID [--rules file]      judge a session's odù log again; new verdicts supersede, old ones stay
  orunmila report --verdicts --session ID [--html FILE] [--json]
                                                  the session report: top line, each finding naming both witnesses
  orunmila trailer --session ID [--append FILE]   the session's verdict as git trailers for a commit message
                                                  (a convenience, not evidence: orunmila verify proves the record)

Docs: README.md · known issues with status: review/ISSUES.md
`);
  process.exit(cmd ? 1 : 0);
}

COMMANDS[cmd]();
