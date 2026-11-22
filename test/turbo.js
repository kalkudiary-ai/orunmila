'use strict';

/**
 * test/turbo.js — scripts/turbo/, the TURBO harness: an outer driver that runs
 * Leopard slice by slice in fresh headless sessions, queues what needs O, and
 * works around it (LD108-LD112).
 *
 * No real session data: every case builds its own plan, repo or fake `claude`.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');

const plan = require('../scripts/turbo/plan');

// --- T1: the plan -------------------------------------------------------------

const S = (id, extra = {}) => ({ id, title: `slice ${id}`, phase: '2', test: `node test/${id}.js`, ...extra });

function planOf(...slices) {
  const p = plan.empty();
  for (const s of slices) plan.addSlice(p, s);
  return p;
}

it('plan: next() takes the first todo slice in list order', () => {
  const p = planOf(S('a'), S('b'));
  assert.strictEqual(plan.next(p).id, 'a');
  plan.setStatus(p, 'a', 'done');
  assert.strictEqual(plan.next(p).id, 'b');
  plan.setStatus(p, 'b', 'done');
  assert.strictEqual(plan.next(p), null);
});

it('plan: a slice waits for its depends_on, and a later independent slice goes first', () => {
  const p = planOf(S('a'), S('b', { depends_on: ['a'] }), S('c'));
  plan.queueItem(p, { slice: 'a', kind: 'merge-to-main', title: 'merge', ask: 'may I merge?' });
  // a is blocked by an open item, b depends on a, so c is the work around it.
  assert.strictEqual(plan.next(p).id, 'c');
});

it('plan: a blocking queue item blocks its slice until answered; answering unblocks it', () => {
  const p = planOf(S('a'), S('b'));
  const q = plan.queueItem(p, { slice: 'a', kind: 'push', title: 'push', ask: 'push?' });
  assert.strictEqual(q, 'Q1');
  assert.strictEqual(plan.next(p).id, 'b');
  plan.setStatus(p, 'b', 'done');
  assert.strictEqual(plan.next(p), null, 'only a blocked slice is left');
  assert.deepStrictEqual(plan.counts(p), { todo: 1, eligible: 0, blocked: 1, done: 1, dropped: 0, open_items: 1 });
  plan.answer(p, 'Q1', 'yes, push');
  assert.strictEqual(plan.next(p).id, 'a');
  assert.strictEqual(p.queue[0].status, 'answered');
  assert.strictEqual(p.queue[0].answer, 'yes, push');
});

it('plan: a non-blocking item (a phase report) blocks nothing, but marks later phases provisional', () => {
  const p = planOf(S('close2', { phase: '2', kind: 'closeout' }), S('x', { phase: '3' }), S('y', { phase: '2' }));
  plan.setStatus(p, 'close2', 'done');
  const q = plan.queueItem(p, { slice: 'close2', kind: 'phase-report', title: 'Phase 2 report', ask: 'go ahead?', blocking: false, phase: '2' });
  assert.strictEqual(plan.next(p).id, 'x');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'x')), q, 'phase 3 work rests on the unanswered phase 2 report');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'y')), null, 'same-phase work is not provisional');
  plan.answer(p, q, 'go');
  assert.strictEqual(plan.provisional(p, plan.find(p, 'x')), null);
});

it('plan: validate() names duplicate ids, unknown dependencies, unknown items and bad statuses', () => {
  const p = plan.empty();
  p.slices.push({ id: 'a', status: 'todo', depends_on: ['nope'], blocked_by: ['Q9'] }, { id: 'a', status: 'weird', depends_on: [], blocked_by: [] });
  const errs = plan.validate(p);
  assert.ok(errs.some((e) => e.includes('duplicate slice id a')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('unknown dependency nope')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('unknown queue item Q9')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('bad status weird')), errs.join('; '));
  assert.deepStrictEqual(plan.validate(planOf(S('a'), S('b', { depends_on: ['a'] }))), []);
});

it('plan: a dependency cycle is a validation error, not a silent stall', () => {
  const p = planOf(S('a', { depends_on: ['b'] }), S('b', { depends_on: ['a'] }));
  assert.ok(plan.validate(p).some((e) => e.includes('cycle')), plan.validate(p).join('; '));
});

it('plan: addSlice refuses a duplicate id; front:true puts a slice at the head', () => {
  const p = planOf(S('a'));
  assert.throws(() => plan.addSlice(p, S('a')), /duplicate/);
  plan.addSlice(p, S('fix'), { front: true });
  assert.strictEqual(plan.next(p).id, 'fix');
});

it('plan: save() writes plan.json and approvals.md; load() reads it back; an invalid plan is not saved', () => {
  const home = tmpDir();
  try {
    const p = planOf(S('a'));
    plan.queueItem(p, { slice: 'a', kind: 'publish', title: 'npm publish 0.2.3', ask: 'publish?' });
    plan.save(home, p);
    const back = plan.load(home);
    assert.deepStrictEqual(back, p);
    const md = fs.readFileSync(path.join(home, 'approvals.md'), 'utf8');
    assert.ok(md.includes('Q1'), md);
    assert.ok(md.includes('npm publish 0.2.3'), md);
    assert.ok(md.includes('inbox.md'), 'tells O where to answer');
    back.slices.push({ id: 'a', status: 'todo', depends_on: [], blocked_by: [] });
    assert.throws(() => plan.save(home, back), /duplicate/);
    assert.deepStrictEqual(plan.load(home), p, 'the bad plan did not overwrite the good one');
  } finally {
    rmrf(home);
  }
});

it('plan: load() of a missing home gives an empty plan', () => {
  const home = path.join(tmpDir(), 'none');
  assert.deepStrictEqual(plan.load(home), plan.empty());
});

it('plan: the CLI adds, queues, answers and reports next, exit 2 on a usage error', () => {
  const home = tmpDir();
  const { run } = require('./helpers');
  try {
    const env = { TURBO_HOME: home };
    const cli = (...args) => run('scripts/turbo/plan.js', { args, env });
    assert.strictEqual(cli('add', JSON.stringify(S('a'))).status, 0);
    assert.strictEqual(cli('add', JSON.stringify(S('b'))).status, 0);
    const q = cli('queue', JSON.stringify({ slice: 'a', kind: 'push', title: 't', ask: 'push?' }));
    assert.strictEqual(q.status, 0, q.stderr);
    assert.strictEqual(q.stdout.trim(), 'Q1');
    assert.strictEqual(JSON.parse(cli('next').stdout).id, 'b');
    assert.strictEqual(cli('status', 'b', 'done', '--session', 's1', '--commit', 'abc').status, 0);
    assert.strictEqual(cli('next').stdout.trim(), 'null');
    assert.strictEqual(cli('answer', 'Q1', 'go').status, 0);
    assert.strictEqual(JSON.parse(cli('next').stdout).id, 'a');
    const b = plan.find(plan.load(home), 'b');
    assert.deepStrictEqual([b.session, b.commits], ['s1', ['abc']]);
    assert.strictEqual(cli('bogus').status, 2);
    assert.strictEqual(cli('answer', 'Q7', 'x').status, 2, 'an unknown item is a usage error');
  } finally {
    rmrf(home);
  }
});

// --- T2: the guard ------------------------------------------------------------

const guard = require('../scripts/turbo/guard');

/** A throwaway layout: base/dev (the worktree), base/live (the live copy), base/scr (scratch). */
function guardCtx() {
  const base = fs.realpathSync(tmpDir());
  const root = path.join(base, 'dev');
  const live = path.join(base, 'live');
  for (const d of [root, live, path.join(base, 'scr'), path.join(root, 'scripts', 'turbo'), path.join(root, 'src')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(live, 'CLAUDE.md'), 'rules\n');
  fs.symlinkSync(path.join(live, 'CLAUDE.md'), path.join(root, 'CLAUDE.md'));
  return { base, ctx: { root, live, home: path.join(root, '.turbo'), scratch: [path.join(base, 'scr')], self: path.join(root, 'scripts', 'turbo') } };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });

