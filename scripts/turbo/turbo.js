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
const watch = require('./watch');

const ROOT = path.resolve(__dirname, '..', '..');
// Loaded when the driver starts, before any session runs: a session can edit the clone's file, so the
// referee must never run it from disk (cold verify 4: an edit to it wrote into the worktree; LD117).
const LEOPARD = require('../leopard-check');

// ON HOLD (LD118): cold verify 5 got a session's code run outside the sandbox through git that runs
// unsandboxed in the clone (the driver's, and Claude Code's own start-up git status, via a planted
// .git/commondir), and past the guard by a symlink race on the Write tool. Only O lifts this, after
// choosing the fix (README, 'On hold'). Changing it is a slice of its own.
const HOLD = Object.freeze({ lifted: false, decision: 'LD118' });

// --- small helpers -------------------------------------------------------------

const sha = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'none';
  }
};

// `env` (from run) pins the git dir (LD129); with none, git inherits this process's env (cloneRepo, clone).
function git(root, args, env) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

/**
 * The env for the driver's own git in a run (LD129): the git dir, common dir and work tree pinned
 * to the clone, so a planted commondir or gitfile is never followed even if the check missed one;
 * no system config; hooks and fsmonitor off by GIT_CONFIG_*; every other GIT_* from `base` dropped.
 */
function pinnedGitEnv(root, base = process.env) {
  const clean = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('GIT_')));
  const dir = path.join(root, '.git');
  return {
    ...clean,
    GIT_DIR: dir,
    GIT_COMMON_DIR: dir,
    GIT_WORK_TREE: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

const branchOf = (root, env) => git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], env).trim();

/** HEAD's reflog actions, newest first: the part of each %gs before its first ':' ("commit", "checkout", ...). */
function headActions(root, env) {
  const r = spawnSync('git', ['-C', root, 'log', '-g', '--format=%gs', 'HEAD'], { encoding: 'utf8', env });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split(':')[0]);
}
const COMMIT_ACTIONS = new Set(['commit', 'commit (initial)']);
// No fsmonitor and no submodules: either would run code a session can plant in the clone (LD117).
const porcelain = (root, env) => git(root, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--ignore-submodules=all'], env).split('\n').filter(Boolean);

/** True when root is a linked worktree: its git common dir lies outside it, shared with another checkout. */
function isLinkedWorktree(root) {
  const common = fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()));
  const r = fs.realpathSync(root);
  return !(common === r || common.startsWith(r + path.sep));
}

/**
 * Make TURBO's own clone (LD116): its own .git, on `branch`, the ledger branch local, no remote,
 * the source recorded as turbo.source (the driver's summary names the fetch that brings work
 * back). Copies the hook settings, links CLAUDE.md and the rules doc where the source links them,
 * and links the clone's Claude Code memory folder to `memoryFrom`.
 */
