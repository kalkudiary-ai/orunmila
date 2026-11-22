'use strict';

/**
 * scripts/leopard-check.js — the Leopard protocol's checker (rules doc,
 * ORUNMILA OVERRIDES, "The checker").
 *
 * Reads Orunmila's own records for one session, never files the agent writes.
 * For each commit this session made in its span whose message carries a
 * `Slice: <id>` trailer, it reports from those records (LC2, LD137: a commit's
 * maker is the session whose recorded `git commit` / `git commit-tree` run
 * ended first at or after it, within ten minutes; another session's Slice
 * commits are listed under `others`, never judged on this session's runs):
 *
 *   red    a failing run of the commit's `Test: <command>`, run alone, before
 *          the slice's first write outside test/ ("n/a" if it wrote only there)
 *   green  a passing run of it, alone, after the slice's last write
 *   gates  each gate run alone after the last write, its latest run passing
 *
 * A slice's window runs from the latest earlier Slice commit that shares a file
 * with it (or the session's first record) to its own commit (LD135: a commit
 * of another session's, on other files, is no boundary). Its writes are the Glove's and the Sentinel's
 * file_write rows for the files the commit changed: both witnesses, because a
 * shell command's write has only a Sentinel row. Runs come from the Glove's
 * command_run rows; a command has no Sentinel side. A sub-agent's runs and
 * writes are not the author's evidence and are left out.
 *
 * "Alone" means the recorded exit is the command's own: one command, with only
 * redirections and leading `cd <this repo> &&` steps; no `;`, `|`, `||`, `&`,
 * subshell, command substitution or heredoc. A leading `cd` anywhere else ran
 * on another tree, so that run does not count.
 *
 *   node scripts/leopard-check.js --session <id> [--log <events.jsonl>]
 *        [--repo <dir>] [--json] [--gate | --pending --test "<command>"]
 *
 * Exit 0 as a reporter. With --gate, exit 1 unless every one of this session's
 * Slice commits is fully shown, and also when there is none (a gate over
 * nothing is not a pass) or when a Slice commit in the span has no recorded
 * maker (it cannot be vouched for).
 * With --pending, it judges the slice before its commit (O, 2026-11-16): the
 * staged files, from the latest earlier Slice commit sharing a staged file (or
 * the session's first record; LD135) to now,
 * against the given Test: command; exit 0 only when fully shown, 1 otherwise,
 * nothing staged included. Run it in its own call before the commit.
 * Exit 2 on a usage error or a session with no records.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GATES = [
  { gate: 'npm test', argv: [['npm', 'test'], ['npm', 'run', 'test']] },
  { gate: 'npm run lint', argv: [['npm', 'run', 'lint']] },
  { gate: 'npm run accuracy:gate', argv: [['npm', 'run', 'accuracy:gate']] },
  { gate: 'npm run coverage', argv: [['npm', 'run', 'coverage']] },
  { gate: 'node scripts/hook-reach.js --check', argv: [['node', 'scripts/hook-reach.js', '--check']] },
];

const LIMITS =
  'Limits: a recorded exit code is the hook payload\'s; a pass is recorded as null, and a failure as 1 whatever the real code (NF22) unless the hook ran with ORUNMILA_EXACT_CAPTURE=1, which records the stated code. ' +
  'A command run in the background is recorded when it is launched, so it reads as passed (NF66). ' +
  'A run\'s working folder is not recorded beyond a leading cd.';

// --- shell words -------------------------------------------------------------

/**
 * Split a command line into steps: [{ op, argv }], where `op` is the operator
 * before the step ('' for the first). Redirections and their targets are
 * dropped. Returns null for anything this reader does not model (subshells,
 * command substitution, heredocs, unbalanced quotes): such a run is never
 * treated as alone.
 */