function expectGuard(ctx, payload, kind) {
  const d = guard.decide({ cwd: ctx.root, ...payload }, ctx);
  const what = JSON.stringify(payload.tool_input);
  if (kind === 'allow') assert.ok(d.allow, `${what} refused: ${d.kind} ${d.reason}`);
  else {
    assert.ok(!d.allow, `${what} allowed, wanted ${kind}`);
    assert.strictEqual(d.kind, kind, `${what}: ${d.reason}`);
  }
}

it('guard: the commands a slice needs are allowed', () => {
  const { base, ctx } = guardCtx();
  try {
    for (const c of [
      'npm test > out.txt',
      'npm run lint',
      `cd ${ctx.root} && npm run coverage > c.txt 2>&1`,
      'node scripts/leopard-check.js --session s --pending --test "node test/a.js"',
      'git status --short',
      'git add src/a.js test/a.js',
      'git commit -q -F .turbo/msg.txt',
      'git commit -m "$(cat <<\'EOF\'\nfix: never git push here\nEOF\n)"',
      'git show --stat HEAD',
      'git diff --cached --name-only',
      'git restore --staged src/a.js',
      'git reset -q HEAD src/a.js',
      'export GIT_INDEX_FILE=/tmp/i && git read-tree output-1 && git update-ref refs/heads/output-1 abc def',
      'python3 -I review/witness-join.py --session s --trail trail.json',
      `rm -rf ${path.join(base, 'scr', 'x')}`,
      'rm src/old.js',
      `echo hi > ${path.join(base, 'scr', 'o.txt')}`,
      'ps -axo pid,args',
      'sed -n 1,40p src/a.js',
    ])
      expectGuard(ctx, bash(c), 'allow');
  } finally {
    rmrf(base);
  }
});

