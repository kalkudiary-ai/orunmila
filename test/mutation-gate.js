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
const { spawnSync } = require('child_process');

const GATE = path.join(ROOT, 'scripts', 'mutation-gate.js');

// Folders whose every .js file must be the target of at least one mutant (NF72).
const COVERED_DIRS = ['src/verify'];

function node(code, timeout = 30000) {
  const r = spawnSync('node', ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout });
  assert.strictEqual(r.status, 0, `child exit ${r.status} signal ${r.signal}: ${(r.stderr || '').slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

/** Run runGate on `root` with `mutants`; returns { code, lines }. */
function gate(root, mutants) {
  return node(
    `const g = require(${JSON.stringify(GATE)});
     const lines = [];
     const code = g.runGate({ root: ${JSON.stringify(root)}, mutants: ${JSON.stringify(mutants)}, log: (l) => lines.push(l) });
     process.stdout.write(JSON.stringify({ code, lines }));`,
  );
}

/** A tiny repo: src/add.js and src/neg.js; test/add.js covers add only; test/red.js always fails. */
function fakeRepo() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(root, 'src', 'neg.js'), 'module.exports = (a) => -a;\n');
  const line = (ok, title) => `console.log((${ok} ? '\\x1b[32mPASS' : '\\x1b[31mFAIL') + '\\x1b[0m  ${title}');`;
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
  'a mutant whose snippet does not occur exactly once is an error, not a pass',
  withRepo((root) => {
    const r = gate(root, [KILL, { ...KILL, id: 'E', from: 'zzz' }]);
    assert.strictEqual(r.code, 1);
    assert.ok(r.lines.includes('ERROR  E: its snippet occurs 0 times in src/add.js, not once'), r.lines.join('\n'));
  }),
);

runAll('mutation-gate');