function steps(command, { untilHeredoc = false } = {}) {
  const out = [];
  let argv = [];
  let word = null;
  let op = '';
  let dropNext = false;
  const endWord = () => {
    if (word === null) return;
    if (dropNext) dropNext = false;
    else argv.push(word);
    word = null;
  };
  const endStep = (nextOp) => {
    endWord();
    if (dropNext) return false; // a redirection with no target
    out.push({ op, argv });
    argv = [];
    op = nextOp;
    return true;
  };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= s.length) return null;
      word = (word || '') + s[++i];
      continue;
    }
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word || '') + s.slice(i + 1, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '$' && s[j + 1] === '(') return null;
        if (s[j] === '`') return null;
        if (s[j] === '\\' && j + 1 < s.length) j++;
        buf += s[j++];
      }
      if (j >= s.length) return null;
      word = (word || '') + buf;
      i = j;
      continue;
    }
    if (ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}') return null;
    if (ch === '$' && s[i + 1] === '(') return null;
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === '\n' || ch === ';') {
      if (!endStep(';')) return null;
      continue;
    }
    if (ch === '|' || ch === '&') {
      // `&>` and `>&` are redirections, handled below; `2>&1` too.
      if (ch === '&' && s[i + 1] === '>') {
        endWord();
        i += s[i + 2] === '>' ? 2 : 1;
        dropNext = true;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        if (!endStep(two)) return null;
        i++;
      } else if (!endStep(ch)) return null;
      continue;
    }
    if (ch === '<' || ch === '>') {
      // An fd number glued to the operator (2>, 1>>) belongs to it, not the word.
      if (word !== null && /^[0-9]+$/.test(word)) word = null;
      else endWord();
      if (ch === '<' && s[i + 1] === '<') {
        // heredoc / herestring: not modelled, except to read the steps before it (LC2)
        if (!untilHeredoc) return null;
        if (argv.length) out.push({ op, argv });
        return out.filter((st, k) => st.argv.length || k === 0);
      }
      if (ch === '<' && s[i + 1] === '(') return null; // process substitution
      if (ch === '>' && s[i + 1] === '(') return null;
      if (s[i + 1] === '>' || s[i + 1] === '|') i++;
      if (s[i + 1] === '&') {
        // >&2, 2>&1, <&0, >&-: a descriptor, no word target
        i++;
        while (i + 1 < s.length && /[0-9-]/.test(s[i + 1])) i++;
        continue;
      }
      dropNext = true;
      continue;
    }
    word = (word || '') + ch;
  }
  endWord();
  if (dropNext) return null;
  if (argv.length || out.length === 0) out.push({ op, argv });
  else if (op) return null; // trailing operator
  return out.filter((st, k) => st.argv.length || k === 0);
}

/**
 * The argv of the command whose exit the record holds, if the run was alone
 * (see the header) in `roots`; else { alone: false, reason }.
 */
function aloneArgv(command, roots) {
  const st = steps(command);
  if (!st || st.length === 0) return { alone: false, reason: 'not modelled' };
  const last = st[st.length - 1];
  for (let k = 0; k < st.length - 1; k++) {
    const a = st[k].argv;
    if (st[k + 1].op !== '&&') return { alone: false, reason: 'not alone' };
    if (a[0] !== 'cd' || a.length !== 2) return { alone: false, reason: 'not alone' };
    const target = a[1].startsWith('~/') ? path.join(os.homedir(), a[1].slice(2)) : a[1];
    if (!path.isAbsolute(target) || !roots.has(path.resolve(target))) return { alone: false, reason: 'another tree' };
  }
  return { alone: true, argv: last.argv };
}

function sameArgv(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// git's own options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * Whether a recorded command made a commit (LC2): one of its steps, read up to
 * any heredoc, is `git commit` or `git commit-tree`, after leading VAR=value
 * words and git's own options. A command this reader does not model (a
 * subshell, a substitution) is not read as a commit run.
 */
function isCommitRun(command) {
  const st = steps(command, { untilHeredoc: true });
  if (!st) return false;
  return st.some(({ argv }) => {
    let k = 0;
    while (k < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k])) k++;
    if (argv[k] !== 'git' && !String(argv[k] || '').endsWith('/git')) return false;
    for (k++; k < argv.length && argv[k].startsWith('-'); k++) if (GIT_VALUE_OPTS.has(argv[k])) k++;
    return argv[k] === 'commit' || argv[k] === 'commit-tree';
  });
}

const COMMIT_RUN_MAX_MS = 10 * 60 * 1000;

/**
 * Which session made a commit (LC2, LD137): the session whose recorded commit
 * run ended first at or after the commit's time (committer time, whole
 * seconds), within ten minutes; null when no recorded run fits. The record is
 * Orunmila's own command rows, from every session in the log.
 */
function commitOwner(c, commitRuns) {
  let best = null;
  for (const r of commitRuns) {
    const d = r.t - c.t;
    if (d >= 0 && d <= COMMIT_RUN_MAX_MS && (!best || d < best.d)) best = { d, session: r.session };
  }
  return best ? best.session : null;
}

