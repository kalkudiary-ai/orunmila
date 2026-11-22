'use strict';

/**
 * test/leopard-check.js — scripts/leopard-check.js, the Leopard protocol's
 * checker (rules doc, overrides block, "The checker").
 *
 * Every case builds a throwaway git repo with commits at fixed times and a
 * synthetic event log (no real session data), then runs the checker on it.
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { execFileSync } = require('child_process');

const T0 = 1700000000; // seconds; every time below is an offset from it
const SID = 'sess-leopard-test';
const iso = (off) => new Date((T0 + off) * 1000).toISOString();

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** A repo with one base commit at T0 - 100 (outside every session window). */
function makeRepo() {
  const repo = fs.realpathSync(tmpDir());
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README'), 'base\n');
  git(repo, ['add', 'README']);
  const d = `@${T0 - 100} +0000`;
  git(repo, ['commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  return repo;
}

/** Write files, commit them at T0 + off with the given message. */
function commit(repo, off, files, message) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), `${f} ${off}\n`);
  }
  git(repo, ['add', ...files]);
  const d = `@${T0 + off} +0000`;
  git(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

const SLICE_MSG = 'feat: a thing\n\nSlice: L9\nTest: node test/a.js\n';

// Event builders: the shapes the Glove (source "hook") and the Sentinel
// (source "fs-sentinel", no session_id) write to events.jsonl.
const cmd = (off, command, failed, extra = {}) => ({
  ts: iso(off),
  type: 'command_run',
  source: 'hook',
  session_id: SID,
  agent: 'claude-code',
  turn_id: 't1',
  call_id: `c${off}`,
  command,
  exit_code: failed ? 1 : null,
  failed,
  stdout_excerpt: '',
  ...extra,
});
const gloveWrite = (repo, off, rel, extra = {}) => ({
  ts: iso(off),
  type: 'file_write',
  source: 'hook',
  session_id: SID,
  agent: 'claude-code',
  turn_id: 't1',
  call_id: `w${off}`,
  path: path.join(repo, rel),
  diff: '',
  failed: false,
  ...extra,
});
const sentinelWrite = (repo, off, rel) => ({
  ts: iso(off),
  type: 'file_write',
  source: 'fs-sentinel',
  session_id: null,
  agent: null,
  turn_id: null,
  path: path.join(repo, rel),
  rel_path: rel,
  change_kind: 'modify',
  diff: '',
  failed: false,
});
const prompt = (off) => ({ ts: iso(off), type: 'user_prompt', session_id: SID, agent: 'claude-code', turn_id: 't1', text: 'go' });

const GATES = ['npm test', 'npm run lint', 'npm run accuracy:gate', 'npm run coverage', 'node scripts/hook-reach.js --check'];
const gateRows = (off) => GATES.map((g, i) => cmd(off + i, `${g} > /tmp/gate-${i}.txt 2>&1`, false));

/** The textbook slice: red at 20, writes at 30 (test) and 40 (src), green at 50, gates 60-64, commit at 70. */
function goodSlice(repo) {
  const rows = [
    prompt(0),
    gloveWrite(repo, 10, 'test/a.js'),
    cmd(20, 'node test/a.js > /tmp/red.txt 2>&1', true),
    gloveWrite(repo, 40, 'src/a.js'),
    sentinelWrite(repo, 41, 'src/a.js'),
    cmd(50, 'node test/a.js > /tmp/green.txt 2>&1', false),
    ...gateRows(60),
    cmd(71, 'git commit -F /tmp/msg', false),
  ];
  const sha = commit(repo, 70, ['test/a.js', 'src/a.js'], SLICE_MSG);
  return { rows, sha };
}

function check(repo, rows, args = []) {
  const log = path.join(repo, '..', `${path.basename(repo)}-events.jsonl`);
  fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const res = run('scripts/leopard-check.js', { args: ['--session', SID, '--log', log, '--repo', repo, '--json', ...args] });
  fs.rmSync(log, { force: true });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { ...res, json };
}

function only(json) {
  assert.ok(json, 'checker printed no JSON');
  assert.strictEqual(json.commits.length, 1, `expected one Slice commit, got ${json.commits.length}`);
  return json.commits[0];
}

function withRepo(fn) {
  return () => {
    const repo = makeRepo();
    try {
      fn(repo);
    } finally {
      rmrf(repo);
    }
  };
}

it(
  'a textbook slice: red before the first non-test write, green after the last write, every gate alone and passing',
  withRepo((repo) => {
    const { rows, sha } = goodSlice(repo);
    const r = check(repo, rows);
    assert.strictEqual(r.status, 0, r.stderr);
    const c = only(r.json);
    assert.strictEqual(c.sha, sha);
    assert.strictEqual(c.slice, 'L9');
    assert.strictEqual(c.test, 'node test/a.js');
    assert.strictEqual(c.red.status, 'yes', JSON.stringify(c.red));
    assert.strictEqual(c.green.status, 'yes', JSON.stringify(c.green));
    for (const g of c.gates) assert.strictEqual(g.status, 'yes', JSON.stringify(g));
    assert.strictEqual(c.shown, true);
    const gated = check(repo, rows, ['--gate']);
    assert.strictEqual(gated.status, 0, gated.stdout);
  }),
);

it(
  'no failing run before the first non-test write: red is "no", and --gate exits 1',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const noRed = rows.filter((e) => e.call_id !== 'c20');
    const c = only(check(repo, noRed).json);
    assert.strictEqual(c.red.status, 'no run');
    assert.strictEqual(c.shown, false);
    assert.strictEqual(check(repo, noRed, ['--gate']).status, 1);
    // A run that passed before the change is not a red run either.
    const passedRed = rows.map((e) => (e.call_id === 'c20' ? { ...e, failed: false, exit_code: null } : e));
    assert.strictEqual(only(check(repo, passedRed).json).red.status, 'no failing run');
  }),
);

