'use strict';

/**
 * scripts/turbo/turbo.js — the TURBO driver (O, 2026-11-22; LD108-LD112).
 *
 * Runs Leopard unattended for a set number of hours: one fresh headless
 * session per slice, the plan's next unheld slice each time, hard stops queued
 * for O and worked around, and every session checked after it ends.
 *
 *   node scripts/turbo/turbo.js init                 make .turbo/ with an inbox for O
 *   node scripts/turbo/turbo.js run [--hours 6] [--session-minutes 75] [--model opus]
 *        [--budget-usd N] [--effort high] [--poll-minutes 5] [--no-final-gates]
 *   node scripts/turbo/turbo.js status               plan counts, open items, the last run
 *
 * Each turn of the loop picks one of:
 *   recover        the last session left the tree dirty or was cut off
 *   strike / closeout / evidence-fix    the plan's next slice no open item holds
 *   stalk          nothing to start: extend the plan from the brief (once per plan
 *                  state, and again whenever O's inbox changes)
 *   wait           nothing to do until O answers: poll the inbox until it changes
 * After each session: confirm each sha it names exists, run leopard-check
 * --gate on it (a commit it cannot show adds an evidence-fix slice at the
 * head of the plan), and compare `git status` with the run's start.
 * Two failed sessions in a row, or three without progress, also mean wait.
 *
 * The run ends at its hours, at a STOP file in TURBO_HOME, or if the worktree's
 * branch changes. A PAUSE file holds it between sessions (for O to jump in).
 * It never ends early just because the work is held: it waits for O.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const plan = require('./plan');
const session = require('./session');

const ROOT = path.resolve(__dirname, '..', '..');
const GATES = [
  ['npm', 'test'],
  ['npm', 'run', 'lint'],
  ['npm', 'run', 'accuracy:gate'],
  ['npm', 'run', 'coverage'],
];

// --- small helpers -------------------------------------------------------------

const sha = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'none';
  }
};

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const branchOf = (root) => git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).trim();

/** HEAD's reflog actions, newest first: the part of each %gs before its first ':' ("commit", "checkout", ...). */
function headActions(root) {
  const r = spawnSync('git', ['-C', root, 'log', '-g', '--format=%gs', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split(':')[0]);
}
const COMMIT_ACTIONS = new Set(['commit', 'commit (initial)']);
const porcelain = (root) => git(root, ['status', '--porcelain=v1']).split('\n').filter(Boolean);

function isCommit(root, s) {
  const r = spawnSync('git', ['-C', root, 'cat-file', '-t', s], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'commit';
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The default referee: `leopard-check --gate` on the session; shown only on exit 0. */
function leopardReferee(sid, { root = ROOT, orunmilaHome = process.env.ORUNMILA_HOME } = {}) {
  const env = { ...process.env };
  if (orunmilaHome) env.ORUNMILA_HOME = orunmilaHome;
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'leopard-check.js'), '--session', sid, '--gate', '--json', '--repo', root], { encoding: 'utf8', env });
  let detail = (r.stderr || '').trim();
  try {
    const j = JSON.parse(r.stdout);
    detail = j.commits.map((c) => `${c.sha.slice(0, 7)} ${c.slice}: red ${c.red.status}, green ${c.green.status}, gates ${c.gates.map((g) => g.status).join('/')}`).join('; ') || 'no Slice commit in the session';
  } catch {}
  return { shown: r.status === 0, exit: r.status, detail };
}

// --- one session ---------------------------------------------------------------

