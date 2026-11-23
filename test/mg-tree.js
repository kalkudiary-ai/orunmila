'use strict';

/**
 * test/mg-tree.js — MG4: the process table the mutation gate's launcher reads (scripts/mg-tree.js). Tables here are
 * synthetic, except the one read of this machine's own table.
 */

const { assert, path, ROOT, it, runAll } = require('./helpers');
const tree = require(path.join(ROOT, 'scripts', 'mg-tree.js'));

const T = (rows) => new Map(rows.map(([pid, ppid, start]) => [pid, { ppid, start }]));

it('parsePs: pid, ppid and the five words of lstart, one process a line; short or broken lines are skipped', () => {
  const t = tree.parsePs('  101     1 Mon Nov 23 17:19:22 2026\n  102   101 Mon Nov 23 17:19:23 2026\nbroken line\n\n');
  assert.deepStrictEqual([...t], [
    [101, { ppid: 1, start: 'Mon Nov 23 17:19:22 2026' }],
    [102, { ppid: 101, start: 'Mon Nov 23 17:19:23 2026' }],
  ]);
});

it('parseStat: ppid and start time come after the last ")", so a command name holding ") " is read whole', () => {
  // fields 1-22 of /proc/<pid>/stat: pid (comm) state ppid ... starttime
  const rest = Array.from({ length: 17 }, (_, i) => String(i)).join(' '); // fields 5-21
  assert.deepStrictEqual(tree.parseStat(`42 (a) b) S 7 ${rest} 99887 0`), { ppid: 7, start: '99887' });
});

it('track: follows every descendant of a root by ppid, however deep, and nothing else', () => {
  const t = T([[10, 1, 'a'], [11, 10, 'b'], [12, 11, 'c'], [20, 1, 'd']]);
  assert.deepStrictEqual([...tree.track(t, [10], new Map())].sort(), [[11, 'b'], [12, 'c']]);
});

it('track: an orphan already tracked is still followed, and so are its children, after its parent ends', () => {
  const tracked = new Map([[12, 'c']]);
  const t = T([[12, 1, 'c'], [13, 12, 'e']]); // 11 has ended; 12 is now pid 1's
  assert.deepStrictEqual([...tree.track(t, [10], tracked)].sort(), [[12, 'c'], [13, 'e']]);
});

it('track: a reused pid (same pid, another start) is not followed, nor are its children', () => {
  const tracked = new Map([[12, 'c']]);
  const t = T([[12, 1, 'other'], [13, 12, 'e']]);
  assert.deepStrictEqual([...tree.track(t, [10], tracked)], [[12, 'c']]);
});

it('live: a reused pid is never returned for killing; a tracked process that is gone is not either', () => {
  const tracked = new Map([[12, 'c'], [13, 'e'], [14, 'f']]);
  const t = T([[12, 1, 'c'], [13, 1, 'reused']]);
  assert.deepStrictEqual(tree.live(t, tracked), [12]);
});

it('table: this machine\'s table (macOS or Linux) holds this process with its parent, and not the ps that read it', () => {
  const t = tree.table();
  if (process.platform !== 'darwin' && process.platform !== 'linux') return assert.strictEqual(t, null);
  assert.strictEqual(t.get(process.pid).ppid, process.ppid);
  assert.deepStrictEqual([...t].filter(([, p]) => p.ppid === process.pid), [], 'a child of this process is in the table');
});

it('formatTracked and readTracked: a list written and read back is the same list, one process a line', () => {
  const tracked = new Map([[12, 'Mon Nov 23 17:19:22 2026'], [13, '99887']]);
  assert.deepStrictEqual([...tree.readTracked(tree.formatTracked(tracked), new Map())], [...tracked]);
});

runAll('mg-tree');