it(
  'a red run made after the first non-test write does not count',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const late = rows.map((e) => (e.call_id === 'c20' ? { ...e, ts: iso(45) } : e));
    assert.strictEqual(only(check(repo, late).json).red.status, 'no run');
  }),
);

it(
  'a masked run ("; echo $?") or a piped run is not alone, so it is not evidence',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const masked = rows.map((e) => (e.call_id === 'c50' ? { ...e, command: 'node test/a.js > /tmp/g.txt; echo $?' } : e));
    assert.strictEqual(only(check(repo, masked).json).green.status, 'not alone');
    const piped = rows.map((e) => (e.call_id === 'c60' ? { ...e, command: 'npm test | tail -5' } : e));
    const g = only(check(repo, piped).json).gates.find((x) => x.gate === 'npm test');
    assert.strictEqual(g.status, 'not alone');
  }),
);

it(
  'a leading cd into the repo is alone; a cd anywhere else is another tree and does not count',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const here = rows.map((e) => (e.call_id === 'c61' ? { ...e, command: `cd ${repo} && npm run lint > /tmp/l.txt` } : e));
    assert.strictEqual(only(check(repo, here).json).gates.find((x) => x.gate === 'npm run lint').status, 'yes');
    const there = rows.map((e) => (e.call_id === 'c61' ? { ...e, command: 'cd /tmp/extract && npm run lint > /tmp/l.txt' } : e));
    assert.strictEqual(only(check(repo, there).json).gates.find((x) => x.gate === 'npm run lint').status, 'not run');
  }),
);

