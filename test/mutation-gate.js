'use strict';

/**
 * test/mutation-gate.js — the mutation gate itself (scripts/mutation-gate.js),
 * and NF72: the gate must reach Phase 1's new modules, not only 0.2.2's files.
 *
 * The harness runs on a tiny throwaway repo built here (synthetic), through a
 * child process, so a gate that runs on `require` shows up as a timeout, never
 * as a silent pass.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const GATE = path.join(ROOT, 'scripts', 'mutation-gate.js');
const { spawnGroupSync } = require(GATE);

// Folders whose every .js file must be the target of at least one mutant (NF72).
const COVERED_DIRS = ['src/verify', 'src/opon/intake', 'src/opon/intake/adapters', 'src/opon/ledger', 'src/opon/fixtures'];

/**
 * Run `node -e code` from ROOT in a process group of its own (MG2, LD230): past `timeout` the gate, its
 * suites and their children are all killed, so a gate that hangs leaves nothing running. MG4: this outer
 * launcher uses the group layer only, so it never does the work of the layer a test proves on the gate inside.
 */
function runNode(code, timeout, layers = ['group']) {
  return spawnGroupSync('node', ['-e', code], { cwd: ROOT, timeoutMs: timeout, layers });
}

function node(code, timeout = 30000) {
  const r = runNode(code, timeout);
  assert.strictEqual(r.status, 0, `child exit ${r.status} signal ${r.signal}: ${(r.stderr || '').slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

/** Run runGate on `root` with `mutants` (and `more` options); returns { code, lines }. */
function gate(root, mutants, more = {}) {
  return node(
    `const g = require(${JSON.stringify(GATE)});
     const lines = [];
     const code = g.runGate({ root: ${JSON.stringify(root)}, mutants: ${JSON.stringify(mutants)}, log: (l) => lines.push(l), ...${JSON.stringify(more)} });
     process.stdout.write(JSON.stringify({ code, lines }));`,
  );
}

const line = (ok, title) => `console.log((${ok} ? '\\x1b[32mPASS' : '\\x1b[31mFAIL') + '\\x1b[0m  ${title}');`;

/** A tiny repo: src/add.js and src/neg.js; test/add.js covers add only; test/red.js always fails. */
function fakeRepo() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(root, 'src', 'neg.js'), 'module.exports = (a) => -a;\n');
  fs.writeFileSync(
    path.join(root, 'test', 'add.js'),
    `const ok = require('../src/add')(2, 3) === 5;\n${line('ok', 'add works')}\nprocess.exit(ok ? 0 : 1);\n`,
  );
  fs.writeFileSync(path.join(root, 'test', 'red.js'), `${line('false', 'always red')}\nprocess.exit(1);\n`);
  return root;
}

const KILL = { id: 'K add subtracts', file: 'src/add.js', test: 'test/add.js', from: 'a + b', to: 'a - b', fails: ['add works'] };

function withRepo(fn) {
  return () => {
    const root = fakeRepo();
    try {
      fn(root);
    } finally {
      rmrf(root);
    }
  };
}

it('requiring the gate runs nothing; it exports runGate and a mutant list whose named suites exist', () => {
  const r = node(
    `const g = require(${JSON.stringify(GATE)});
     process.stdout.write(JSON.stringify({ run: typeof g.runGate, mutants: (g.MUTANTS || []).map((m) => ({ file: m.file, test: m.test || null })) }));`,
  );
  assert.strictEqual(r.run, 'function');
  assert.ok(r.mutants.length >= 66, `only ${r.mutants.length} mutants`);
  const missing = r.mutants.filter((m) => m.test && !fs.existsSync(path.join(ROOT, m.test)));
  assert.deepStrictEqual(missing, []);
});

it('NF72: every .js file in each covered folder of Phase 1 code is the target of at least one mutant', () => {
  const { mutants } = node(`process.stdout.write(JSON.stringify({ mutants: require(${JSON.stringify(GATE)}).MUTANTS.map((m) => m.file) }));`);
  const targets = new Set(mutants);
  const uncovered = [];
  for (const dir of COVERED_DIRS) {
    const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, `${dir} has no .js files`);
    for (const f of files) if (!targets.has(`${dir}/${f}`)) uncovered.push(`${dir}/${f}`);
  }
  assert.deepStrictEqual(uncovered, []);
});

it(
  'a mutant runs against the suite it names; killed as predicted, the gate passes',
  withRepo((root) => {
    const r = gate(root, [KILL]);
    assert.strictEqual(r.code, 0, r.lines.join('\n'));
    assert.deepStrictEqual(r.lines.slice(0, 2), ['baseline: every test passes (1 suite(s): test/add.js)', 'killed  K add subtracts (1 test(s) failed)']);
  }),
);

it(
  'a mutant its suite does not catch survives, and the gate fails',
  withRepo((root) => {
    const r = gate(root, [KILL, { id: 'S neg is identity', file: 'src/neg.js', test: 'test/add.js', from: '-a', to: 'a', fails: ['add works'] }]);
    assert.strictEqual(r.code, 1);
    assert.ok(r.lines.includes('SURVIVED  S neg is identity: still passing: add works'), r.lines.join('\n'));
  }),
);

it(
  'a suite that is red before any mutation fails the baseline, naming it, and no mutant runs',
  withRepo((root) => {
    const r = gate(root, [KILL, { ...KILL, id: 'R', test: 'test/red.js', fails: ['always red'] }]);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.lines[0], 'baseline: FAIL (test/red.js, unmutated: exit 1, 0 passed, 1 failed: always red)');
    assert.strictEqual(r.lines.length, 1);
  }),
);

it(
  'MG1: a mutant that makes its suite never end is killed by the suite timeout, and the gate goes on (the Phase 3 close-out hung 31 minutes on one)',
  withRepo((root) => {
    const hang = { ...KILL, id: 'H add never returns', to: '(() => { for (;;); })()' };
    const r = gate(root, [hang, KILL], { suiteTimeoutMs: 2000 });
    assert.strictEqual(r.code, 0, r.lines.join('\n'));
    assert.deepStrictEqual(r.lines.slice(1, 3), ['killed  H add never returns (timed out after 2 s: the suite never ended)', 'killed  K add subtracts (1 test(s) failed)']);
  }),
);

it(
  'MG1: a suite that times out unmutated fails the baseline, naming it',
  withRepo((root) => {
    fs.writeFileSync(path.join(root, 'test', 'slow.js'), 'for (;;);\n');
    const r = gate(root, [{ ...KILL, id: 'T', test: 'test/slow.js' }], { suiteTimeoutMs: 1000 });
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.lines, ['baseline: FAIL (test/slow.js, unmutated: timed out after 1 s)']);
  }),
);

// MG2 (LD230): no process a suite starts outlives the gate, and none the gate starts outlives this test.
const HANG = { ...KILL, id: 'H add never returns', to: '(() => { for (;;); })()' };

/**
 * test/kid.js: starts a child that never ends, records its own pid and the child's in `pidFile`, then tests add. The
 * child stays in the suite's group with its environment cleared, so only the group kill reaches it (MG2); with
 * `detached`, it leaves for a session and group of its own with its environment kept, so only the sweep does (MG3);
 * with `escaped`, it leaves the group and clears its environment, so only the process tree does (MG4).
 */
const KID_OPTS = { group: 'env: {}', detached: 'detached: true', escaped: 'detached: true, env: {}' };
function addKidSuite(root, pidFile, mode = 'group') {
  fs.writeFileSync(
    path.join(root, 'test', 'kid.js'),
    `const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', ${KID_OPTS[mode]} });
require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + k.pid + '\\n');
const ok = require('../src/add')(2, 3) === 5;
${line('ok', 'add works')}
process.exit(ok ? 0 : 1);
`,
  );
}

const pidsIn = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
/** The pids still alive after up to `ms`. */
function survivors(pids, ms = 5000) {
  const end = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length && Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    left = left.filter(alive);
  }
  return left;
}
/** Kill whatever the test recorded and is still alive, so a red run leaks nothing. */
function reap(pidFile) {
  for (const p of pidsIn(pidFile).filter(alive)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch (e) {
      void e;
    }
  }
}

it(
  "MG2: a suite's own child is killed with the suite, when the suite ends and when it times out",
  withRepo((root) => {
    const pidDir = tmpDir();
    const pidFile = path.join(pidDir, 'pids');
    addKidSuite(root, pidFile);
    try {
      const r = gate(root, [{ ...HANG, test: 'test/kid.js' }], { suiteTimeoutMs: 2000, layers: ['group'] });
      assert.strictEqual(r.code, 0, r.lines.join('\n'));
      const pids = pidsIn(pidFile);
      assert.strictEqual(pids.length, 4, `baseline and mutant runs, suite and child each: ${pids.join(' ')}`);
      assert.deepStrictEqual(survivors(pids), []);
    } finally {
      reap(pidFile);
      rmrf(pidDir);
    }
  }),
);

it(
  "MG2: a gate that overruns this test's limit is killed with its suite and the suite's child",
  withRepo((root) => {
    const pidDir = tmpDir();
    const pidFile = path.join(pidDir, 'pids');
    addKidSuite(root, pidFile);
    try {
      const mutants = [{ ...HANG, test: 'test/kid.js' }];
      const r = runNode(
        `require(${JSON.stringify(GATE)}).runGate({ root: ${JSON.stringify(root)}, mutants: ${JSON.stringify(mutants)}, log: () => {}, suiteTimeoutMs: 600000, layers: ['group'] });`,
        4000,
      );
      assert.ok(r.timedOut, `the gate ended by itself: exit ${r.status}`);
      const pids = pidsIn(pidFile);
      assert.strictEqual(pids.length, 4, `baseline and mutant runs, suite and child each: ${pids.join(' ')}`);
      assert.deepStrictEqual(survivors(pids), []);
    } finally {
      reap(pidFile);
      rmrf(pidDir);
    }
  }),
);

it(
  "MG3 (LD239): a suite's child that leaves the suite's group (detached: a session and group of its own, as setsid makes) is killed too, when the suite ends and when it times out",
  withRepo((root) => {
    const pidDir = tmpDir();
    const pidFile = path.join(pidDir, 'pids');
    addKidSuite(root, pidFile, 'detached');
    try {
      const r = gate(root, [{ ...HANG, test: 'test/kid.js' }], { suiteTimeoutMs: 2000, layers: ['tag'] });
      assert.strictEqual(r.code, 0, r.lines.join('\n'));
      const pids = pidsIn(pidFile);
      assert.strictEqual(pids.length, 4, `baseline and mutant runs, suite and child each: ${pids.join(' ')}`);
      assert.deepStrictEqual(survivors(pids), []);
    } finally {
      reap(pidFile);
      rmrf(pidDir);
    }
  }),
);

/**
 * test/kid.js, MG4's deeper case: the suite records its pid and runs a middle process to its end; the middle one starts
 * a child that leaves the group and clears its environment, records both pids, and ends after `holdMs`, orphaning it.
 */
function addGrandkidSuite(root, pidFile, holdMs) {
  const mid =
    "const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', detached: true, env: {} });\n" +
    `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + k.pid + '\\n');\n` +
    `setTimeout(() => process.exit(0), ${holdMs});\n`;
  fs.writeFileSync(
    path.join(root, 'test', 'kid.js'),
    `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(mid)}], { stdio: 'ignore' });