it('guard: hard stops are refused, each with its kind', () => {
  const { base, ctx } = guardCtx();
  try {
    const cases = [
      ['git push origin n10-redo', 'push'],
      ['git -C . push', 'push'],
      ['git merge output-1', 'merge'],
      ['git pull', 'merge'],
      ['git switch main', 'branch-switch'],
      ['git checkout -- src/a.js', 'branch-switch'],
      ['git symbolic-ref HEAD refs/heads/main', 'branch-switch'],
      ['git update-ref refs/heads/main abc', 'merge'],
      ['git reset --hard HEAD~1', 'destructive'],
      ['git reset HEAD~1', 'destructive'],
      ['git stash push -m x', 'destructive'],
      ['git clean -fd', 'destructive'],
      ['git branch -D old', 'destructive'],
      ['git commit --amend -m x', 'destructive'],
      ['git restore src/a.js', 'destructive'],
      ['git worktree remove ../x', 'destructive'],
      ['git config core.hooksPath /dev/null', 'hook-settings'],
      ['npm publish', 'publish'],
      ['npm version patch', 'publish'],
      ['npm install left-pad', 'network'],
      ['sudo ls', 'admin'],
      ['curl https://example.com', 'network'],
      ['gh pr merge 9', 'outward'],
      ['rm -rf src', 'destructive'],
      ['pkill -f turbo', 'destructive'],
      ['cat .env', 'secret'],
      ['printenv', 'secret'],
      ['env', 'secret'],
      ['grep -r foo src', 'no-grep'],
      ['git grep foo', 'no-grep'],
      ['rg foo', 'no-grep'],
      [`cat ${path.join(ctx.live, 'CLAUDE.md')}`, 'live-copy'],
      ['echo x > CLAUDE.md', 'live-copy'],
      ['cp a.js ../live/src/a.js', 'live-copy'],
      ['echo x > scripts/turbo/guard.js', 'self-edit'],
      ['echo "unclosed', 'unparsed'],
    ];
    for (const [c, kind] of cases) expectGuard(ctx, bash(c), kind);
  } finally {
    rmrf(base);
  }
});

it('guard: a hard stop hidden in a wrapper, a substitution or a later step is still found', () => {
  const { base, ctx } = guardCtx();
  try {
    for (const c of [
      'bash -c "git push"',
      "sh -c 'cd /x && git push origin main'",
      'eval git push',
      'echo $(git push)',
      'echo `git push`',
      'npm test && git push',
      'npm test; git push',
      'true | git push',
      '(git push)',
      'FOO=1 git push',
      'env FOO=1 git push',
      'nohup git push',
      'timeout 10 git push',
      'xargs -n1 git push < refs.txt',
      'command git push',
      'bash <<EOF\ngit push\nEOF',
    ])
      expectGuard(ctx, bash(c), 'push');
  } finally {
    rmrf(base);
  }
});

it('guard: file tools may write in the worktree, TURBO_HOME and scratch, and nowhere else', () => {
  const { base, ctx } = guardCtx();
  try {
    expectGuard(ctx, write(path.join(ctx.root, 'src', 'a.js')), 'allow');
    expectGuard(ctx, write(path.join(ctx.root, 'src', 'new', 'deep', 'b.js')), 'allow');
    expectGuard(ctx, write(path.join(ctx.home, 'msg.txt')), 'allow');
    expectGuard(ctx, write(path.join(base, 'scr', 'x.md')), 'allow');
    expectGuard(ctx, { tool_name: 'Edit', tool_input: { file_path: path.join(ctx.root, 'CLAUDE.md') } }, 'live-copy');
    expectGuard(ctx, write(path.join(ctx.live, 'src', 'a.js')), 'live-copy');
    expectGuard(ctx, write(path.join(ctx.root, 'scripts', 'turbo', 'guard.js')), 'self-edit');
    expectGuard(ctx, write(path.join(ctx.root, '.claude', 'settings.local.json')), 'hook-settings');
    expectGuard(ctx, write(path.join(ctx.root, '.git', 'config')), 'destructive');
    expectGuard(ctx, write(path.join(base, 'elsewhere.txt')), 'outside-tree');
    expectGuard(ctx, { tool_name: 'MultiEdit', tool_input: { file_path: '/etc/hosts' } }, 'outside-tree');
    expectGuard(ctx, { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(ctx.live, 'n.ipynb') } }, 'live-copy');
  } finally {
    rmrf(base);
  }
});