// --- records -------------------------------------------------------------------

function readLog(file) {
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

const ms = (ts) => Date.parse(ts);

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Commits with a Slice: trailer whose committer time is inside [fromMs, toMs]. */
function sliceCommits(repo, fromMs, toMs) {
  const list = git(repo, ['log', '--all', '--format=%H %ct'])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ct] = l.split(' ');
      return { sha, t: Number(ct) * 1000 };
    })
    .filter((c) => c.t >= Math.floor(fromMs / 1000) * 1000 && c.t <= toMs);
  const out = [];
  for (const c of list) {
    const slice = git(repo, ['show', '-s', '--format=%(trailers:key=Slice,valueonly)', c.sha]).trim();
    if (!slice) continue;
    const test = git(repo, ['show', '-s', '--format=%(trailers:key=Test,valueonly)', c.sha]).trim();
    const files = git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', c.sha]).split('\n').filter(Boolean);
    out.push({ ...c, slice: slice.split('\n')[0], test: test ? test.split('\n')[0] : null, files });
  }
  return out.sort((a, b) => a.t - b.t);
}

// --- the check ------------------------------------------------------------------

function runVerdict(r) {
  return { ts: r.ts, failed: r.failed === true, exit_code: r.exit_code === undefined ? null : r.exit_code, command: r.command };
}

/**
 * Latest run in `runs` (already in the window) whose argv is one of `want`.
 * status: yes | failed | not alone | not run. For a red check pass red=true:
 * any failing alone run counts, and a window with only passing runs is
 * "no failing run".
 */
function judge(runs, want, roots, { red = false } = {}) {
  let sawNotAlone = null;
  const alone = [];
  for (const r of runs) {
    const a = aloneArgv(r.command, roots);
    if (a.alone) {
      if (want.some((w) => sameArgv(w, a.argv))) alone.push(r);
      continue;
    }
    // Not alone: is the wanted command one of its steps (so it ran, masked)?
    const st = steps(r.command) || [];
    if (a.reason !== 'another tree' && st.some((x) => want.some((w) => sameArgv(w, x.argv)))) sawNotAlone = r;
  }
  if (red) {
    const failing = alone.filter((r) => r.failed === true);
    if (failing.length) return { status: 'yes', run: runVerdict(failing[failing.length - 1]) };
    if (alone.length) return { status: 'no failing run', run: runVerdict(alone[alone.length - 1]) };
    if (sawNotAlone) return { status: 'not alone', run: runVerdict(sawNotAlone) };
    return { status: 'no run' };
  }
  if (alone.length) {
    const last = alone[alone.length - 1];
    if (sawNotAlone && ms(sawNotAlone.ts) > ms(last.ts)) return { status: 'not alone', run: runVerdict(sawNotAlone) };
    return { status: last.failed === true ? 'failed' : 'yes', run: runVerdict(last) };
  }
  if (sawNotAlone) return { status: 'not alone', run: runVerdict(sawNotAlone) };
  return null;
}

