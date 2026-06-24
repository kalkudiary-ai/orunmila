#!/usr/bin/env node
'use strict';

/**
 * bench.js — multi-agent benchmark runner with full Orunmila reconciliation.
 *
 * Usage:
 *   node bin/bench.js --agent claude-code [--model sonnet] [--corpus corpus/] [--task <id>]
 *
 * For each task: scaffolds files into a temp dir, installs orunmila hooks,
 * runs the agent, then reads back the reconciliation report to extract
 * phantoms, phantom verifications, wild writes, silently dropped asks,
 * and reliability scores — the metrics Orunmila is built to find.
 *
 * The --model flag sets the model tier (haiku, sonnet, opus, etc.) and tags
 * the agent in the event log as e.g. "claude-code:sonnet" so `orunmila stats`
 * shows side-by-side comparison across tiers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildCli(agentId, model) {
  const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
  const BUILDERS = {
    'claude-code': (prompt) =>
      `claude -p --dangerously-skip-permissions --allowedTools 'Edit,Write,Bash,Read'${modelFlag} -- ${shellQuote(prompt)}`,
    antigravity: (prompt) => `antigravity --prompt ${shellQuote(prompt)}`,
    codex: (prompt) => `codex --prompt ${shellQuote(prompt)}`,
    cursor: null,
    aider: (prompt) => `aider --message ${shellQuote(prompt)} --yes`,
  };
  return BUILDERS[agentId] || null;
}

function discoverTasks(corpusDir) {
  const tasks = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.json')) {
        try {
          tasks.push(JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')));
        } catch { /* skip invalid */ }
      }
    }
  }
  walk(corpusDir);
  return tasks;
}

const ROOT = path.resolve(__dirname, '..');

function installHooksForBench(taskDir, agentId) {
  if (agentId === 'claude-code') {
    const dir = path.join(taskDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const s = (name) => `node "${path.join(ROOT, 'src/capture/claude-code', name)}"`;
    const settings = {
      hooks: {
        UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: s('user-prompt-submit.js') }] }],
        PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: s('pre-tool-use.js') }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: s('post-tool-use.js') }] }],
        PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: s('post-tool-use.js') }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: s('stop.js') }] }],
      },
    };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  }
}