it('guard: reads are allowed except secrets; grep tools and the network are refused', () => {
  const { base, ctx } = guardCtx();
  try {
    expectGuard(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.live, 'CLAUDE.md') } }, 'allow');
    expectGuard(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.root, '.env') } }, 'secret');
    expectGuard(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.root, '.env.local') } }, 'secret');
    expectGuard(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.root, '.env.example') } }, 'allow');
    expectGuard(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.root, '.npmrc') } }, 'secret');
    expectGuard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x' } }, 'no-grep');
    expectGuard(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.js' } }, 'no-grep');
    expectGuard(ctx, { tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, 'network');
    expectGuard(ctx, { tool_name: 'WebSearch', tool_input: { query: 'x' } }, 'network');
    expectGuard(ctx, { tool_name: 'Agent', tool_input: { prompt: 'x' } }, 'allow');
  } finally {
    rmrf(base);
  }
});

it('guard: the hook refuses with exit 2 and a reason on stderr, allows with exit 0, and fails closed on bad input', () => {
  const { run } = require('./helpers');
  const { base, ctx } = guardCtx();
  try {
    const env = { TURBO_ROOT: ctx.root, TURBO_LIVE: ctx.live, TURBO_HOME: ctx.home, TURBO_SCRATCH: ctx.scratch.join(path.delimiter) };
    const hook = (payload) => run('scripts/turbo/guard.js', { input: typeof payload === 'string' ? payload : JSON.stringify({ cwd: ctx.root, ...payload }), env });
    const no = hook(bash('git push'));
    assert.strictEqual(no.status, 2, no.stderr);
    assert.ok(no.stderr.includes('push'), no.stderr);
    assert.ok(no.stderr.includes('plan.js queue'), 'tells the session how to queue it');
    assert.strictEqual(hook(bash('npm test')).status, 0);
    assert.strictEqual(hook('not json').status, 2);
    assert.strictEqual(hook({ tool_name: 'Bash', tool_input: {} }).status, 2, 'a Bash call with no command fails closed');
  } finally {
    rmrf(base);
  }
});

// --- T3: the git hooks --------------------------------------------------------

const { spawnSync } = require('child_process');
const HOOKS_DIR = path.join(__dirname, '..', 'scripts', 'turbo', 'githooks');
const HOOK_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: HOOKS_DIR };

