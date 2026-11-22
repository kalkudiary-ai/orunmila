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

runAll('turbo');