it(
  'a gate that failed, or never ran after the last write, is named',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const failed = rows.map((e) => (e.call_id === 'c62' ? { ...e, failed: true, exit_code: 1 } : e));
    assert.strictEqual(only(check(repo, failed).json).gates.find((x) => x.gate === 'npm run accuracy:gate').status, 'failed');
    const early = rows.map((e) => (e.call_id === 'c63' ? { ...e, ts: iso(35) } : e));
    const c = only(check(repo, early).json);
    assert.strictEqual(c.gates.find((x) => x.gate === 'npm run coverage').status, 'not run');
    assert.strictEqual(c.shown, false);
  }),
);

it(
  'a write seen only by the Sentinel after the green run moves the last write, so green is "no run"',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const later = [...rows, sentinelWrite(repo, 55, 'src/a.js')];
    const c = only(check(repo, later).json);
    assert.strictEqual(c.writes.last.source, 'fs-sentinel');
    assert.strictEqual(c.green.status, 'no run');
  }),
);

it(
  'a slice that writes only under test/ has no red check to make: "n/a", and it does not fail the gate on that alone',
  withRepo((repo) => {
    const rows = [prompt(0), gloveWrite(repo, 10, 'test/a.js'), cmd(50, 'node test/a.js', false), ...gateRows(60), cmd(71, 'git commit -F /tmp/msg', false)];
    commit(repo, 70, ['test/a.js'], SLICE_MSG);
    const r = check(repo, rows);
    const c = only(r.json);
    assert.strictEqual(c.red.status, 'n/a');
    assert.strictEqual(c.shown, true);
    assert.strictEqual(check(repo, rows, ['--gate']).status, 0);
  }),
);

it(
  "a sub-agent's runs and writes are not the slice author's evidence",
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const sub = { sub_agent_id: 'a1', sub_agent_type: 'general-purpose' };
    const byVerifier = rows.map((e) => (e.call_id === 'c50' ? { ...e, ...sub } : e));
    assert.strictEqual(only(check(repo, byVerifier).json).green.status, 'no run');
  }),
);

it(
  'a commit with a Slice: line but no Test: line is reported, never passed',
  withRepo((repo) => {
    const rows = [prompt(0), gloveWrite(repo, 40, 'src/a.js'), ...gateRows(60), cmd(71, 'git commit -F /tmp/msg', false)];
    commit(repo, 70, ['src/a.js'], 'feat: x\n\nSlice: L9\n');
    const c = only(check(repo, rows).json);
    assert.strictEqual(c.test, null);
    assert.strictEqual(c.shown, false);
  }),
);

it(
  'commits outside the session span, and commits with no Slice: line, are not listed',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    commit(repo, 9000, ['src/b.js'], SLICE_MSG); // after the session's last record
    commit(repo, 72, ['src/c.js'], 'chore: no trailer\n');
    const r = check(repo, rows);
    assert.strictEqual(r.json.commits.length, 1);
  }),
);

it(
  'two slices: the second slice\'s window starts at the first slice\'s commit',
  withRepo((repo) => {
    const first = goodSlice(repo);
    const second = [
      gloveWrite(repo, 110, 'test/b.js'),
      cmd(120, 'node test/b.js', true),
      gloveWrite(repo, 130, 'src/b.js'),
      cmd(140, 'node test/b.js', false),
      ...gateRows(150),
      cmd(161, 'git commit -F /tmp/msg2', false),
    ];
    commit(repo, 160, ['test/b.js', 'src/b.js'], 'feat: b\n\nSlice: L10\nTest: node test/b.js\n');
    const r = check(repo, [...first.rows, ...second]);
    assert.strictEqual(r.json.commits.length, 2);
    for (const c of r.json.commits) assert.strictEqual(c.shown, true, JSON.stringify(c));
    // The first slice's gates (60-64) are not the second slice's.
    const noGates = [...first.rows, ...second.filter((e) => !(e.call_id >= 'c150' && e.call_id <= 'c154'))];
    const c2 = check(repo, noGates).json.commits.find((c) => c.slice === 'L10');
    assert.ok(c2.gates.every((g) => g.status === 'not run'), JSON.stringify(c2.gates));
  }),
);

