'use strict';

/**
 * test/paths.js — path normalisation at intake (Phase 1 slice A7; brief v3 line
 * 339; test 14; NF3). Real files in a throwaway folder; the case-folding cases
 * pass `caseInsensitive` explicitly so they do not depend on this machine's
 * file system, and detection is checked against a direct probe.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { normalisePath, isCaseInsensitive, sessionFolderName } = require('../src/opon/intake/paths');

function withTree(fn) {
  return () => {
    const base = fs.realpathSync(tmpDir());
    const root = path.join(base, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'A.ts'), 'a');
    fs.writeFileSync(path.join(root, 'src', 'B.ts'), 'b');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'lnk'), 'junction'); // 'junction': no admin rights on Windows; ignored elsewhere
    try {
      fn({ base, root });
    } finally {
      rmrf(base);
    }
  };
}

it(
  'test 14: ./src/A.ts and src/a.ts on a case-insensitive file system are one target',
  withTree(({ root }) => {
    const a = normalisePath('./src/A.ts', { root, caseInsensitive: true });
    const b = normalisePath('src/a.ts', { root, caseInsensitive: true });
    assert.deepStrictEqual(a, { path: 'src/a.ts', outside: false });
    assert.deepStrictEqual(b, a);
    assert.deepStrictEqual(normalisePath(path.join(root, 'SRC', 'a.TS'), { root, caseInsensitive: true }), a);
  }),
);

it(
  'two genuinely different files stay two targets; on a case-sensitive file system case is kept',
  withTree(({ root }) => {
    const a = normalisePath('src/A.ts', { root, caseInsensitive: true });
    const b = normalisePath('src/B.ts', { root, caseInsensitive: true });
    assert.notDeepStrictEqual(a, b);
    assert.deepStrictEqual(normalisePath('src/A.ts', { root, caseInsensitive: false }), { path: 'src/A.ts', outside: false });
    assert.deepStrictEqual(normalisePath('src/a.ts', { root, caseInsensitive: false }), { path: 'src/a.ts', outside: false });
  }),
);

it(
  'symlinks are resolved: a link into src/ gives the same target as src/',
  withTree(({ root }) => {
    assert.deepStrictEqual(normalisePath('lnk/A.ts', { root, caseInsensitive: false }), { path: 'src/A.ts', outside: false });
    // The root itself given through a symlink (macOS: /var is /private/var).
    const linkedRoot = path.join(path.dirname(root), 'rootlink');
    fs.symlinkSync(root, linkedRoot, 'junction');
    assert.deepStrictEqual(normalisePath(path.join(linkedRoot, 'src', 'B.ts'), { root, caseInsensitive: false }), { path: 'src/B.ts', outside: false });
    assert.deepStrictEqual(normalisePath('src/B.ts', { root: linkedRoot, caseInsensitive: false }), { path: 'src/B.ts', outside: false });
  }),
);

it(
  'a file that no longer exists still normalises, through its deepest existing folder',
  withTree(({ root }) => {
    assert.deepStrictEqual(normalisePath('lnk/gone/X.ts', { root, caseInsensitive: false }), { path: 'src/gone/X.ts', outside: false });
    assert.deepStrictEqual(normalisePath('./src/./gone/../B.ts', { root, caseInsensitive: false }), { path: 'src/B.ts', outside: false });
  }),
);

it(
  'a path outside the root keeps its absolute real path and says so; .. cannot climb out unnoticed',
  withTree(({ base, root }) => {
    fs.writeFileSync(path.join(base, 'outside.txt'), 'x');
    assert.deepStrictEqual(normalisePath('../outside.txt', { root, caseInsensitive: false }), { path: path.join(base, 'outside.txt').split(path.sep).join('/'), outside: true });
    assert.strictEqual(normalisePath('src/../../outside.txt', { root, caseInsensitive: false }).outside, true);
    assert.deepStrictEqual(normalisePath('.', { root, caseInsensitive: false }), { path: '.', outside: false });
    assert.deepStrictEqual(normalisePath(root, { root, caseInsensitive: false }), { path: '.', outside: false });
  }),
);

it(
  'case-insensitivity is detected from the file system itself, agreeing with a direct probe',
  withTree(({ root }) => {
    const probe = (() => {
      try {
        return fs.statSync(path.join(root, 'src', 'a.ts')).ino === fs.statSync(path.join(root, 'src', 'A.ts')).ino;
      } catch {
        return false;
      }
    })();
    assert.strictEqual(isCaseInsensitive(path.join(root, 'src')), probe);
    assert.strictEqual(typeof isCaseInsensitive(root), 'boolean');
  }),
);

it('NF3: a session id becomes a folder name only when it is safe; ../ and separators are refused', () => {
  assert.strictEqual(sessionFolderName('3db38425-31fe-4ecf-b46e-84625830f976'), '3db38425-31fe-4ecf-b46e-84625830f976');
  assert.strictEqual(sessionFolderName('ses_20261030_a1b2'), 'ses_20261030_a1b2');
  for (const bad of ['../etc', 'a/b', 'a\\b', '..', '.', '', '.hidden', 'x'.repeat(129), 'a\u0000b', null, 42]) {
    assert.throws(() => sessionFolderName(bad), /session id/, String(bad));
  }
});

runAll('paths');
