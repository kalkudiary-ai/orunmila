#!/usr/bin/env node
'use strict';

/**
 * bench.js — the multi-agent benchmark runner.
 *
 * Picks tasks from the corpus, scaffolds each into an isolated temp directory,
 * invokes the chosen agent's CLI, and lets orunmila's installed hooks capture
 * the session. After all tasks complete, `orunmila stats` shows the comparison.
 *
 * Usage:
 *   node bin/bench.js --agent claude-code [--corpus corpus/] [--task <id>]
 *
 * Each agent needs a CLI command that accepts a prompt on a project directory:
 *   claude-code:   claude --print "<prompt>" (in the task dir)
 *   antigravity:   antigravity --prompt "<prompt>"
 *   cursor:        (no headless CLI yet — manual mode)
 *
 * The runner does NOT install hooks — run `orunmila install --agent <id>` in
 * advance (or globally). The hooks fire inside the agent's process and write to
 * the shared event log as usual.
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

const AGENT_CLI = {
  'claude-code': (prompt) => `claude -p --dangerously-skip-permissions --allowedTools 'Edit,Write,Bash,Read' -- ${shellQuote(prompt)}`,
  antigravity: (prompt) => `antigravity --prompt ${shellQuote(prompt)}`,
  codex: (prompt) => `codex --prompt ${shellQuote(prompt)}`,
  // Agents without a headless CLI:
  cursor: null,
  aider: (prompt) => `aider --message ${shellQuote(prompt)} --yes`,
};

function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
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

function scaffoldTask(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orunmila-bench-${task.id}-`));
  for (const [relPath, content] of Object.entries(task.setup.files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // Initialize git so agents that need a repo context work correctly.
  try {
    execSync('git init && git add -A && git commit -m "bench scaffold" --allow-empty', {
      cwd: dir, stdio: 'ignore',
    });
  } catch { /* git not available — continue anyway */ }
  return dir;
}

function runTask(task, agentId, cliBuilder) {
  const dir = scaffoldTask(task);
  const cmd = cliBuilder(task.prompt, dir);

  console.log(`  [${task.id}] scaffolded in ${dir}`);
  console.log(`  [${task.id}] running: ${cmd.slice(0, 120)}...`);

  const start = Date.now();
  let status = 0;
  try {
    execSync(cmd, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: { ...process.env, HOME: os.homedir() },
    });
  } catch (err) {
    status = err.status || 1;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Verify: did the test pass?
  let testPassed = null;
  if (task.expected.test_should_pass) {
    try {
      execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 15_000 });
      testPassed = true;
    } catch {
      testPassed = false;
    }
  }

  console.log(`  [${task.id}] done in ${elapsed}s — agent exit: ${status}, test: ${testPassed === null ? 'n/a' : testPassed ? 'PASS' : 'FAIL'}`);

  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  return { taskId: task.id, category: task.category, elapsed: parseFloat(elapsed), agentExit: status, testPassed };
}

function main() {
  const agentId = flag('agent', 'claude-code');
  const corpusDir = path.resolve(flag('corpus', path.join(__dirname, '..', 'corpus')));
  const taskFilter = flag('task', null);

  const cliBuilder = AGENT_CLI[agentId];
  if (!cliBuilder) {
    console.error(`Agent "${agentId}" has no headless CLI support yet.`);
    console.error(`Supported: ${Object.entries(AGENT_CLI).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
    console.error(`\nFor ${agentId}, run tasks manually with orunmila hooks installed, then compare with: orunmila stats`);
    process.exit(1);
  }

  let tasks = discoverTasks(corpusDir);
  if (taskFilter) tasks = tasks.filter((t) => t.id === taskFilter);

  if (!tasks.length) {
    console.error(`No tasks found in ${corpusDir}${taskFilter ? ` matching --task ${taskFilter}` : ''}`);
    process.exit(1);
  }

  console.log(`\n=== orunmila benchmark: ${agentId} ===`);
  console.log(`Corpus: ${corpusDir} (${tasks.length} task${tasks.length === 1 ? '' : 's'})\n`);

  const results = [];
  for (const task of tasks) {
    results.push(runTask(task, agentId, cliBuilder));
  }

  console.log(`\n--- results ---\n`);
  console.log(`${'Task'.padEnd(30)} ${'Category'.padEnd(12)} ${'Time'.padEnd(8)} ${'Test'.padEnd(6)} Exit`);
  console.log(`${'----'.padEnd(30)} ${'--------'.padEnd(12)} ${'----'.padEnd(8)} ${'----'.padEnd(6)} ----`);
  for (const r of results) {
    console.log(
      `${r.taskId.padEnd(30)} ${r.category.padEnd(12)} ${(r.elapsed + 's').padEnd(8)} ${(r.testPassed === null ? 'n/a' : r.testPassed ? 'PASS' : 'FAIL').padEnd(6)} ${r.agentExit}`
    );
  }

  const passed = results.filter((r) => r.testPassed === true).length;
  const tested = results.filter((r) => r.testPassed !== null).length;
  console.log(`\n${passed}/${tested} tests passed. Run \`orunmila stats\` to see the full reconciled comparison.\n`);
}

main();