it(
  'no Slice commit in the session: the report says so, exit 0; with --gate, exit 1 (a gate over nothing is not a pass)',
  withRepo((repo) => {
    const rows = [prompt(0), cmd(5, 'ls', false)];
    const r = check(repo, rows);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json.commits.length, 0);
    assert.strictEqual(check(repo, rows, ['--gate']).status, 1);
  }),
);

it(
  'an unknown session is an error (exit 2), not an empty pass',
  withRepo((repo) => {
    const rows = [{ ...prompt(0), session_id: 'someone-else' }];
    const r = check(repo, rows);
    assert.strictEqual(r.status, 2);
  }),
);

it(
  'the text report states the limits of the record (NF22, NF66) and the verdict per commit',
  withRepo((repo) => {
    const { rows } = goodSlice(repo);
    const log = path.join(repo, '..', `${path.basename(repo)}-text.jsonl`);
    fs.writeFileSync(log, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const r = run('scripts/leopard-check.js', { args: ['--session', SID, '--log', log, '--repo', repo] });
    fs.rmSync(log, { force: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.ok(lines.some((l) => l.startsWith('Limits:') && l.includes('NF22') && l.includes('NF66')), r.stdout);
    assert.ok(lines.some((l) => l.trim() === 'verdict: shown'), r.stdout);
  }),
);

// --- --pending: the slice before its commit (O, 2026-11-16) --------------------

/** Write and stage files without committing them. */
function stage(repo, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), `${f} staged\n`);
  }
  git(repo, ['add', ...files]);
}

/** The textbook slice's records, with no commit yet (its git commit row dropped). */
const pendingRows = (repo) => goodSliceRows(repo).filter((e) => e.call_id !== 'c71');
function goodSliceRows(repo) {
  return [
    prompt(0),
    gloveWrite(repo, 10, 'test/a.js'),
    cmd(20, 'node test/a.js > /tmp/red.txt 2>&1', true),
    gloveWrite(repo, 40, 'src/a.js'),
    sentinelWrite(repo, 41, 'src/a.js'),
    cmd(50, 'node test/a.js > /tmp/green.txt 2>&1', false),
    ...gateRows(60),
    cmd(71, 'git commit -F /tmp/msg', false),
  ];
}
const PENDING = ['--pending', '--test', 'node test/a.js'];

it(
  '--pending: a staged slice with red, green and every gate is shown, exit 0',
  withRepo((repo) => {
    stage(repo, ['test/a.js', 'src/a.js']);
    const r = check(repo, pendingRows(repo), PENDING);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.json && r.json.pending, r.stdout);
    const p = r.json.pending;
    assert.deepStrictEqual(p.files, ['src/a.js', 'test/a.js']);
    assert.strictEqual(p.red.status, 'yes', JSON.stringify(p.red));
    assert.strictEqual(p.green.status, 'yes', JSON.stringify(p.green));
    assert.strictEqual(p.shown, true);
  }),
);

it(
  '--pending: no failing run before the first non-test write, exit 1',
  withRepo((repo) => {
    stage(repo, ['test/a.js', 'src/a.js']);
    const r = check(repo, pendingRows(repo).filter((e) => e.call_id !== 'c20'), PENDING);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.strictEqual(r.json.pending.red.status, 'no run');
    assert.strictEqual(r.json.pending.shown, false);
  }),
);

it(
  '--pending: nothing staged is not a pass, exit 1',
  withRepo((repo) => {
    const r = check(repo, pendingRows(repo), PENDING);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.strictEqual(r.json.pending.status, 'nothing staged');
  }),
);

it(
  '--pending without --test is a usage error, exit 2',
  withRepo((repo) => {
    stage(repo, ['src/a.js']);
    assert.strictEqual(check(repo, pendingRows(repo), ['--pending']).status, 2);
  }),
);