function gitIn(repo, args, env = {}) {
  return spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function hookRepo() {
  const base = fs.realpathSync(tmpDir());
  const repo = path.join(base, 'r');
  fs.mkdirSync(repo);
  gitIn(repo, ['init', '-q', '-b', 'work']);
  fs.writeFileSync(path.join(repo, 'a'), 'a\n');
  gitIn(repo, ['add', 'a']);
  gitIn(repo, ['commit', '-q', '-m', 'a']);
  spawnSync('git', ['init', '-q', '--bare', path.join(base, 'remote.git')]);
  return { base, repo, remote: path.join(base, 'remote.git') };
}

it('githooks: with TURBO\'s env, any update to main is refused and other refs move', () => {
  const { base, repo } = hookRepo();
  try {
    const main = gitIn(repo, ['update-ref', 'refs/heads/main', 'HEAD'], HOOK_ENV);
    assert.notStrictEqual(main.status, 0, 'update-ref main was allowed');
    assert.ok(main.stderr.includes('TURBO'), main.stderr);
    assert.notStrictEqual(gitIn(repo, ['branch', 'main'], HOOK_ENV).status, 0, 'git branch main was allowed');
    assert.strictEqual(gitIn(repo, ['rev-parse', '--verify', '-q', 'refs/heads/main']).status, 1, 'main exists after the refusals');
    assert.strictEqual(gitIn(repo, ['update-ref', 'refs/heads/output-1', 'HEAD'], HOOK_ENV).status, 0, 'another branch could not move');
    fs.writeFileSync(path.join(repo, 'b'), 'b\n');
    gitIn(repo, ['add', 'b'], HOOK_ENV);
    assert.strictEqual(gitIn(repo, ['commit', '-q', '-m', 'b'], HOOK_ENV).status, 0, 'a commit on the work branch was refused');
    // Control: without the env the same update goes through, so the hook is what refused it.
    assert.strictEqual(gitIn(repo, ['update-ref', 'refs/heads/main', 'HEAD']).status, 0);
  } finally {
    rmrf(base);
  }
});

it('githooks: with TURBO\'s env, every push is refused; without it, the same push goes through', () => {
  const { base, repo, remote } = hookRepo();
  try {
    const push = gitIn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x'], HOOK_ENV);
    assert.notStrictEqual(push.status, 0, 'a push was allowed');
    assert.ok(push.stderr.includes('TURBO'), push.stderr);
    assert.strictEqual(spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', 'refs/heads/x']).status, 1, 'the remote got the ref');
    assert.strictEqual(gitIn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x']).status, 0);
  } finally {
    rmrf(base);
  }
});

// --- T4: one session ----------------------------------------------------------

const session = require('../scripts/turbo/session');

it('session: settings deny by default, allow a closed list, and put the guard before every tool', () => {
  const st = session.settings({ root: '/r' });
  assert.strictEqual(st.permissions.defaultMode, 'dontAsk');
  assert.ok(!st.permissions.allow.includes('Bash'), 'bare Bash would allow every command');
  for (const t of ['Read', 'Edit', 'Write', 'Agent', 'Bash(npm test:*)', 'Bash(node:*)', 'Bash(git commit:*)']) assert.ok(st.permissions.allow.includes(t), t);
  for (const t of ['Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(git checkout:*)', 'WebFetch', 'Grep', 'Glob']) assert.ok(st.permissions.deny.includes(t), t);
  const pre = st.hooks.PreToolUse;
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].matcher, '*');
  assert.ok(pre[0].hooks[0].command.includes(path.join('scripts', 'turbo', 'guard.js')), pre[0].hooks[0].command);
});

it('session: the env turns on the git hooks and npm dry-run, names the run, and leaves the base env alone', () => {
  const baseEnv = { PATH: '/bin', GIT_CONFIG_COUNT: '3' };
  const e = session.env({ base: baseEnv, root: '/r', home: '/h', run: 'R1', session: 'S1', scratch: '/s' });
  assert.deepStrictEqual([e.GIT_CONFIG_COUNT, e.GIT_CONFIG_KEY_0, e.GIT_CONFIG_VALUE_0], ['1', 'core.hooksPath', path.join(session.ROOT, 'scripts', 'turbo', 'githooks')]);
  assert.ok(fs.existsSync(path.join(e.GIT_CONFIG_VALUE_0, 'pre-push')));
  assert.strictEqual(e.NPM_CONFIG_DRY_RUN, 'true');
  assert.deepStrictEqual([e.TURBO_HOME, e.TURBO_RUN, e.TURBO_SESSION, e.TURBO_ROOT, e.TURBO_SCRATCH], ['/h', 'R1', 'S1', '/r', '/s']);
  assert.strictEqual(e.PATH, '/bin');
  assert.strictEqual(baseEnv.GIT_CONFIG_COUNT, '3', 'the base env was changed');
});

it('session: argv runs print mode, pinned session id, dontAsk, no MCP servers, JSON with the result schema', () => {
  const a = session.argv({ sessionId: 'S1', settingsFile: '/h/settings.json', model: 'opus' });
  const val = (f) => a[a.indexOf(f) + 1];
  assert.ok(a.includes('-p'));
  assert.strictEqual(val('--session-id'), 'S1');
  assert.strictEqual(val('--permission-mode'), 'dontAsk');
  assert.strictEqual(val('--settings'), '/h/settings.json');
  assert.strictEqual(val('--output-format'), 'json');
  assert.strictEqual(val('--model'), 'opus');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.deepStrictEqual(JSON.parse(val('--mcp-config')), { mcpServers: {} });
  assert.deepStrictEqual(JSON.parse(val('--json-schema')), session.RESULT_SCHEMA);
  assert.ok(!a.includes('--max-budget-usd'));
  const b = session.argv({ sessionId: 'S1', settingsFile: '/s', model: 'opus', maxBudgetUsd: 5, effort: 'high' });
  assert.strictEqual(b[b.indexOf('--max-budget-usd') + 1], '5');
  assert.strictEqual(b[b.indexOf('--effort') + 1], 'high');
});

it('session: render() fills every placeholder and refuses a missing one', () => {
  assert.strictEqual(session.render('a {{X}} b {{Y}}', { X: 1, Y: 'two' }), 'a 1 b two');
  assert.throws(() => session.render('a {{X}} {{Z}}', { X: 1 }), /Z/);
});

it('session: the prompt template renders with no placeholder left', () => {
  const text = session.prompt(session.promptVars({ run: 'R1', session: 'S1', home: '/h', assignment: { kind: 'strike', slice: { id: 'a' } } }));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'a placeholder is left');
  assert.ok(text.includes('S1') && text.includes('"id": "a"'), 'the assignment is in the prompt');
});

it('session: parseResult reads structured_output, a JSON result string, and refuses everything else', () => {
  const good = { outcome: 'done', slice: 'a', commits: ['abc'], queued: [], decisions: ['LD200'], summary: 's' };
  assert.deepStrictEqual(session.parseResult(JSON.stringify({ type: 'result', structured_output: good })).result, good);
  assert.deepStrictEqual(session.parseResult(JSON.stringify({ type: 'result', result: JSON.stringify(good) })).result, good);
  assert.ok(session.parseResult('not json').error);
  assert.ok(session.parseResult('').error);
  assert.ok(session.parseResult(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })).error);
  assert.ok(session.parseResult(JSON.stringify({ structured_output: { ...good, outcome: 'great' } })).error, 'an unknown outcome');
  const { commits: _c, ...noCommits } = good;
  assert.ok(session.parseResult(JSON.stringify({ structured_output: noCommits })).error, 'a missing field');
  assert.strictEqual(session.parseResult(JSON.stringify({ structured_output: good, total_cost_usd: 1.5 })).cost, 1.5);
});