function check({ rows, session, repo, pending = null }) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const roots = new Set([path.resolve(repo), top, fs.realpathSync(top)]);
  const rel = (p) => {
    if (!p) return null;
    for (const r of roots) if (p.startsWith(r + path.sep)) return p.slice(r.length + 1);
    return null;
  };

  const own = rows.filter((e) => e.session_id === session);
  const author = own.filter((e) => !e.sub_agent_id);
  const times = own.map((e) => ms(e.ts)).filter((t) => !Number.isNaN(t));
  const span = { from: Math.min(...times), to: Math.max(...times) };
  const runs = author.filter((e) => e.type === 'command_run').sort((a, b) => ms(a.ts) - ms(b.ts));
  const writes = [
    ...author.filter((e) => e.type === 'file_write' && e.source === 'hook'),
    ...rows.filter((e) => e.type === 'file_write' && e.source === 'fs-sentinel'),
  ]
    .map((e) => ({ ts: e.ts, t: ms(e.ts), source: e.source, rel: rel(e.path) }))
    .filter((w) => w.rel !== null && w.t >= span.from)
    .sort((a, b) => a.t - b.t);

  /** One slice's verdict over the window (from, end]: its files' writes, its Test: runs, the gates. */
  const judgeSlice = (c, from, end) => {
    const inWindow = (t) => t > from && t <= end;
    const files = new Set(c.files);
    const mine = writes.filter((w) => files.has(w.rel) && inWindow(w.t));
    const nonTest = mine.filter((w) => !w.rel.startsWith('test/'));
    const first = nonTest[0] || null;
    const last = mine.length ? mine[mine.length - 1] : null;
    const entry = {
      ...(c.sha ? { sha: c.sha, slice: c.slice } : {}),
      test: c.test,
      files: c.files,
      writes: {
        count: mine.length,
        first: first && { ts: first.ts, source: first.source, path: first.rel },
        last: last && { ts: last.ts, source: last.source, path: last.rel },
      },
    };
    const after = last ? last.t : from;
    const runsIn = (lo, hi) => runs.filter((r) => ms(r.ts) > lo && ms(r.ts) <= hi);
    if (!c.test) {
      entry.red = { status: 'no Test: line' };
      entry.green = { status: 'no Test: line' };
    } else {
      const testSteps = steps(c.test);
      const want = testSteps && testSteps.length === 1 ? [testSteps[0].argv] : null;
      if (!want) {
        entry.red = { status: 'Test: line not one command' };
        entry.green = { status: 'Test: line not one command' };
      } else {
        if (!mine.length) entry.red = { status: 'not shown: no write recorded' };
        else if (!first) entry.red = { status: 'n/a' };
        else entry.red = judge(runsIn(from, first.t - 1), want, roots, { red: true });
        entry.green = (mine.length && judge(runsIn(after, end), want, roots)) || { status: mine.length ? 'no run' : 'not shown: no write recorded' };
        if (entry.green.status === 'failed') entry.green.status = 'last run failed';
      }
    }
    entry.gates = GATES.map((g) => ({ gate: g.gate, ...(judge(runsIn(after, end), g.argv, roots) || { status: 'not run' }) }));
    entry.shown =
      (entry.red.status === 'yes' || entry.red.status === 'n/a') && entry.green.status === 'yes' && entry.gates.every((g) => g.status === 'yes');
    return entry;
  };

  /**
   * Where a slice's window starts (LD135): just after the latest earlier Slice
   * commit that shares a file with it, or at the session's first record. A
   * commit touching none of its files, another session's included, is no
   * boundary: it took none of this slice's writes or runs with it.
   */
  const windowStart = (earlier, files) => {
    const sharing = earlier.filter((p) => p.files.some((f) => files.includes(f)));
    return sharing.length ? sharing[sharing.length - 1].t + 999 : span.from;
  };

  const head = { session, records: own.length, span: { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() }, limits: LIMITS };

  if (pending) {
    // The slice not yet committed: its staged files, from the latest earlier
    // Slice commit sharing one of them (or the session's first record; LD135) to now.
    const done = sliceCommits(repo, span.from, Date.now());
    const staged = git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
    if (!staged.length) return { ...head, pending: { test: pending.test, files: [], status: 'nothing staged', shown: false } };
    return { ...head, pending: judgeSlice({ test: pending.test, files: staged }, windowStart(done, staged), Infinity) };
  }

  // Every Slice commit in the span is a possible window boundary (LD135), but only
  // this session's are judged (LC2): another session's slice was not made with
  // this session's runs, and judging it on them could pass it on work it never had.
  const commits = sliceCommits(repo, span.from, span.to);
  const commitRuns = rows
    .filter((e) => e.type === 'command_run' && e.session_id && isCommitRun(e.command))
    .map((e) => ({ t: ms(e.ts), session: e.session_id }))
    .filter((r) => !Number.isNaN(r.t));
  const report = [];
  const others = [];
  commits.forEach((c, k) => {
    const owner = commitOwner(c, commitRuns);
    if (owner !== session) {
      others.push({ sha: c.sha, slice: c.slice, session: owner });
      return;
    }
    const end = c.t + 999; // committer time has whole seconds
    report.push(judgeSlice(c, windowStart(commits.slice(0, k), c.files), end));
  });
  return { ...head, commits: report, others };
}

// --- CLI -----------------------------------------------------------------------

