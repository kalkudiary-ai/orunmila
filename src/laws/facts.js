'use strict';

/**
 * facts.js — the facts line: what a turn's records show, read without the
 * agent's prose.
 *
 * The law gate reads words, and an agent can always find words no law lists.
 * The facts line does not read words at all. It says which test commands the
 * turn ran and what the record holds as their exit status, and which files the
 * turn changed, naming the test files among them. "All green on my end" with
 * no test run beside it reads "Test runs this turn: none" whatever the
 * sentence says. Pure: records in, one line out; no disk, no clock.
 *
 * A test run is recognised by its runner's name (RUNNERS below). That list is
 * fixed and will miss a project's own test script under another name; the
 * line then says "none" for a turn that did test. Recognising the project's
 * own command is later work (plan item 10).
 */

const path = require('path');

// A command line's independent parts. A runner anywhere on the line counts, so
// `cd ../other && npm test` is a test run; the line is shown whole, cd and all.
const SEPARATORS = /;|&&|\|\||\||\n/;

// Leading `NAME=value` assignments, as in `CI=1 npm test`.
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

const RUNNERS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /^npm\s+t\b/,
  /^node\s+--test\b/,
  /^node\s+(?:\.\/)?tests?\//,
  /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:jest|vitest|mocha)\b/,
  /^(?:python3?\s+-m\s+)?pytest\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
];

// A file is a test file by its folder or its name.
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec)\//;
const TEST_NAME = /(?:\.(?:test|spec)\.[^/]+|(?:^|\/)test_[^/]+\.py|_test\.(?:py|go))$/;

const MAX_RUNS = 5;
const MAX_COMMAND = 80;

/** Quoted spans blanked out, so a `|` or `;` inside an argument splits nothing. */
function unquoted(command) {
  return command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

function isTestRun(command) {
  return unquoted(command)
    .split(SEPARATORS)
    .some((part) => RUNNERS.some((re) => re.test(part.trim().replace(ENV_PREFIX, ''))));
}

function isPiped(command) {
  return unquoted(command).replace(/\|\|/g, '').includes('|');
}

/**
 * The exit status as the record holds it. A number is the code. A missing code
 * is a failure when capture flagged one; otherwise it is a pass only for Claude
 * Code, whose hooks report a passing command with no code (N7), and unknown for
 * every other agent.
 */
function status(e) {
  if (typeof e.exit_code === 'number') return e.exit_code === 0 ? 'pass' : `fail, exit ${e.exit_code}`;
  if (e.failed === true) return 'fail';
  return e.agent === 'claude-code' ? 'pass' : 'status unknown';
}

function shown(p, root) {
  const s = String(p);
  if (root && path.isAbsolute(s) && s.startsWith(root + path.sep)) return path.relative(root, s);
  return s;
}

function isTestFile(p) {
  const s = p.replace(/\\/g, '/');
  return TEST_DIR.test(s) || TEST_NAME.test(s);
}

function inside(p, root) {
  return path.isAbsolute(p) && p.startsWith(root + path.sep);
}

/** "none", or a count with the test files named. */
function changedFiles(files) {
  if (!files.length) return 'none';
  const tests = files.filter(isTestFile);
  return `${files.length} (test files: ${tests.length ? tests.join(', ') : 'none'})`;
}

/**
 * The facts line for one turn: the Glove's events, as readTurn returns them,
 * and the Sentinel's writes in the turn's window. Each witness's record is
 * shown on its own (brief line 197); a Sentinel write outside `root` belongs
 * to another watched folder and is not counted. `sentinelWrites: null` means
 * the Sentinel's record was not read, and the line says so. `root` also shows
 * paths inside it relative to it.
 */
function factsLine(turnEvents, { root, sentinelWrites = [] } = {}) {
  const runs = [];
  const gloveFiles = [];
  for (const e of turnEvents || []) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'command_run' && typeof e.command === 'string' && isTestRun(e.command)) {
      const command = e.command.length > MAX_COMMAND ? e.command.slice(0, MAX_COMMAND - 1) + '…' : e.command;
      runs.push(`${command} (${status(e)}${isPiped(e.command) ? ', piped' : ''})`);
    } else if (e.type === 'file_write' && e.path) {
      const p = shown(e.path, root);
      if (!gloveFiles.includes(p)) gloveFiles.push(p);
    }
  }
  const diskFiles = [];
  for (const e of sentinelWrites || []) {
    if (!e || e.type !== 'file_write' || typeof e.path !== 'string') continue;
    if (root && !inside(e.path, root)) continue;
    const p = shown(e.path, root);
    if (!diskFiles.includes(p)) diskFiles.push(p);
  }

  let testRuns = runs.length ? runs.slice(0, MAX_RUNS).join('; ') : 'none';
  if (runs.length > MAX_RUNS) testRuns += `; and ${runs.length - MAX_RUNS} more`;

  return (
    `Test runs this turn: ${testRuns}. Sentinel: no record, commands are seen by the Glove only. ` +
    `Files changed this turn, Glove: ${changedFiles(gloveFiles)}; Sentinel: ${sentinelWrites === null ? 'not read' : changedFiles(diskFiles)}.`
  );
}

module.exports = { factsLine, isTestRun, isTestFile, RUNNERS };