const ok = require('../src/add')(2, 3) === 5;
${line('ok', 'add works')}
process.exit(ok ? 0 : 1);
`,
  );
}

const TABLE_READ = process.platform === 'darwin' || process.platform === 'linux'; // elsewhere no table is read: the reach line says so

/** Run the gate with only `layers` over a kid suite, both runs (baseline and a mutant that times out); nothing it recorded may live. */
function noSurvivors(root, write, layers, expected, suiteTimeoutMs) {
  const pidDir = tmpDir();
  const pidFile = path.join(pidDir, 'pids');
  write(pidFile);
  try {
    const r = gate(root, [{ ...HANG, test: 'test/kid.js' }], { suiteTimeoutMs, layers });
    assert.strictEqual(r.code, 0, r.lines.join('\n'));
    const pids = pidsIn(pidFile);
    assert.strictEqual(pids.length, expected, `pids recorded: ${pids.join(' ')}`);
    assert.deepStrictEqual(survivors(pids), []);
  } finally {
    reap(pidFile);
    rmrf(pidDir);
  }
}

it(
  "MG4: a suite's child that leaves the suite's group and clears its environment is killed too, with every layer on, as the gate runs, when the suite ends and when it times out",
  withRepo((root) => {
    if (!TABLE_READ) return;
    noSurvivors(root, (f) => addKidSuite(root, f, 'escaped'), undefined, 4, 2000);
  }),
);

it(
  "MG4 exit: the node suite's preload lists that child at the suite's exit, and the launcher looks before a timeout kills the suite",
  withRepo((root) => {
    if (!TABLE_READ) return;
    noSurvivors(root, (f) => addKidSuite(root, f, 'escaped'), ['exit'], 4, 2000);
  }),
);

it(
  "MG4 poll: such a child of the suite's child, orphaned before the suite ends, is followed from the poll",
  withRepo((root) => {
    if (!TABLE_READ) return;
    noSurvivors(root, (f) => addGrandkidSuite(root, f, 1000), ['poll'], 6, 4000);
  }),
);

it(
  'MG4 reaper (Linux with python3): such a child orphaned at once comes back to the launcher, a subreaper',
  withRepo((root) => {
    const probe = node(`process.stdout.write(JSON.stringify({ reach: require(${JSON.stringify(GATE)}).reach() }))`);
    if (!probe.reach.includes('subreaper')) return; // macOS has none: the reach line names the race instead
    noSurvivors(root, (f) => addGrandkidSuite(root, f, 0), ['reaper'], 6, 4000);
  }),
);

it(
  'MG4: the gate declares what it cannot reach, last: a process run as another user, always',
  withRepo((root) => {
    const r = gate(root, [KILL]);
    assert.strictEqual(r.code, 0, r.lines.join('\n'));
    const last = r.lines[r.lines.length - 1];
    assert.ok(last.startsWith('reach: '), `the last line is not the reach line: ${last}`);
    assert.ok(last.includes('not reached: a process run as another user'), last);
  }),
);

it(
  'a mutant whose snippet does not occur exactly once is an error, not a pass',
  withRepo((root) => {
    const r = gate(root, [KILL, { ...KILL, id: 'E', from: 'zzz' }]);
    assert.strictEqual(r.code, 1);
    assert.ok(r.lines.includes('ERROR  E: its snippet occurs 0 times in src/add.js, not once'), r.lines.join('\n'));
  }),
);

it("every real mutant's snippet occurs exactly once in its file today, so an edit that moves one fails npm test, not only the phase-end gate", () => {
  const { MUTANTS } = node(`process.stdout.write(JSON.stringify({ MUTANTS: require(${JSON.stringify(GATE)}).MUTANTS }))`);
  const bad = MUTANTS.map((m) => [m.id, fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1]).filter(([, n]) => n !== 1);
  assert.deepStrictEqual(bad, []);
});

runAll('mutation-gate');