function parseArgs(argv) {
  const o = { json: false, gate: false, pending: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--gate') o.gate = true;
    else if (a === '--pending') o.pending = true;
    else if (a === '--session' || a === '--log' || a === '--repo' || a === '--test') {
      if (i + 1 >= argv.length) return { error: `${a} needs a value` };
      o[a.slice(2)] = argv[++i];
    } else return { error: `unknown argument: ${a}` };
  }
  if (!o.session) return { error: '--session <id> is required' };
  if (o.pending && !o.test) return { error: '--pending needs --test "<command>"' };
  if (o.test && !o.pending) return { error: '--test is only for --pending' };
  return o;
}

function text(r) {
  const out = [`leopard-check: session ${r.session} (${r.records} records, ${r.span.from} .. ${r.span.to})`, r.limits, ''];
  if (!r.commits.length) out.push('No commit with a Slice: line in this session\'s span.');
  const fmt = (v) => (v.run ? `${v.status} (${v.run.ts}, ${v.run.failed ? 'failed' : 'passed'}, exit ${v.run.exit_code})` : v.status);
  for (const c of r.commits) {
    out.push(`${c.sha.slice(0, 7)}  Slice: ${c.slice}  Test: ${c.test === null ? '(none)' : c.test}`);
    const w = c.writes;
    out.push(`  writes: ${w.count} rows over ${c.files.length} committed file(s)` + (w.last ? `; last ${w.last.ts} (${w.last.source}) ${w.last.path}` : ''));
    out.push(`  red before first write outside test/: ${fmt(c.red)}`);
    out.push(`  green after last write: ${fmt(c.green)}`);
    for (const g of c.gates) out.push(`  gate ${g.gate}: ${fmt(g)}`);
    out.push(`  verdict: ${c.shown ? 'shown' : 'not shown'}`);
    out.push('');
  }
  const shown = r.commits.filter((c) => c.shown).length;
  out.push(`${r.commits.length} Slice commit(s), ${shown} fully shown.`);
  if (r.others.length) {
    out.push('', "Other Slice commits in this span, not judged here (another session's, by its recorded commit run):");
    for (const o of r.others) out.push(`  ${o.sha.slice(0, 7)}  Slice: ${o.slice}  ${o.session ? `session ${o.session}` : 'no recorded commit run made it (--gate cannot pass over it)'}`);
  }
  return out.join('\n') + '\n';
}

function pendingText(r) {
  const p = r.pending;
  const fmt = (v) => (v.run ? `${v.status} (${v.run.ts}, ${v.run.failed ? 'failed' : 'passed'}, exit ${v.run.exit_code})` : v.status);
  const out = [`leopard-check --pending: session ${r.session} (${r.records} records)`, r.limits, '', `Test: ${p.test}`];
  if (p.status) out.push(`  ${p.status}`);
  else {
    out.push(`  staged: ${p.files.join(', ')}`);
    out.push(`  writes: ${p.writes.count} rows` + (p.writes.last ? `; last ${p.writes.last.ts} (${p.writes.last.source}) ${p.writes.last.path}` : ''));
    out.push(`  red before first write outside test/: ${fmt(p.red)}`);
    out.push(`  green after last write: ${fmt(p.green)}`);
    for (const g of p.gates) out.push(`  gate ${g.gate}: ${fmt(g)}`);
  }
  out.push(`  verdict: ${p.shown ? 'shown: commit' : 'not shown: do not commit'}`);
  return out.join('\n') + '\n';
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.error) {
    process.stderr.write(`leopard-check: ${o.error}\n`);
    return 2;
  }
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const logFile = o.log || path.join(home, 'events.jsonl');
  const repo = path.resolve(o.repo || process.cwd());
  let log;
  try {
    log = readLog(logFile);
  } catch (err) {
    process.stderr.write(`leopard-check: cannot read ${logFile}: ${err.message}\n`);
    return 2;
  }
  if (!log.rows.some((e) => e.session_id === o.session)) {
    process.stderr.write(`leopard-check: no records for session ${o.session} in ${logFile}\n`);
    return 2;
  }
  const r = check({ rows: log.rows, session: o.session, repo, pending: o.pending ? { test: o.test } : null });
  r.unparsed_lines = log.bad;
  process.stdout.write(o.json ? JSON.stringify(r, null, 2) + '\n' : r.pending ? pendingText(r) : text(r));
  if (r.pending) return r.pending.shown ? 0 : 1;
  if (!o.gate) return 0;
  return r.commits.length && r.commits.every((c) => c.shown) && r.others.every((o) => o.session !== null) ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { steps, aloneArgv, check };