function cloneRepo({ source, dest, branch, ledger = 'output-1', claudeHome = path.join(require('os').homedir(), '.claude'), memoryFrom = null }) {
  if (fs.existsSync(dest)) throw new Error(`${dest} exists; TURBO makes its clone fresh`);
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--branch', branch, source, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
  const g = (a) => execFileSync('git', ['-C', dest, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (spawnSync('git', ['-C', dest, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${ledger}`]).status === 0 && ledger !== branch) g(['branch', ledger, `origin/${ledger}`]);
  g(['remote', 'remove', 'origin']);
  g(['config', 'turbo.source', fs.realpathSync(source)]);
  // A shallow source's shallow file is in its common dir, which a local clone from a linked
  // worktree's path misses; without it git cannot walk the history (the referee died on it).
  const srcCommon = fs.realpathSync(path.resolve(source, execFileSync('git', ['-C', source, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()));
  if (fs.existsSync(path.join(srcCommon, 'shallow')) && !fs.existsSync(path.join(dest, '.git', 'shallow'))) fs.copyFileSync(path.join(srcCommon, 'shallow'), path.join(dest, '.git', 'shallow'));
  const settings = path.join(source, '.claude', 'settings.local.json');
  if (fs.existsSync(settings)) {
    fs.mkdirSync(path.join(dest, '.claude'), { recursive: true });
    fs.copyFileSync(settings, path.join(dest, '.claude', 'settings.local.json'));
  }
  // The source's node_modules (gitignored, so not cloned): lint and coverage need its tools. A write
  // through the link lands in the source, which the sandbox refuses (it checks real paths).
  const nm = path.join(source, 'node_modules');
  fs.mkdirSync(path.join(dest, '.git', 'info'), { recursive: true });
  // The driver writes the clone's .orunmila/ignore each run (T18); it is the clone's, not the repo's.
  fs.appendFileSync(path.join(dest, '.git', 'info', 'exclude'), '\n.orunmila/\n');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dest, 'node_modules'))) {
    fs.symlinkSync(fs.realpathSync(nm), path.join(dest, 'node_modules'));
    // `node_modules/` in .gitignore matches a directory, not a link: exclude it in this clone only.
    fs.appendFileSync(path.join(dest, '.git', 'info', 'exclude'), 'node_modules\n');
  }
  for (const f of ['CLAUDE.md', path.join('docs', 'AGENT_OPERATING_RULES.md')]) {
    let target = null;
    try {
      target = fs.readlinkSync(path.join(source, f));
    } catch {}
    if (target && !fs.existsSync(path.join(dest, f))) {
      fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
      fs.symlinkSync(target, path.join(dest, f));
    }
  }
  if (memoryFrom) {
    const dir = path.join(claudeHome, 'projects', fs.realpathSync(dest).replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'memory'))) fs.symlinkSync(memoryFrom, path.join(dir, 'memory'));
  }
  return { dest, branch };
}

/** True when a Sentinel (`... watch-fs --root <root>`) is running, read from ps by exact argv tokens. */
function sentinelRunningFor(root) {
  const r = spawnSync('ps', ['-axo', 'args'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  const want = fs.realpathSync(root);
  return r.stdout.split('\n').some((l) => {
    const t = l.trim().split(/\s+/);
    const i = t.indexOf('--root');
    return t.includes('watch-fs') && i >= 0 && t[i + 1] === want;
  });
}

function isCommit(root, s, env) {
  const r = spawnSync('git', ['-C', root, 'cat-file', '-t', s], { encoding: 'utf8', env });
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

/**
 * The default referee: leopard-check's check() on the session, in-process (LD117), as its --gate
 * judges it: shown only when every Slice commit is fully shown, and not when there is none.
 * exit: 0 shown, 1 not shown, 2 no records for the session or a log it cannot read.
 */
function leopardReferee(sid, { root = ROOT, orunmilaHome = process.env.ORUNMILA_HOME, gitEnv = null } = {}) {
  const logFile = path.join(orunmilaHome || path.join(require('os').homedir(), '.orunmila'), 'events.jsonl');
  let rows;
  try {
    rows = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch (err) {
    return { shown: false, exit: 2, detail: `cannot read ${logFile}: ${err.message}` };
  }
  if (!rows.some((e) => e.session_id === sid)) return { shown: false, exit: 2, detail: `no records for session ${sid}` };
  let r;
  // leopard-check's git inherits this process's env; check() is synchronous, so the pinned git
  // env (LD129) is set for exactly its call and put back after.
  const saved = {};
  const pin = gitEnv ? Object.keys(gitEnv).filter((k) => k.startsWith('GIT_')) : [];
  const dropped = gitEnv ? Object.keys(process.env).filter((k) => k.startsWith('GIT_') && !pin.includes(k)) : [];
  for (const k of [...pin, ...dropped]) saved[k] = process.env[k];
  try {
    for (const k of dropped) delete process.env[k];
    for (const k of pin) process.env[k] = gitEnv[k];
    r = LEOPARD.check({ rows, session: sid, repo: root });
  } catch (err) {
    return { shown: false, exit: 2, detail: `leopard-check failed: ${err.message.split('\n')[0]}` };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const shown = r.commits.length > 0 && r.commits.every((c) => c.shown);
  const detail = r.commits.map((c) => `${c.sha.slice(0, 7)} ${c.slice}: red ${c.red.status}, green ${c.green.status}, gates ${c.gates.map((g) => g.status).join('/')}`).join('; ') || 'no Slice commit in the session';
  return { shown, exit: shown ? 0 : 1, detail };
}

// --- one session ---------------------------------------------------------------

function runSession(o, { sid, text, settingsFile, runDir, scratchDir, env }) {
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
      const addDirs = [o.home, scratchDir];
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

/**
 * The run's declarations (LD131): each one confirmed, refuted (a finding of its check) or unproven
 * (its check could not run), with the counts behind it. They are the close-out's absolute claims,
 * so each says how far it reaches.
 */
function declarations(r) {
  const S = r.sessions.filter((s) => s.checks);
  const w = r.watch || {};
  const sum = (f) => S.reduce((a, s) => a + (Number(f(s.checks)) || 0), 0);
  const hit = (...kinds) => r.sessions.some((s) => (s.findings || []).some((f) => kinds.includes(f.check)));
  const say = (refuted, why) => (refuted ? '**refuted**' : why ? `**unproven** (${why})` : '**confirmed**');
  const none = S.length ? null : 'no session was checked';
  const j = (k) => sum((c) => (c.join && typeof c.join === 'object' ? c.join[k] : 0));
  return [
    '## Declarations (the driver checked each after every session; LD131)',
    '',
    `- No file outside the clone was written in the run: ${say(hit('outside', 'tripwire', 'join'), none || (!w.outsideSentinel ? 'no Sentinel watched outside the clone' : !w.join ? 'the both-records check was off' : null))}. ` +
      `Within: the Sentinels on ${w.outsideRoots || 0} folder(s) outside the clone (${sum((c) => c.outside && c.outside.rows)} row(s), ${sum((c) => c.outside && c.outside.explained)} explained by another session), ` +
      `a tripwire of ${w.tripwire || 0} entr${w.tripwire === 1 ? 'y' : 'ies'} (${sum((c) => c.tripwire && c.tripwire.changed)} change(s), ${sum((c) => c.tripwire && c.tripwire.explained)} explained), and the both-records check, which sees a write land anywhere.`,
    `- Every write in the run is in both records: ${say(hit('join'), none || (!w.join ? 'no Sentinel on the clone' : null))}. Glove writes ${j('writes')}: ${j('paired')} with a Sentinel row, ${j('unchanged')} that changed nothing.`,
    `- The clone's .git held in every session: ${say(hit('git'), none)}. ${S.length} session(s) checked by reading the files, before any git.`,
    `- No link in the clone points outside it, except the ones it was made with: ${say(hit('links'), none)}. ${sum((c) => c.links && c.links.scanned)} entries scanned.`,
    '',
  ];
}

function summaryText(r) {
  const out = [
    `# TURBO run ${r.run}`,
    '',
    `Started ${r.started}, ended ${r.ended}. Stop reason: **${r.stopReason}**. Hours asked: ${r.hours}. Branch: ${r.branch}.`,
    '',
    ...(r.halted
      ? [
          `## HALTED by an escape check in session ${r.halted.session} (LD127)`,
          '',
          'Run no git in this clone (a planted `.git` would run its code as you), and make a new clone before the next run.',
          '',
          ...r.halted.findings.map((f) => `- **${f.check}**: ${f.detail}`),
          '',
        ]
      : []),
    ...declarations(r),
    `Sentinel: ${r.sentinel || 'off'}.`,
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
  if (r.source) {
    out.push('', '## Bringing the work back (O\'s step)', '', 'The run worked in its own clone. To look at its commits from the source, without moving any branch there:', '');
    out.push('```sh', `git -C ${r.source} fetch ${r.root} ${r.branch}:refs/turbo/${r.branch} output-1:refs/turbo/output-1`, `git -C ${r.source} log --oneline ${r.branch}..refs/turbo/${r.branch}`, '```');
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
    referee: (sid, { root, gitEnv }) => leopardReferee(sid, { root, gitEnv }),
    caffeinate: process.platform === 'darwin',
    maxSessions: Infinity,
    beforeCheck: null,
    sentinel: true,
    sentinelBin: process.env.TURBO_SENTINEL_BIN || 'orunmila',
    sentinelRunning: sentinelRunningFor,
    sentinelReadyMs: 120000,
    outsideRoots: null, // null: the live copy and the source worktree (LD128)
    tripwire: null, // null: watch.tripwirePaths() for this machine (LD128)
    settleMs: 5000, // after a session, before its records are read: the Sentinel's debounce and lag
    join: null, // null: on when the clone has a Sentinel (LD131); with none, "both records" is unproven
    wall: Date.now, // the real clock the witnesses stamp rows with (o.now may be a test's)
    held: !HOLD.lifted,
    ...opts,
  };
  if (o.held) throw new Error('TURBO is on hold (LD118): a session could get code run outside the sandbox (cold verify 5). Read scripts/turbo/README.md, "On hold".');
  // A run that halted on an escape check leaves HALT.json; nothing runs in that clone again (LD127).
  const haltFile = path.join(o.home, 'driver', 'HALT.json');
  let haltSt = null;
  try {
    haltSt = fs.lstatSync(haltFile);
  } catch {}
  if (haltSt) throw new Error(`a previous run halted on an escape check (${haltFile}): read it, run no git in this clone, and make a new clone (LD127)`);
  const start = o.now();
  const deadline = start + o.hours * 3600 * 1000;
  const runId = stamp(start);
  // Before any git: the clone's .git, read by fs (LD129). A linked worktree's .git is a file, so
  // this also refuses one (LD116); with a planted commondir, even `git config` reads its config.
  const g0 = watch.gitSetup(o.root);
  if (g0.findings.length) {
    throw new Error(`${o.root}'s .git is not as a TURBO clone is made, so the driver runs no git there (LD129; for a linked worktree, LD116: run TURBO in its own clone, node scripts/turbo/turbo.js clone): ${g0.findings.map((f) => f.detail).join('; ')}`);
  }
  if (!g0.source) {
    throw new Error(`${o.root} is not a TURBO clone (no turbo.source): make one with node scripts/turbo/turbo.js clone, and run there (LD117)`);
  }
  const source = g0.source;
  const gitEnv = pinnedGitEnv(o.root, o.env);
  const allowedLinks = watch.cloneLinks(source);
  const l0 = watch.linkScan(o.root, allowedLinks);
  if (l0.findings.length) throw new Error(`the clone has links outside it (LD130): ${l0.findings.map((f) => f.detail).join('; ')}`);
  const live = o.env.TURBO_LIVE || path.join(require('os').homedir(), 'tools', 'orunmila');
  const outsideRoots = (o.outsideRoots || [live, source]).filter((r) => fs.existsSync(r));
  const tripEntries = o.tripwire || watch.tripwirePaths({ live });
  const joinOn = o.join === null ? Boolean(o.sentinel) : Boolean(o.join);
  const eventsFile = path.join(o.env.ORUNMILA_HOME || path.join(require('os').homedir(), '.orunmila'), 'events.jsonl');
  const logSize = () => {
    try {
      return fs.statSync(eventsFile).size;
    } catch {
      return 0;
    }
  };
  fs.mkdirSync(o.home, { recursive: true });
  // The driver's records live in .turbo/driver/, denied to sessions (LD117); never through a link.
  const driverHome = path.join(o.home, 'driver');
  const scratchHome = path.join(o.home, 'scratch');
  for (const d of [driverHome, scratchHome]) {
    let st = null;
    try {
      st = fs.lstatSync(d); // lstat: existsSync follows a link, so a dangling one would pass
    } catch {}
    if (st && st.isSymbolicLink()) throw new Error(`${d} is a symlink; TURBO does not write through it`);
  }
  fs.mkdirSync(driverHome, { recursive: true });

  const lockFile = path.join(driverHome, 'driver.lock');
  if (fs.existsSync(lockFile)) {
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {}
    if (held && alive(held.pid)) throw new Error(`another driver is running (pid ${held.pid}, run ${held.run})`);
  }
  const baseline = porcelain(o.root, gitEnv);
  const tracked = baseline.filter((l) => !l.startsWith('??'));
  if (tracked.length) throw new Error(`the tree has uncommitted tracked changes; TURBO starts on a clean tree, and those belong to someone: ${tracked.join(', ')}`);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, run: runId, started: new Date(start).toISOString() }));

  const runDir = path.join(driverHome, runId);
  const scratchDir = path.join(scratchHome, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const logFile = path.join(runDir, 'log.jsonl');
  const log = (e) => fs.appendFileSync(logFile, JSON.stringify({ ts: new Date(o.now()).toISOString(), ...e }) + '\n');
  const settingsFile = path.join(runDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(session.settings({ root: o.root, home: o.home }), null, 2) + '\n');
  const inbox = path.join(o.home, 'inbox.md');
  const branch = branchOf(o.root, gitEnv);

  if (o.caffeinate) {
    try {
      spawn('caffeinate', ['-i', '-w', String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  // Orunmila is Glove AND Sentinel. The clone's Sentinel is always the driver's own, started after
  // the driver writes the clone's ignore file, and ready (its first walk done) before any session
  // (T18, LD125): one already running may ignore .turbo/, so a session's write there would have
  // no disk record, and a write before the walk ends is seeded as a baseline, not recorded.
  const sentinels = [];
  async function startSentinel(root) {
    const errFile = path.join(runDir, `sentinel-${sentinels.length}.err`);
    const fd = fs.openSync(errFile, 'w');
    const rec = { root, child: null, note: null, spawnError: null };
    sentinels.push(rec);
    try {
      rec.child = spawn(o.sentinelBin, ['watch-fs', '--root', root], { stdio: ['ignore', 'ignore', fd], env: o.env });
    } finally {
      fs.closeSync(fd);
    }
    rec.child.on('error', (err) => {
      rec.spawnError = err.message;
    });
    const t0 = Date.now();
    while (Date.now() - t0 < o.sentinelReadyMs && !rec.spawnError && rec.child.exitCode === null) {
      if (fs.readFileSync(errFile, 'utf8').includes('[fs-sentinel] watching ')) {
        rec.note = `started on ${root} (pid ${rec.child.pid}), ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, stopped at the end`;
        return rec;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the Sentinel on ${root} did not finish its first walk within ${o.sentinelReadyMs / 1000} s (${rec.spawnError || `see ${errFile}`}); without it a session's writes have no disk record`);
  }

  const state = { recover: null, lastStalkKey: null, lastInbox: sha(inbox), waiting: false, fails: 0, noProgress: 0, paused: false };
  const sessions = [];
  let stopReason = null;
  let result;
  let halted = null;
  /** An escape check found something: stop at once, before any more git or another session (LD127). */
  const halt = (sid, findings) => {
    halted = { run: runId, session: sid, ts: new Date(o.wall()).toISOString(), findings };
    stopReason = 'escape-check';
    fs.writeFileSync(haltFile, JSON.stringify(halted, null, 2) + '\n');
    log({ type: 'halt', session: sid, findings });
    try {
      const p = plan.load(o.home);
      plan.queueItem(p, {
        kind: 'discrepancy',
        title: `escape check: ${findings.length} finding(s) in session ${sid}`,
        ask: `The run halted (LD127). ${findings.map((f) => `[${f.check}] ${f.detail}.`).join(' ')} Read ${haltFile}. Run no git in this clone: make a new clone before the next run.`,
        blocking: true,
        session: sid,
      });
      plan.save(o.home, p);
    } catch (err) {
      log({ type: 'halt-queue-failed', error: err.message }); // HALT.json and the summary still say it
    }
  };
  log({ type: 'start', run: runId, hours: o.hours, deadline: new Date(deadline).toISOString(), branch, root: o.root, model: o.model });

  try {
    if (o.sentinel) {
      watch.writeSentinelIgnore(o.root);
      await startSentinel(o.root);
      // Outside the clone a Sentinel already watching is used: its rows reach the shared log. With
      // a log of the driver's own (ORUNMILA_HOME set) it would not, so the driver starts its own.
      for (const r of outsideRoots) {
        if (!o.env.ORUNMILA_HOME && o.sentinelRunning(r)) sentinels.push({ root: r, child: null, note: `already watching ${r}`, spawnError: null });
        else await startSentinel(r);
      }
    }
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
      if (branchOf(o.root, gitEnv) !== branch) {
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
      const reflogBefore = headActions(o.root, gitEnv).length;
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
      const env = session.env({ base: o.env, root: o.root, home: o.home, run: runId, session: sid, scratch: scratchDir });
      const tripBefore = watch.fingerprint(tripEntries);
      const logOffset = logSize();
      const wallStart = o.wall();
      log({ type: 'session-start', session: sid, kind: a.kind, slice: a.slice ? a.slice.id : null });
      const res = await runSession(o, { sid, text: session.prompt(vars), settingsFile, runDir, scratchDir, env });
      state.lastInbox = inboxSha;

      // The escape checks run first, before any git of the driver's (LD127-LD130). The .git
      // check is first of all, and by fs: Claude Code's start-up git status of the next session
      // would run what a session planted there.
      const g = watch.gitSetup(o.root);
      const gitFindings = [...g.findings];
      if (!gitFindings.length && g.digest !== g0.digest) gitFindings.push({ check: 'git', detail: `the clone's .git config, hooks or info changed during the session` });
      const links = watch.linkScan(o.root, allowedLinks);
      if (o.settleMs) await new Promise((r) => setTimeout(r, o.settleMs));
      const seen = watch.readLog(eventsFile, logOffset).rows;
      const out = watch.outside({ rows: seen, sid, roots: outsideRoots, clone: [o.root, o.home], t0: wallStart - 1000, t1: o.wall(), before: tripBefore, after: watch.fingerprint(tripEntries) });
      const jr = joinOn ? watch.join({ rows: seen, sid, roots: [...new Set([o.root, o.home])], t0: wallStart - 1000, t1: o.wall() }) : null;
      const checks = { git: { findings: gitFindings.length }, links: { scanned: links.scanned, findings: links.findings.length }, outside: out.outside, tripwire: out.tripwire, join: jr ? jr.join : 'off' };
      const findings = [...gitFindings, ...links.findings, ...out.findings, ...(jr ? jr.findings : [])];
      if (findings.length) {
        const row = { session: sid, kind: a.kind, slice: a.slice ? a.slice.id : null, exit: res.code, signal: res.signal, timedOut: res.timedOut, spawnError: res.spawnError, ms: res.ms, outcome: null, error: 'halted: escape check', verified: [], unverified: [], queued: [], decisions: [], cost: null, dirty: [], headMoves: [], referee: null, checks, findings };
        sessions.push(row);
        log({ type: 'session-end', ...row });
        halt(sid, findings);
        break;
      }

      const parsed = res.timedOut || res.spawnError ? { error: res.timedOut ? 'timed out' : res.spawnError } : session.parseResult(res.stdout);
      const r = parsed.result || null;
      const named = r ? r.commits : [];
      const verified = named.filter((c) => isCommit(o.root, c, gitEnv));
      const unverified = named.filter((c) => !verified.includes(c));
      const now = porcelain(o.root, gitEnv);
      const dirty = now.filter((l) => !baseline.includes(l));
      // A refused checkout can rewrite the files before it fails on HEAD (T8's cold verify), and a
      // later commit then carries the damage; any HEAD movement that is not a commit is a recovery.
      const actions = headActions(o.root, gitEnv);
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
        checks,
        findings,
      };

      const after = plan.load(o.home);
      if (verified.length) {
        row.referee = o.referee(sid, { root: o.root, gitEnv });
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
    // No final gates: they would run the clone's code outside the sandbox (LD117); the referee checks
    // the sessions' own gate runs instead.
    let finalPlan;
    try {
      finalPlan = plan.load(o.home);
    } catch {
      finalPlan = plan.empty();
    }
    const ended = new Date(o.now()).toISOString();
    // No git here: after a halt a planted .git would run its code (LD127); the source was read at the start.
    const sentinelNote = o.sentinel ? sentinels.map((s) => s.note || `failed on ${s.root}: ${s.spawnError || 'not ready'}`).join('; ') : 'off';
    result = { run: runId, runDir, scratchDir, sentinel: sentinelNote, root: o.root, source: source || null, started: new Date(start).toISOString(), ended, stopReason: stopReason || 'error', hours: o.hours, branch, sessions, plan: finalPlan, halted, watch: { outsideRoots: outsideRoots.length, outsideSentinel: Boolean(o.sentinel) && outsideRoots.length > 0, tripwire: tripEntries.length, join: joinOn } };
    fs.writeFileSync(path.join(runDir, 'summary.md'), summaryText(result));
    log({ type: 'end', stopReason: result.stopReason, sessions: sessions.length });
    for (const s of sentinels) if (s.child && s.child.exitCode === null) s.child.kill('SIGINT');
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
    if (cmd === 'clone') {
      let dest = path.join(require('os').homedir(), 'tools', 'orunmila-turbo');
      for (let i = 0; i < rest.length; i++) if (rest[i] === '--dest' && i + 1 < rest.length) dest = path.resolve(rest[++i]);
      const branch = branchOf(ROOT);
      // This project's memory folder: Claude Code keys it by the main checkout's folder.
      const common = fs.realpathSync(path.resolve(ROOT, git(ROOT, ['rev-parse', '--git-common-dir']).trim()));
      const key = path.dirname(common).replace(/[^A-Za-z0-9]/g, '-');
      const memoryFrom = path.join(require('os').homedir(), '.claude', 'projects', key, 'memory');
      cloneRepo({ source: ROOT, dest, branch, memoryFrom: fs.existsSync(memoryFrom) ? memoryFrom : null });
      process.stdout.write(`TURBO clone: ${dest} (branch ${branch}, no remote). Start runs there: cd ${dest} && node scripts/turbo/turbo.js init\n`);
      return 0;
    }
    if (cmd === 'status') {
      const p = plan.load(home);
      process.stdout.write(`plan: ${JSON.stringify(plan.counts(p))}\n`);
      for (const q of p.queue.filter((x) => x.status === 'open')) process.stdout.write(`open ${q.id} (${q.kind}) ${q.title}\n`);
      const lock = path.join(home, 'driver', 'driver.lock');
      process.stdout.write(fs.existsSync(lock) ? `driver: ${fs.readFileSync(lock, 'utf8')}\n` : 'driver: not running\n');
      const runs = fs.existsSync(path.join(home, 'driver')) ? fs.readdirSync(path.join(home, 'driver')).filter((n) => n !== 'driver.lock').sort() : [];
      if (runs.length) process.stdout.write(`last run: ${path.join(home, 'driver', runs[runs.length - 1])}\n`);
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

module.exports = { HOLD, run, choose, leopardReferee, summaryText, parseArgs, main, cloneRepo, isLinkedWorktree, pinnedGitEnv };