function runSession(o, { sid, text, settingsFile, runDir, env }) {
  const dir = path.join(runDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `${sid}.out.json`);
  const errFile = path.join(dir, `${sid}.err.txt`);
  fs.writeFileSync(path.join(dir, `${sid}.prompt.md`), text);
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    let killer = null;
    const done = (code, signal, spawnError) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({ code, signal, timedOut, spawnError, ms: Date.now() - started, stdout: fs.readFileSync(outFile, 'utf8'), outFile, errFile });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 30000);
      killer.unref();
    }, o.sessionMinutes * 60 * 1000);
    try {
      const addDirs = [o.home, path.join(runDir, 'scratch')];
      child = spawn(o.claudeBin, session.argv({ sessionId: sid, settingsFile, model: o.model, maxBudgetUsd: o.budgetUsd, effort: o.effort, addDirs }), {
        cwd: o.root,
        env,
        stdio: ['pipe', fdOut, fdErr],
      });
    } catch (err) {
      fs.closeSync(fdOut);
      fs.closeSync(fdErr);
      return done(null, null, err.message);
    }
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
    child.on('error', (err) => done(null, null, err.message));
    child.on('close', (code, signal) => done(code, signal, null));
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

// --- choosing the next session --------------------------------------------------

function stalkKey(p) {
  return JSON.stringify([p.slices.map((s) => [s.id, s.status]), p.queue.filter((q) => q.status === 'open').map((q) => q.id)]);
}

function phaseSessions(p, phase) {
  return [...new Set(p.slices.filter((s) => s.phase === phase && s.status === 'done' && s.session).map((s) => s.session))];
}

function choose(p, state, inboxChanged) {
  if (state.recover) return { kind: 'recover', ...state.recover };
  const s = plan.next(p);
  if (s) {
    const kind = s.kind || 'strike';
    return { kind, slice: s, provisional: plan.provisional(p, s), phase_sessions: kind === 'closeout' ? phaseSessions(p, s.phase) : [] };
  }
  const key = stalkKey(p);
  const c = plan.counts(p);
  if (key !== state.lastStalkKey || inboxChanged) {
    state.lastStalkKey = key;
    return { kind: 'stalk', counts: c, open_items: p.queue.filter((q) => q.status === 'open').map((q) => q.id) };
  }
  return { kind: 'wait', reason: c.todo ? 'every todo slice is held by an open item or its dependencies' : 'the plan is done and a stalk session found nothing to add' };
}

function addEvidenceFix(p, sliceId, detail, sid, commits) {
  const baseId = `${sliceId || 'commit'}-evidence`;
  let k = 1;
  while (plan.find(p, `${baseId}-${k}`)) k++;
  const orig = sliceId ? plan.find(p, sliceId) : null;
  return plan.addSlice(
    p,
    {
      id: `${baseId}-${k}`,
      title: `show the evidence for ${sliceId || 'a commit'} (leopard-check could not)`,
      phase: orig ? orig.phase : null,
      kind: 'evidence-fix',
      test: orig ? orig.test : null,
      notes: [`referee: ${detail}`, `commits: ${commits.join(', ')}`, `session: ${sid}`],
    },
    { front: true },
  );
}

// --- the run -------------------------------------------------------------------

function summaryText(r) {
  const out = [
    `# TURBO run ${r.run}`,
    '',
    `Started ${r.started}, ended ${r.ended}. Stop reason: **${r.stopReason}**. Hours asked: ${r.hours}. Branch: ${r.branch}.`,
    '',
    `## Sessions (${r.sessions.length})`,
    '',
    '| # | session | kind | slice | outcome | commits | referee | exit | minutes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  r.sessions.forEach((s, i) => {
    const ref = s.referee ? (s.referee.shown ? 'shown' : `not shown: ${s.referee.detail}`) : '-';
    const exit = s.timedOut ? 'timed out' : s.spawnError ? `spawn: ${s.spawnError}` : String(s.exit);
    out.push(`| ${i + 1} | ${s.session} | ${s.kind} | ${s.slice || '-'} | ${s.outcome || `error: ${s.error}`} | ${s.verified.map((c) => c.slice(0, 7)).join(' ') || '-'} | ${ref} | ${exit} | ${(s.ms / 60000).toFixed(1)} |`);
  });
  const open = r.plan.queue.filter((q) => q.status === 'open');
  out.push('', `## Open items for O (${open.length})`, '');
  if (!open.length) out.push('None.');
  for (const q of open) out.push(`- **${q.id}** (${q.kind}${q.blocking ? ', blocking' : ''}) ${q.title}: ${q.ask}`);
  const decisions = r.sessions.flatMap((s) => s.decisions || []);
  out.push('', `## Decisions logged (${decisions.length})`, '', decisions.length ? decisions.join(', ') : 'None.');
  out.push('', '## Plan', '', '`' + JSON.stringify(plan.counts(r.plan)) + '`');
  if (r.gates) {
    out.push('', '## Final gates (run by the driver, each alone)', '');
    for (const g of r.gates) out.push(`- \`${g.command}\`: exit ${g.exit} (${g.file})`);
  }
  return out.join('\n') + '\n';
}

