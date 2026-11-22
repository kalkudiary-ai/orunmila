'use strict';

/**
 * scripts/turbo/session.js — how TURBO starts one headless Claude Code
 * session and reads what it did (LD109, LD110).
 *
 * A session is `claude -p` with the prompt on stdin (`--mcp-config` takes a
 * list, so a trailing prompt argument would be swallowed), a pinned
 * `--session-id` (so Orunmila's records, leopard-check and the witness join can
 * be pinned to it), `--permission-mode dontAsk` with a closed allowlist, the
 * guard as a PreToolUse hook, no MCP servers, and `--json-schema` so its last
 * word is a structured result, not prose to search.
 *
 * The project's own settings still load, so the Orunmila hooks record every
 * TURBO session like any other.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(__dirname, 'guard.js');
const GITHOOKS = path.join(__dirname, 'githooks');
const TEMPLATE = path.join(__dirname, 'prompt.md');

const OUTCOMES = ['done', 'blocked', 'planned', 'nothing', 'recovered', 'failed'];

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'slice', 'commits', 'queued', 'decisions', 'summary'],
  properties: {
    outcome: { type: 'string', enum: OUTCOMES },
    slice: { type: ['string', 'null'] },
    commits: { type: 'array', items: { type: 'string' } },
    queued: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

// The closed allowlist (O's choice: allowlist + deny list). A command not on it
// is refused by dontAsk, and the guard checks what is on it.
const BASH_ALLOW = [
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run accuracy',
  'npm run accuracy:gate',
  'npm run coverage',
  'npm run mutation:gate',
  'npm run format:check',
  'node',
  'python3 -I',
  'orunmila',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git add',
  'git commit',
  'git rev-parse',
  'git cat-file',
  'git ls-files',
  'git ls-tree',
  'git diff-tree',
  'git for-each-ref',
  'git show-ref',
  'git merge-base',
  'git symbolic-ref',
  'git read-tree',
  'git update-index',
  'git write-tree',
  'git commit-tree',
  'git update-ref',
  'git hash-object',
  'git branch',
  'git restore',
  'git reset',
  'git rm',
  'git mv',
  'git worktree',
  'git -C',
  'ls',
  'wc',
  'cat',
  'head',
  'tail',
  'sed -n',
  'diff',
  'cmp',
  'shasum',
  'sort',
  'uniq',
  'date',
  'pwd',
  'echo',
  'printf',
  'ps',
  'cd',
  'export',
  'unset',
  'true',
  'test',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'chmod',
];

const DENY = [
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git pull:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git stash:*)',
  'Bash(git reset --hard:*)',
  'Bash(git rebase:*)',
  'Bash(npm publish:*)',
  'Bash(npm install:*)',
  'Bash(sudo:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'WebFetch',
  'WebSearch',
  'Grep',
  'Glob',
];

function settings({ guard = GUARD } = {}) {
  return {
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['Read', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'TodoWrite', 'ToolSearch', ...BASH_ALLOW.map((c) => `Bash(${c}:*)`)],
      deny: DENY,
    },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${guard}"` }] }],
    },
  };
}

function env({ base = process.env, root = ROOT, home, run, session, scratch = '' }) {
  return {
    ...base,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: GITHOOKS,
    NPM_CONFIG_DRY_RUN: 'true',
    TURBO_ROOT: root,
    TURBO_HOME: home,
    TURBO_RUN: run,
    TURBO_SESSION: session,
    TURBO_SCRATCH: scratch,
  };
}

function argv({ sessionId, settingsFile, model = 'opus', maxBudgetUsd = null, effort = null }) {
  const a = [
    '-p',
    '--session-id',
    sessionId,
    '--permission-mode',
    'dontAsk',
    '--settings',
    settingsFile,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(RESULT_SCHEMA),
    '--model',
    model,
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
  ];
  if (maxBudgetUsd !== null && maxBudgetUsd !== undefined) a.push('--max-budget-usd', String(maxBudgetUsd));
  if (effort) a.push('--effort', effort);
  return a;
}

function render(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) throw new Error(`prompt placeholder {{${k}}} has no value`);
    return String(vars[k]);
  });
}

function promptVars({ run, session, home, assignment, root = ROOT, sessionMinutes = 75, runEnds = '', inboxChanged = false, provisional = null, phaseSessions = [], counts = {} }) {
  return {
    RUN: run,
    SESSION: session,
    HOME: home,
    ROOT: root,
    KIND: assignment.kind,
    ASSIGNMENT: JSON.stringify(assignment, null, 2),
    SESSION_MINUTES: sessionMinutes,
    RUN_ENDS: runEnds,
    INBOX_CHANGED: inboxChanged ? 'yes' : 'no',
    PROVISIONAL: provisional ? `yes, it rests on ${provisional}` : 'no',
    PHASE_SESSIONS: phaseSessions.length ? phaseSessions.join(', ') : '(none)',
    PLAN_COUNTS: JSON.stringify(counts),
  };
}

function prompt(vars, template = fs.readFileSync(TEMPLATE, 'utf8')) {
  return render(template, vars);
}

function checkResult(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'the result is not an object';
  for (const k of RESULT_SCHEMA.required) if (!(k in r)) return `the result has no ${k}`;
  if (!OUTCOMES.includes(r.outcome)) return `unknown outcome ${r.outcome}`;
  for (const k of ['commits', 'queued', 'decisions']) if (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== 'string')) return `${k} is not a list of strings`;
  if (r.slice !== null && typeof r.slice !== 'string') return 'slice is not a string or null';
  if (typeof r.summary !== 'string') return 'summary is not a string';
  return null;
}

/** Read `claude -p --output-format json` stdout: { result, cost } or { error }. */
function parseResult(stdout) {
  let o;
  try {
    o = JSON.parse(String(stdout).trim());
  } catch {
    return { error: 'stdout is not JSON' };
  }
  const cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null;
  if (o.is_error) return { error: `the session ended in error: ${String(o.result || o.subtype || '').slice(0, 300)}`, cost };
  let r = o.structured_output;
  if (r === undefined && typeof o.result === 'string') {
    try {
      r = JSON.parse(o.result);
    } catch {
      return { error: 'no structured output, and the result text is not JSON', cost };
    }
  }
  const bad = checkResult(r);
  return bad ? { error: bad, cost } : { result: r, cost };
}

module.exports = { ROOT, GUARD, GITHOOKS, RESULT_SCHEMA, OUTCOMES, settings, env, argv, render, promptVars, prompt, parseResult };