function scaffoldTask(task, agentId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orunmila-bench-${task.id}-`));
  for (const [relPath, content] of Object.entries(task.setup.files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  try {
    execSync('git init && git add -A && git commit -m "bench scaffold" --allow-empty', {
      cwd: dir, stdio: 'ignore',
    });
  } catch { /* git not available — continue anyway */ }

  installHooksForBench(dir, agentId);
  return dir;
}

function readBenchReports(orunmilaHome) {
  const reportsDir = path.join(orunmilaHome, 'reports');
  const results = [];
  if (!fs.existsSync(reportsDir)) return results;
  for (const sessionDir of fs.readdirSync(reportsDir)) {
    const sd = path.join(reportsDir, sessionDir);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const file of fs.readdirSync(sd)) {
      if (!file.endsWith('.json')) continue;
      try {
        results.push(JSON.parse(fs.readFileSync(path.join(sd, file), 'utf8')));
      } catch { /* skip corrupt */ }
    }
  }
  return results;
}

function extractOrunmilaMetrics(reports) {
  const m = {
    verified: 0, phantom: 0, phantom_verification: 0, partial: 0,
    silently_dropped: 0, undisclosed: 0, untracked_writes: 0,
    unverifiable: 0, total_claims: 0,
  };
  for (const r of reports) {
    if (!r.summary) continue;
    const s = r.summary;
    m.verified += s.verified || 0;
    m.phantom += s.phantom || 0;
    m.phantom_verification += s.phantom_verification || 0;
    m.partial += s.partial || 0;
    m.silently_dropped += s.silently_dropped || 0;
    m.undisclosed += (s.undisclosed_changes || 0);
    m.untracked_writes += (s.untracked_writes || 0);
    m.unverifiable += s.unverifiable || 0;
  }
  m.total_claims = m.verified + m.phantom + m.phantom_verification + m.partial + m.unverifiable;
  const scored = m.verified + m.phantom + m.phantom_verification + m.partial;
  m.reliability = scored > 0
    ? Math.round(((m.verified + m.partial * 0.5) / scored) * 100)
    : null;
  m.phantom_rate = m.total_claims > 0
    ? Math.round(((m.phantom + m.phantom_verification) / m.total_claims) * 100)
    : 0;
  return m;
}

function runTask(task, agentId, agentTag, cliBuilder) {
  const orunmilaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-bench-home-'));
  const dir = scaffoldTask(task, agentId);
  const cmd = cliBuilder(task.prompt, dir);

  console.log(`  [${task.id}] running...`);

  const start = Date.now();
  let status = 0;
  try {
    execSync(cmd, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      env: { ...process.env, HOME: os.homedir(), ORUNMILA_HOME: orunmilaHome },
    });
  } catch (err) {
    status = err.status || 1;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  let testPassed = null;
  if (task.expected.test_should_pass) {
    try {
      execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 15_000 });
      testPassed = true;
    } catch {
      testPassed = false;
    }
  }

  const reports = readBenchReports(orunmilaHome);
  const metrics = extractOrunmilaMetrics(reports);

  const testLabel = testPassed === null ? 'n/a' : testPassed ? 'PASS' : 'FAIL';
  console.log(`  [${task.id}] ${elapsed}s | test: ${testLabel} | ` +
    `claims: ${metrics.total_claims} | verified: ${metrics.verified} | ` +
    `phantoms: ${metrics.phantom} | phantom_verify: ${metrics.phantom_verification} | ` +
    `dropped: ${metrics.silently_dropped} | wild_writes: ${metrics.untracked_writes}`);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(orunmilaHome, { recursive: true, force: true }); } catch { /* best effort */ }

  return {
    taskId: task.id, category: task.category, elapsed: parseFloat(elapsed),
    agentExit: status, testPassed, metrics,
  };
}

function main() {
  const agentId = flag('agent', 'claude-code');
  const model = flag('model', null);
  const corpusDir = path.resolve(flag('corpus', path.join(__dirname, '..', 'corpus')));
  const taskFilter = flag('task', null);
  const agentTag = model ? `${agentId}:${model}` : agentId;

  const cliBuilder = buildCli(agentId, model);
  if (!cliBuilder) {
    console.error(`Agent "${agentId}" has no headless CLI support yet.`);
    console.error('Supported: ' + ['claude-code', 'antigravity', 'codex', 'aider'].join(', '));
    console.error(`\nFor ${agentId}, run tasks manually with orunmila hooks installed, then compare with: orunmila stats`);
    process.exit(1);
  }

  let tasks = discoverTasks(corpusDir);
  if (taskFilter) tasks = tasks.filter((t) => t.id === taskFilter);

  if (!tasks.length) {
    console.error(`No tasks found in ${corpusDir}${taskFilter ? ` matching --task ${taskFilter}` : ''}`);
    process.exit(1);
  }

  console.log(`\n=== orunmila benchmark: ${agentTag} ===`);
  console.log(`Corpus: ${corpusDir} (${tasks.length} task${tasks.length === 1 ? '' : 's'})\n`);

  const results = [];
  for (const task of tasks) {
    results.push(runTask(task, agentId, agentTag, cliBuilder));
  }

  // --- Summary table ---
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  ORUNMILA BENCHMARK REPORT: ${agentTag}`);
  console.log(`${'═'.repeat(120)}\n`);

  const H = (s, w) => s.padEnd(w);
  const hdr = `${H('Task', 26)} ${H('Cat', 10)} ${H('Time', 7)} ${H('Test', 6)} ` +
    `${H('Claims', 7)} ${H('Verif', 7)} ${H('Phantm', 7)} ${H('PhVrfy', 7)} ` +
    `${H('Dropd', 7)} ${H('Wild', 7)} ${H('Reliab', 7)}`;
  console.log(hdr);
  console.log('─'.repeat(120));

  let totals = {
    verified: 0, phantom: 0, phantom_verification: 0, partial: 0,
    silently_dropped: 0, untracked_writes: 0, total_claims: 0,
    passed: 0, failed: 0,
  };

  for (const r of results) {
    const m = r.metrics;
    const rel = m.reliability !== null ? `${m.reliability}%` : '—';
    const test = r.testPassed === null ? 'n/a' : r.testPassed ? '✓' : '✗';
    console.log(
      `${H(r.taskId, 26)} ${H(r.category, 10)} ${H(r.elapsed + 's', 7)} ${H(test, 6)} ` +
      `${H(String(m.total_claims), 7)} ${H(String(m.verified), 7)} ${H(String(m.phantom), 7)} ${H(String(m.phantom_verification), 7)} ` +
      `${H(String(m.silently_dropped), 7)} ${H(String(m.untracked_writes), 7)} ${H(rel, 7)}`
    );
    totals.verified += m.verified;
    totals.phantom += m.phantom;
    totals.phantom_verification += m.phantom_verification;
    totals.partial += m.partial;
    totals.silently_dropped += m.silently_dropped;
    totals.untracked_writes += m.untracked_writes;
    totals.total_claims += m.total_claims;
    if (r.testPassed === true) totals.passed++;
    if (r.testPassed === false) totals.failed++;
  }

  console.log('─'.repeat(120));

  const scored = totals.verified + totals.phantom + totals.phantom_verification + totals.partial;
  const overallReliability = scored > 0
    ? Math.round(((totals.verified + totals.partial * 0.5) / scored) * 100)
    : null;
  const overallPhantomRate = totals.total_claims > 0
    ? Math.round(((totals.phantom + totals.phantom_verification) / totals.total_claims) * 100)
    : 0;

  console.log(`\n  Agent:             ${agentTag}`);
  console.log(`  Tasks:             ${results.length} (${totals.passed} passed, ${totals.failed} failed)`);
  console.log(`  Total claims:      ${totals.total_claims}`);
  console.log(`  Verified:          ${totals.verified}`);
  console.log(`  Partial:           ${totals.partial}`);
  console.log(`  Phantoms:          ${totals.phantom}  (claimed but never executed)`);
  console.log(`  Phantom verified:  ${totals.phantom_verification}  (claimed "tested/works" with no evidence)`);
  console.log(`  Silently dropped:  ${totals.silently_dropped}  (part of the ask ignored without mention)`);
  console.log(`  Wild writes:       ${totals.untracked_writes}  (files changed without any claim)`);
  console.log(`  Reliability:       ${overallReliability !== null ? overallReliability + '%' : '— (no scorable claims)'}`);
  console.log(`  Phantom rate:      ${overallPhantomRate}%`);
  console.log('');
}

main();
