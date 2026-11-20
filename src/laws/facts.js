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

// A heredoc's body, from the line after `<<DELIM` through the closing DELIM line.
// It is the command's input, not more command line: a commit message saying
// "npm test 17/17" is not a test run (NF59). An unclosed heredoc is left as it is.
const HEREDOC_BODY = /((?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n(?:[^\n]*\n)*?[ \t]*\3[ \t]*(?=\n|$)/g;
// Except where a shell or ssh is the command fed the heredoc: it runs the body,
// so there the body is the command (`bash <<EOF`, `ssh host <<EOF`).
const SHELL_FED = /(?:^|[;&|(\n])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:bash|sh|zsh|dash|ksh|ssh)\b[^;&|(\n]*$/;

/**
 * Heredoc bodies dropped, then quoted spans blanked out, so a `|` or `;` inside
 * an argument splits nothing. Bodies go first: a quoted delimiter ('EOF') would
 * otherwise be blanked, and an apostrophe in the body paired with a later one.
 */
function unquoted(command) {
  return command
    .replace(HEREDOC_BODY, (body, opener, quote, delim, at, line) => (SHELL_FED.test(line.slice(0, at)) ? body : opener))
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
}

/** Is this one part of a command line (no separators in it) a test runner? */
function isRunnerStep(part) {
  return RUNNERS.some((re) => re.test(part.trim().replace(ENV_PREFIX, '')));
}

function isTestRun(command) {
  return unquoted(command).split(SEPARATORS).some(isRunnerStep);
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

// A path with `\` read as `/` and `.` and `..` resolved, so a Windows record and
// a POSIX one are compared and shown alike, whichever platform runs the gate.
const slashed = (p) => path.posix.normalize(String(p).replace(/\\/g, '/'));
const DRIVE = /^[A-Za-z]:\//;

/**
 * The part of `p` under `root`, written with `/`, or null when `p` is not
 * inside it. A root with a drive letter is matched without regard to case, as
 * Windows matches it; any other root, with case.
 */
function under(p, root) {
  if (!root) return null;
  const s = slashed(p);
  if (!s.startsWith('/') && !DRIVE.test(s)) return null;
  const r = slashed(root).replace(/\/+$/, '');
  const fold = DRIVE.test(r + '/') ? (x) => x.toLowerCase() : (x) => x;
  return fold(s).startsWith(fold(r) + '/') ? s.slice(r.length + 1) : null;
}

function shown(p, root) {
  const rel = under(p, root);
  return rel === null ? String(p) : rel;
}

function isTestFile(p) {
  const s = p.replace(/\\/g, '/');
  return TEST_DIR.test(s) || TEST_NAME.test(s);
}

function inside(p, root) {
  return under(p, root) !== null;
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

module.exports = { factsLine, isTestRun, isRunnerStep, isTestFile, status, unquoted, RUNNERS };