it(
  "--pending: the window starts at the session's last Slice commit, so the earlier slice's gates do not count",
  withRepo((repo) => {
    const first = goodSlice(repo);
    stage(repo, ['test/b.js', 'src/b.js']);
    const second = [gloveWrite(repo, 110, 'test/b.js'), cmd(120, 'node test/b.js', true), gloveWrite(repo, 130, 'src/b.js'), cmd(140, 'node test/b.js', false)];
    const r = check(repo, [...first.rows, ...second], ['--pending', '--test', 'node test/b.js']);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.ok(r.json.pending.gates.every((g) => g.status === 'not run'), JSON.stringify(r.json.pending.gates));
    const withGates = check(repo, [...first.rows, ...second, ...gateRows(150)], ['--pending', '--test', 'node test/b.js']);
    assert.strictEqual(withGates.status, 0, withGates.stdout);
  }),
);

it(
  "--pending: an earlier slice's red run of the same Test: does not count for a slice that re-touches its files",
  withRepo((repo) => {
    const first = goodSlice(repo); // red at 20, writes 10 and 40, committed at 70
    stage(repo, ['test/a.js', 'src/a.js']);
    const again = [gloveWrite(repo, 110, 'test/a.js'), gloveWrite(repo, 130, 'src/a.js'), cmd(140, 'node test/a.js', false), ...gateRows(150)];
    const r = check(repo, [...first.rows, ...again], PENDING);
    assert.strictEqual(r.json.pending.red.status, 'no run', JSON.stringify(r.json.pending.red));
    assert.strictEqual(r.status, 1, r.stdout);
  }),
);

// --- LD135: another session's Slice commit that shares no file is no boundary ---

/** Slice b's records: test write 110, red 120, src write 130, green 140, gates 150-154. */
const sliceB = (repo) => [prompt(0), gloveWrite(repo, 110, 'test/b.js'), cmd(120, 'node test/b.js', true), gloveWrite(repo, 130, 'src/b.js'), cmd(140, 'node test/b.js', false), ...gateRows(150)];
const PEER_MSG = 'feat: peer\n\nSlice: P1\nTest: node test/z.js\n';

it(
  '--pending (LD135): a Slice commit that shares no file with the staged slice, landing after its writes, does not reset its window',
  withRepo((repo) => {
    commit(repo, 145, ['src/z.js'], PEER_MSG); // another session's slice, after b's writes
    stage(repo, ['test/b.js', 'src/b.js']);
    const r = check(repo, sliceB(repo), ['--pending', '--test', 'node test/b.js']);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.strictEqual(r.json.pending.writes.count, 2, JSON.stringify(r.json.pending.writes));
    assert.strictEqual(r.json.pending.shown, true);
  }),
);

it(
  'report (LD135): a commit sharing no file between a slice\'s writes and its commit is no boundary; one sharing a file still is',
  withRepo((repo) => {
    commit(repo, 135, ['src/z.js'], PEER_MSG);
    commit(repo, 160, ['test/b.js', 'src/b.js'], 'feat: b\n\nSlice: L10\nTest: node test/b.js\n');
    const mine = check(repo, [...sliceB(repo), cmd(161, 'git commit -F /tmp/m', false)]).json.commits.find((c) => c.slice === 'L10');
    assert.strictEqual(mine.shown, true, JSON.stringify(mine));
    // A commit at 135 that touches src/b.js takes the earlier writes and the red run with it.
    const repo2 = makeRepo();
    try {
      commit(repo2, 135, ['src/b.js'], PEER_MSG);
      commit(repo2, 160, ['test/b.js', 'src/b.js'], 'feat: b\n\nSlice: L10\nTest: node test/b.js\n');
      const again = check(repo2, [...sliceB(repo2), cmd(161, 'git commit -F /tmp/m', false)]).json.commits.find((c) => c.slice === 'L10');
      assert.strictEqual(again.shown, false, JSON.stringify(again));
    } finally {
      rmrf(repo2);
    }
  }),
);

runAll('leopard-check');
