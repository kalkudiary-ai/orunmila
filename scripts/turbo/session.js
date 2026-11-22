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

/** The worktree's git dirs and branch: { common, own, branch }, real paths; null when git cannot say (then no git write is allowed). */
function gitDirs(root) {
  try {
    const git = (...a) => require('child_process').execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let branch = null;
    try {
      branch = git('symbolic-ref', '-q', '--short', 'HEAD') || null;
    } catch {}
    return { common: fs.realpathSync(path.resolve(root, git('rev-parse', '--git-common-dir'))), own: git('rev-parse', '--absolute-git-dir'), branch };
  } catch {
    return null;
  }
}

/**
 * The OS sandbox for every Bash command and its children (LD113, LD116): no
 * network at all, and writes only to the TURBO clone (cwd, with its own .git),
 * TURBO_HOME and scratch (--add-dir) and the per-user temp dir. Nothing of the
 * live copy or the worktree is writable: the driver refuses a linked worktree,
 * whose .git would be shared. Every session scratchpad under
 * /private/tmp/claude-<uid>/ is denied.
 */
function sandbox(root, home = null) {
  const g = gitDirs(root);
  const allowWrite = [];
  // Every session scratchpad: the wildcard for ones made later, and each one that exists by its
  // exact path (the wildcard alone did not deny in probe effb4a37).
  const tmp = `/private/tmp/claude-${require('os').userInfo().uid}`;
  let pads = [];
  try {
    pads = fs.readdirSync(tmp).filter((n) => n.startsWith('-')).map((n) => path.join(tmp, n));
  } catch {}
  const denyWrite = [path.join(root, 'scripts', 'turbo'), path.join(root, '.claude'), `${tmp}/-*`, ...pads];
  // In a TURBO clone (LD116) the git dir is its own, inside the cwd; only its hooks and config,
  // which could run code or turn the git hooks off, are denied.
  if (g) denyWrite.push(path.join(g.common, 'hooks'), path.join(g.common, 'config'), path.join(g.common, 'config.lock'));
  // The driver's own records, and what only O writes (LD117): a session that could write them
  // could make the unsandboxed driver write through a symlink, or forge O's answer.
  if (home) denyWrite.push(path.join(home, 'driver'), path.join(home, 'inbox.md'), path.join(home, 'STOP'), path.join(home, 'PAUSE'));
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    excludedCommands: [],
    // No host at all. FSEvents (read-only file events) and local binding are open so the suite runs
    // in a session: without them fs.watch never delivered and the dashboard could not listen (T14).
    network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true, allowMachLookup: ['com.apple.FSEvents'] },
    filesystem: { allowWrite, denyWrite },
  };
}

function settings({ guard = GUARD, root = ROOT, home = null } = {}) {
  return {
    sandbox: sandbox(root, home),
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['Read', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'TodoWrite', 'ToolSearch', 'StructuredOutput', ...BASH_ALLOW.map((c) => `Bash(${c}:*)`)],
      deny: DENY,
    },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${guard}"` }] }],
    },
  };
}

function env({ base = process.env, root = ROOT, home, run, session, scratch = '' }) {
  // No git config reaches a session through the environment, inherited or injected (LD117).
  const clean = Object.fromEntries(Object.entries(base).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)));
  return {
    ...clean,
    NPM_CONFIG_DRY_RUN: 'true',
    TURBO_ROOT: root,
    TURBO_HOME: home,
    TURBO_RUN: run,
    TURBO_SESSION: session,
    TURBO_SCRATCH: scratch,
  };
}

function argv({ sessionId, settingsFile, model = 'opus', maxBudgetUsd = null, effort = null, addDirs = [] }) {
  const a = [
    '-p',
    // Working dirs, so a redirect into TURBO_HOME or scratch is not refused (smoke session 95549334).
    ...addDirs.flatMap((d) => ['--add-dir', d]),
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
    ALLOWED: BASH_ALLOW.map((c) => '`' + c + '`').join(', '),
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

module.exports = { ROOT, GUARD, BASH_ALLOW, RESULT_SCHEMA, OUTCOMES, settings, env, argv, render, promptVars, prompt, parseResult };