async function run(opts) {
  const o = {
    root: ROOT,
    home: plan.home(),
    hours: 6,
    sessionMinutes: 75,
    pollMs: 5 * 60 * 1000,
    model: 'opus',
    budgetUsd: null,
    effort: null,
    claudeBin: process.env.TURBO_CLAUDE_BIN || 'claude',
    env: process.env,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    referee: (sid, { root }) => leopardReferee(sid, { root }),
    finalGates: true,
    caffeinate: process.platform === 'darwin',
    maxSessions: Infinity,
    beforeCheck: null,
    ...opts,
  };
  const start = o.now();
  const deadline = start + o.hours * 3600 * 1000;
  const runId = stamp(start);
  fs.mkdirSync(o.home, { recursive: true });

  const lockFile = path.join(o.home, 'driver.lock');
  if (fs.existsSync(lockFile)) {
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {}
    if (held && alive(held.pid)) throw new Error(`another driver is running (pid ${held.pid}, run ${held.run})`);
  }
  const baseline = porcelain(o.root);
  const tracked = baseline.filter((l) => !l.startsWith('??'));
  if (tracked.length) throw new Error(`the tree has uncommitted tracked changes; TURBO starts on a clean tree, and those belong to someone: ${tracked.join(', ')}`);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, run: runId, started: new Date(start).toISOString() }));

  const runDir = path.join(o.home, 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'scratch'), { recursive: true });
  const logFile = path.join(runDir, 'log.jsonl');
  const log = (e) => fs.appendFileSync(logFile, JSON.stringify({ ts: new Date(o.now()).toISOString(), ...e }) + '\n');
  const settingsFile = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(session.settings({ root: o.root }), null, 2) + '\n');
  const inbox = path.join(o.home, 'inbox.md');
  const branch = branchOf(o.root);

  if (o.caffeinate) {
    try {
      spawn('caffeinate', ['-i', '-w', String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  const state = { recover: null, lastStalkKey: null, lastInbox: sha(inbox), waiting: false, fails: 0, noProgress: 0, paused: false };
  const sessions = [];
  let stopReason = null;
  let result;
  log({ type: 'start', run: runId, hours: o.hours, deadline: new Date(deadline).toISOString(), branch, root: o.root, model: o.model });

  try {
    for (;;) {
      if (o.beforeCheck) o.beforeCheck();
      if (o.now() >= deadline) {
        stopReason = 'hours';
        break;
      }
      if (sessions.length >= o.maxSessions) {
        stopReason = 'max-sessions';
        break;
      }
      if (fs.existsSync(path.join(o.home, 'STOP'))) {
        stopReason = 'stop-file';
        break;
      }
      if (branchOf(o.root) !== branch) {
        stopReason = 'branch-changed';
        break;
      }
      if (fs.existsSync(path.join(o.home, 'PAUSE'))) {
        if (!state.paused) log({ type: 'paused' });
        state.paused = true;
        await o.sleep(o.pollMs);
        continue;
      }
      if (state.paused) log({ type: 'unpaused' });
      state.paused = false;
      const inboxSha = sha(inbox);
      const inboxChanged = inboxSha !== state.lastInbox;
      if (state.waiting) {
        if (!inboxChanged) {
          await o.sleep(o.pollMs);
          continue;
        }
        state.waiting = false;
        state.fails = 0;
        state.noProgress = 0;
        log({ type: 'resume', why: 'the inbox changed' });
      }

      const p = plan.load(o.home);
      const a = choose(p, state, inboxChanged);
      if (a.kind === 'wait') {
        // Seen: only a later change resumes it, so the wait always sleeps.
        state.lastInbox = inboxSha;
        state.waiting = true;
        log({ type: 'wait', reason: a.reason });
        continue;
      }

      const sid = crypto.randomUUID();
      const planBefore = sha(path.join(o.home, 'plan.json'));
      const reflogBefore = headActions(o.root).length;
      const vars = session.promptVars({
        run: runId,
        session: sid,
        home: o.home,
        root: o.root,
        assignment: a,
        sessionMinutes: o.sessionMinutes,
        runEnds: new Date(deadline).toISOString(),
        inboxChanged,
        provisional: a.provisional || null,
        phaseSessions: a.phase_sessions || [],
        counts: plan.counts(p),
      });
      const env = session.env({ base: o.env, root: o.root, home: o.home, run: runId, session: sid, scratch: path.join(runDir, 'scratch') });
      log({ type: 'session-start', session: sid, kind: a.kind, slice: a.slice ? a.slice.id : null });
      const res = await runSession(o, { sid, text: session.prompt(vars), settingsFile, runDir, env });
      state.lastInbox = inboxSha;

      const parsed = res.timedOut || res.spawnError ? { error: res.timedOut ? 'timed out' : res.spawnError } : session.parseResult(res.stdout);
      const r = parsed.result || null;
      const named = r ? r.commits : [];
      const verified = named.filter((c) => isCommit(o.root, c));
      const unverified = named.filter((c) => !verified.includes(c));
      const now = porcelain(o.root);
      const dirty = now.filter((l) => !baseline.includes(l));
      // A refused checkout can rewrite the files before it fails on HEAD (T8's cold verify), and a
      // later commit then carries the damage; any HEAD movement that is not a commit is a recovery.
      const actions = headActions(o.root);
      const headMoves = actions.slice(0, Math.max(0, actions.length - reflogBefore)).filter((a) => !COMMIT_ACTIONS.has(a));
      const row = {
        session: sid,
        kind: a.kind,
        slice: a.slice ? a.slice.id : r ? r.slice : null,
        exit: res.code,
        signal: res.signal,
        timedOut: res.timedOut,
        spawnError: res.spawnError,
        ms: res.ms,
        outcome: r ? r.outcome : null,
        error: parsed.error || null,
        verified,
        unverified,
        queued: r ? r.queued : [],
        decisions: r ? r.decisions : [],
        cost: parsed.cost === undefined ? null : parsed.cost,
        dirty,
        headMoves,
        referee: null,
      };

      const after = plan.load(o.home);
      if (verified.length) {
        row.referee = o.referee(sid, { root: o.root });
        if (!row.referee.shown) {
          const fix = addEvidenceFix(after, row.slice, row.referee.detail, sid, verified);
          plan.save(o.home, after);
          log({ type: 'evidence-fix', session: sid, slice: fix.id });
        } else if (r && r.outcome === 'done' && row.slice && plan.find(after, row.slice) && plan.find(after, row.slice).status === 'todo') {
          plan.setStatus(after, row.slice, 'done', { session: sid, commits: verified });
          plan.save(o.home, after);
          log({ type: 'driver-marked-done', session: sid, slice: row.slice });
        }
      }

      const failed = Boolean(res.timedOut || res.spawnError || res.code !== 0 || parsed.error);
      if (res.timedOut || dirty.length || headMoves.length) {
        const reason = res.timedOut
          ? 'the last session was cut off at its time limit'
          : headMoves.length
            ? `the last session moved HEAD by a non-commit action (${headMoves.join(', ')}): check every file of its commits against what the slice meant to change`
            : 'the last session left the tree dirty';
        state.recover = { reason, dirty, head_moves: headMoves, last_session: sid, last_slice: row.slice, last_commits: verified };
      } else state.recover = null;
      const progress = verified.length > 0 || sha(path.join(o.home, 'plan.json')) !== planBefore;
      state.fails = failed ? state.fails + 1 : 0;
      state.noProgress = progress ? 0 : state.noProgress + 1;
      sessions.push(row);
      log({ type: 'session-end', ...row });
      if (state.fails >= 2 || state.noProgress >= 3) {
        state.waiting = true;
        log({ type: 'wait', reason: state.fails >= 2 ? 'two failed sessions in a row' : 'three sessions without progress' });
      }
    }
  } finally {
    const finalPlan = plan.load(o.home);
    let gates = null;
    if (o.finalGates && stopReason) {
      gates = GATES.map((argv) => {
        const file = path.join(runDir, `gate-${argv.slice(1).join('-').replace(/[^a-z0-9-]/gi, '_')}.txt`);
        const fd = fs.openSync(file, 'w');
        const g = spawnSync(argv[0], argv.slice(1), { cwd: o.root, stdio: ['ignore', fd, fd], env: process.env });
        fs.closeSync(fd);
        return { command: argv.join(' '), exit: g.status, file };
      });
    }
    const ended = new Date(o.now()).toISOString();
    result = { run: runId, runDir, started: new Date(start).toISOString(), ended, stopReason: stopReason || 'error', hours: o.hours, branch, sessions, plan: finalPlan, gates };
    fs.writeFileSync(path.join(runDir, 'summary.md'), summaryText(result));
    log({ type: 'end', stopReason: result.stopReason, sessions: sessions.length, gates });
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
  return result;
}

// --- CLI -----------------------------------------------------------------------

const INBOX_HEAD = `# TURBO inbox

Write to O's TURBO sessions here. The next session reads this whole file when it changes.
Answer a queue item (see approvals.md) as "Q3: yes" or in your own words; give any instruction.
To hold the run between sessions, create a file named PAUSE beside this one; to end it, STOP.

`;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--hours') o.hours = Number(val());
    else if (a === '--session-minutes') o.sessionMinutes = Number(val());
    else if (a === '--poll-minutes') o.pollMs = Number(val()) * 60 * 1000;
    else if (a === '--model') o.model = val();
    else if (a === '--budget-usd') o.budgetUsd = Number(val());
    else if (a === '--effort') o.effort = val();
    else if (a === '--no-final-gates') o.finalGates = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const k of ['hours', 'sessionMinutes', 'pollMs', 'budgetUsd']) if (k in o && !(Number.isFinite(o[k]) && o[k] >= 0)) throw new Error(`--${k} must be a number >= 0`);
  return o;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const home = plan.home();
  try {
    if (cmd === 'init') {
      fs.mkdirSync(home, { recursive: true });
      const inbox = path.join(home, 'inbox.md');
      if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, INBOX_HEAD);
      if (!fs.existsSync(path.join(home, 'plan.json'))) plan.save(home, plan.empty());
      process.stdout.write(`TURBO home: ${home}\n`);
      return 0;
    }
    if (cmd === 'status') {
      const p = plan.load(home);
      process.stdout.write(`plan: ${JSON.stringify(plan.counts(p))}\n`);
      for (const q of p.queue.filter((x) => x.status === 'open')) process.stdout.write(`open ${q.id} (${q.kind}) ${q.title}\n`);
      const lock = path.join(home, 'driver.lock');
      process.stdout.write(fs.existsSync(lock) ? `driver: ${fs.readFileSync(lock, 'utf8')}\n` : 'driver: not running\n');
      const runs = fs.existsSync(path.join(home, 'runs')) ? fs.readdirSync(path.join(home, 'runs')).sort() : [];
      if (runs.length) process.stdout.write(`last run: ${path.join(home, 'runs', runs[runs.length - 1])}\n`);
      return 0;
    }
    if (cmd === 'run') {
      const r = await run(parseArgs(rest));
      process.stdout.write(`TURBO run ${r.run} ended: ${r.stopReason}, ${r.sessions.length} session(s). Summary: ${path.join(r.runDir, 'summary.md')}\n`);
      return 0;
    }
    throw new Error(`unknown command: ${cmd || '(none)'}; use init, run or status`);
  } catch (err) {
    process.stderr.write(`turbo: ${err.message}\n`);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

module.exports = { run, choose, leopardReferee, summaryText, parseArgs, main };