// --- T5: the driver -----------------------------------------------------------

const turbo = require('../scripts/turbo/turbo');
const PLAN_JS = path.join(__dirname, '..', 'scripts', 'turbo', 'plan.js');

// A fake `claude`: records its argv, stdin and env, then plays the next step
// from TURBO_FAKE (a JSON list). A step may run plan.js commands, commit a
// file, leave a tracked file dirty, hang, and print a result.
const FAKE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const steps = JSON.parse(fs.readFileSync(process.env.TURBO_FAKE, 'utf8'));
const countFile = process.env.TURBO_FAKE + '.n';
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.TURBO_FAKE + '.call' + n + '.json', JSON.stringify({ argv: process.argv.slice(2), stdin, hooksPath: process.env.GIT_CONFIG_VALUE_0 }));
const step = steps[n] || { result: { outcome: 'nothing', slice: null, commits: [], queued: [], decisions: [], summary: 'no step' } };
const git = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
for (const args of step.plan || []) execFileSync('node', [${JSON.stringify(PLAN_JS)}, ...args], { env: process.env });
const result = step.result ? JSON.parse(JSON.stringify(step.result)) : null;
if (step.commit) {
  fs.writeFileSync(step.commit, String(n));
  git(['add', step.commit]);
  git(['commit', '-q', '-m', 'step ' + n]);
  if (result) result.commits = [git(['rev-parse', 'HEAD'])];
}
if (step.dirty) fs.writeFileSync(step.dirty, 'dirty ' + n);
if (step.hang) setInterval(() => {}, 1000);
else {
  if (result) process.stdout.write(JSON.stringify({ type: 'result', structured_output: result, total_cost_usd: 0.01 }));
  process.exit(step.exit || 0);
}
`;

const R = (outcome, slice, extra = {}) => ({ outcome, slice, commits: [], queued: [], decisions: [], summary: outcome, ...extra });

/** A repo on branch `work` with one commit, a TURBO_HOME outside it, a fake claude and a fake clock. */
function driverSetup(steps, { slices = [], referee = () => ({ shown: true, detail: 'stub' }), hours = 1, ...rest } = {}) {
  const base = fs.realpathSync(tmpDir());
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  gitIn(root, ['init', '-q', '-b', 'work']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'x\n');
  gitIn(root, ['add', 'tracked.txt']);
  gitIn(root, ['commit', '-q', '-m', 'base']);
  const p = plan.empty();
  for (const s of slices) plan.addSlice(p, s);
  plan.save(home, p);
  const fakeBin = path.join(base, 'claude-fake');
  fs.writeFileSync(fakeBin, FAKE);
  fs.chmodSync(fakeBin, 0o755);
  const fakeSteps = path.join(base, 'steps.json');
  fs.writeFileSync(fakeSteps, JSON.stringify(steps));
  let t = Date.parse('2026-11-22T00:00:00Z');
  const clock = { now: () => t, sleep: async (ms) => (t += ms) };
  const opts = {
    root,
    home,
    hours,
    sessionMinutes: 0.25,
    pollMs: 5 * 60 * 1000,
    claudeBin: fakeBin,
    env: { ...process.env, TURBO_FAKE: fakeSteps },
    now: clock.now,
    sleep: clock.sleep,
    referee,
    finalGates: false,
    caffeinate: false,
    ...rest,
  };
  const call = (n) => JSON.parse(fs.readFileSync(`${fakeSteps}.call${n}.json`, 'utf8'));
  return { base, root, home, opts, call, clock };
}

it('driver: strikes the plan in order, stalks when it is empty, then waits out the hours', async () => {
  const steps = [
    { plan: [['status', 'a', 'done']], commit: 'a.txt', result: R('done', 'a') },
    { plan: [['status', 'b', 'done']], commit: 'b.txt', result: R('done', 'b') },
    { result: R('nothing', null) },
  ];
  const d = driverSetup(steps, { slices: [S('a'), S('b')] });
  try {
    const out = await turbo.run(d.opts);
    assert.deepStrictEqual(out.sessions.map((s) => s.kind), ['strike', 'strike', 'stalk']);
    assert.strictEqual(out.stopReason, 'hours');
    assert.deepStrictEqual(out.sessions.map((s) => s.verified.length), [1, 1, 0]);
    const summary = fs.readFileSync(path.join(out.runDir, 'summary.md'), 'utf8');
    assert.ok(summary.includes('hours') && summary.includes(out.sessions[0].session), summary);
    const log = fs.readFileSync(path.join(out.runDir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some((e) => e.type === 'wait'), 'no wait row');
    assert.strictEqual(log[log.length - 1].type, 'end');
    const c0 = d.call(0);
    const sid = c0.argv[c0.argv.indexOf('--session-id') + 1];
    assert.strictEqual(sid, out.sessions[0].session, 'the session id is pinned');
    assert.ok(c0.stdin.includes('Kind: **strike**'), 'the prompt came on stdin');
    assert.ok(c0.hooksPath.endsWith(path.join('scripts', 'turbo', 'githooks')), 'the git hooks env reached the session');
    assert.ok(!fs.existsSync(path.join(d.home, 'driver.lock')), 'the lock was released');
  } finally {
    rmrf(d.base);
  }
});

it('driver: works around a queued hard stop, waits for O, and resumes on an inbox answer', async () => {
  const q = JSON.stringify({ slice: 'a', kind: 'push', title: 'push', ask: 'push?' });
  const steps = [
    { plan: [['queue', q]], result: R('blocked', 'a', { queued: ['Q1'] }) },
    { plan: [['status', 'b', 'done']], commit: 'b.txt', result: R('done', 'b') },
    { result: R('nothing', null) }, // stalk: only held work is left
    { plan: [['answer', 'Q1', 'yes']], result: R('planned', null) }, // the inbox session applies O's answer
    { plan: [['status', 'a', 'done']], commit: 'a.txt', result: R('done', 'a') },
  ];
  let answered = false;
  const d = driverSetup(steps, { slices: [S('a'), S('b')], hours: 2 });
  const sleep = d.opts.sleep;
  d.opts.sleep = async (ms) => {
    if (!answered) {
      fs.writeFileSync(path.join(d.home, 'inbox.md'), 'Q1: yes\n');
      answered = true;
    }
    return sleep(ms);
  };
  try {
    const out = await turbo.run(d.opts);
    assert.deepStrictEqual(
      out.sessions.map((s) => `${s.kind}:${s.slice || '-'}`),
      ['strike:a', 'strike:b', 'stalk:-', 'stalk:-', 'strike:a', 'stalk:-'],
    );
    assert.ok(d.call(3).stdin.includes('Inbox changed since the last session: yes'));
    assert.strictEqual(plan.find(plan.load(d.home), 'a').status, 'done');
  } finally {
    rmrf(d.base);
  }
});

it('driver: a commit the referee cannot show puts an evidence-fix slice at the head of the plan', async () => {
  const steps = [{ plan: [['status', 'a', 'done']], commit: 'a.txt', result: R('done', 'a') }, { result: R('nothing', null) }];
  const d = driverSetup(steps, { slices: [S('a'), S('b')], referee: () => ({ shown: false, detail: 'red: no run' }), maxSessions: 2 });
  try {
    const out = await turbo.run(d.opts);
    const p = plan.load(d.home);
    assert.strictEqual(p.slices[0].id, 'a-evidence-1');
    assert.strictEqual(p.slices[0].kind, 'evidence-fix');
    assert.ok(p.slices[0].notes.join(' ').includes('red: no run'));
    assert.strictEqual(out.sessions[1].kind, 'evidence-fix');
    assert.strictEqual(out.sessions[0].referee.shown, false);
  } finally {
    rmrf(d.base);
  }
});

it('driver: a dirty tree after a session makes the next one a recovery', async () => {
  const steps = [{ dirty: 'tracked.txt', result: R('done', 'a') }, { result: R('recovered', null) }];
  const d = driverSetup(steps, { slices: [S('a')], maxSessions: 2 });
  try {
    const out = await turbo.run(d.opts);
    assert.deepStrictEqual(out.sessions.map((s) => s.kind), ['strike', 'recover']);
    assert.ok(out.sessions[0].dirty.length, 'the dirty file was not seen');
    assert.ok(d.call(1).stdin.includes('tracked.txt'), 'the recovery prompt names the dirty file');
  } finally {
    rmrf(d.base);
  }
});

it('driver: a session past its time is stopped; two failures in a row put the driver in wait mode', async () => {
  const steps = [{ hang: true }, { exit: 1 }];
  const d = driverSetup(steps, { slices: [S('a')], sessionMinutes: 0.02 });
  try {
    const out = await turbo.run(d.opts);
    assert.strictEqual(out.sessions[0].timedOut, true);
    assert.strictEqual(out.sessions[0].kind, 'strike');
    assert.strictEqual(out.sessions[1].kind, 'recover', 'a cut-off session is followed by a recovery');
    assert.strictEqual(out.sessions.length, 2, 'it kept starting sessions after two failures');
    assert.strictEqual(out.stopReason, 'hours');
  } finally {
    rmrf(d.base);
  }
});

it('driver: three sessions with no progress put it in wait mode', async () => {
  const d = driverSetup([{ result: R('failed', 'a') }, { result: R('failed', 'a') }, { result: R('failed', 'a') }], { slices: [S('a')] });
  try {
    const out = await turbo.run(d.opts);
    assert.strictEqual(out.sessions.length, 3);
    assert.strictEqual(out.stopReason, 'hours');
  } finally {
    rmrf(d.base);
  }
});

it('driver: STOP ends the run before the next session; PAUSE holds it; a changed branch ends it', async () => {
  const d = driverSetup([{ plan: [['status', 'a', 'done']], commit: 'a.txt', result: R('done', 'a') }], { slices: [S('a'), S('b')] });
  try {
    fs.writeFileSync(path.join(d.home, 'STOP'), '');
    assert.strictEqual((await turbo.run(d.opts)).stopReason, 'stop-file');
    fs.unlinkSync(path.join(d.home, 'STOP'));
    fs.writeFileSync(path.join(d.home, 'PAUSE'), '');
    const paused = await turbo.run(d.opts);
    assert.deepStrictEqual([paused.sessions.length, paused.stopReason], [0, 'hours']);
    fs.unlinkSync(path.join(d.home, 'PAUSE'));
    // The fake switches branch in its first session.
    fs.writeFileSync(d.opts.env.TURBO_FAKE, JSON.stringify([{ result: R('done', 'a') }]));
    const sw = { ...d.opts, claudeBin: d.opts.claudeBin, beforeCheck: () => gitIn(d.root, ['checkout', '-q', '-b', 'other']) };
    const out = await turbo.run(sw);
    assert.strictEqual(out.stopReason, 'branch-changed');
  } finally {
    rmrf(d.base);
  }
});

it('driver: refuses to start while another live driver holds the lock, and clears a dead one\'s lock', async () => {
  const d = driverSetup([], { slices: [], hours: 0 });
  try {
    fs.mkdirSync(d.home, { recursive: true });
    fs.writeFileSync(path.join(d.home, 'driver.lock'), JSON.stringify({ pid: process.pid, run: 'other' }));
    await assert.rejects(() => turbo.run(d.opts), /another driver/);
    fs.writeFileSync(path.join(d.home, 'driver.lock'), JSON.stringify({ pid: 2147483646, run: 'dead' }));
    assert.strictEqual((await turbo.run(d.opts)).stopReason, 'hours');
  } finally {
    rmrf(d.base);
  }
});

it('driver: refuses to start on a tree with uncommitted tracked changes (they belong to someone)', async () => {
  const d = driverSetup([], { slices: [S('a')] });
  try {
    fs.writeFileSync(path.join(d.root, 'tracked.txt'), 'someone else\'s work\n');
    await assert.rejects(() => turbo.run(d.opts), /uncommitted tracked changes/);
    assert.ok(!fs.existsSync(path.join(d.home, 'driver.lock')), 'the lock was left behind');
  } finally {
    rmrf(d.base);
  }
});

it('driver: a sha the session names but git does not have is not counted', async () => {
  const d = driverSetup([{ result: R('done', 'a', { commits: ['deadbeefdeadbeef'] }) }], { slices: [S('a')], maxSessions: 1 });
  try {
    const out = await turbo.run(d.opts);
    assert.deepStrictEqual(out.sessions[0].verified, []);
    assert.deepStrictEqual(out.sessions[0].unverified, ['deadbeefdeadbeef']);
  } finally {
    rmrf(d.base);
  }
});

it('driver: the default referee runs leopard-check --gate on the session and reads its exit', () => {
  const home = tmpDir();
  try {
    fs.writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'command_run', session_id: 'S9', command: 'ls' }) + '\n');
    const v = turbo.leopardReferee('S9', { root: path.join(__dirname, '..'), orunmilaHome: home });
    assert.strictEqual(v.shown, false, 'a session with no Slice commit is not shown');
    assert.strictEqual(v.exit, 1);
    assert.strictEqual(turbo.leopardReferee('nobody', { root: path.join(__dirname, '..'), orunmilaHome: home }).exit, 2);
  } finally {
    rmrf(home);
  }
});

// --- T6: docs and config ------------------------------------------------------

it('config: the run state folder .turbo/ is ignored by git, so a run never dirties the tree', () => {
  const r = spawnSync('git', ['-C', path.join(__dirname, '..'), 'check-ignore', '-q', '.turbo/plan.json']);
  assert.strictEqual(r.status, 0, '.turbo/ is not gitignored');
});

it('prompt: trailers are one block, ending with Co-Authored-By, so git (and leopard-check) can read Slice:', () => {
  const text = session.prompt(session.promptVars({ run: 'R', session: 'S', home: '/h', assignment: { kind: 'strike' } }));
  assert.ok(text.includes('one trailer block'), 'the prompt does not say trailers are one block');
  // The worked example in the prompt must itself parse: its last paragraph holds Slice:.
  const ex = text.split('```text\n')[1].split('```')[0];
  const r = spawnSync('git', ['interpret-trailers', '--parse'], { input: ex, encoding: 'utf8' });
  assert.ok(r.stdout.includes('Slice: T9'), `the example's trailers do not parse: ${r.stdout}`);
});

runAll('turbo');
