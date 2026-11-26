// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/update.js — PM2c1 (LD332; Phase 5 plan section 6, Q33; LD268: Orunmila's own updates are not calls to work):
 * `orunmila update` asks the registry for the latest version, downloads it, checks npm's integrity hash, unpacks it into
 * Orunmila's home, runs the new version's self-check, and switches `runtime/current` to it only while no session is
 * held, keeping the version it ran as `runtime/previous`; each switch, and each failed self-check, goes into the update
 * log (PM2a). The registry here is a fake one on 127.0.0.1, serving a package packed from this repository with its
 * version set to 9.9.9; the home and project are throwaway folders. Nothing reaches the internet.
 */

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { installRuntime } = require('../src/runtime/install');
const { untar } = require('../src/runtime/untar');
const { readUpdatesLog } = require('../src/opon/ledger/updates');

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sri = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

/** This repository packed with its version set to `version` (and, with `lie`, its CLI saying another). */
function packed(base, version, { lie = null } = {}) {
  const src = path.join(base, `src-${version}${lie ? '-lie' : ''}`);
  fs.mkdirSync(src, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of pkg.files) if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(src, f), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ ...pkg, version, scripts: {} }, null, 2));
  if (lie) {
    const cli = path.join(src, 'bin', 'orunmila.js');
    fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace("console.log(require('../package.json').version);", `console.log('${lie}');`));
  }
  const r = spawnSync(npm, ['pack', '--pack-destination', base, src], { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, npm_config_update_notifier: 'false' } });
  assert.strictEqual(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(base, r.stdout.trim().split('\n').pop()));
}

/** A registry on 127.0.0.1 offering `latest` as `tgz`, its integrity `integrity` (npm's own by default). */
async function registry(latest, tgz, integrity = sri(tgz)) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const port = server.address().port;
    if (req.url === '/orunmila') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'orunmila', 'dist-tags': { latest }, versions: { [latest]: { name: 'orunmila', version: latest, dist: { tarball: `http://127.0.0.1:${port}/orunmila/-/orunmila-${latest}.tgz`, integrity } } } }));
    }
    if (req.url === `/orunmila/-/orunmila-${latest}.tgz`) return res.end(tgz);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

/** `orunmila update` (async, so the registry in this process can answer). */
function update(home, reg, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'update', ...extra], { env: { ...process.env, ORUNMILA_HOME: home, ORUNMILA_REGISTRY: reg.url, ORUNMILA_INTAKE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (status) => resolve({ status, out }));
  });
}
const current = (home) => fs.readFileSync(path.join(home, 'runtime', 'current'), 'utf8').trim();
const starterVersion = (home) => spawnSync(process.execPath, [path.join(home, 'bin', 'orunmila-start.js'), 'bin/orunmila.js', '--version'], { encoding: 'utf8' }).stdout.trim();

let shared = null;
/** One packed 9.9.9 for the tests that need a good one (packing takes seconds). */
function good(base) {
  if (!shared) shared = packed(base, '9.9.9');
  return shared;
}
const keep = tmpDir();

it('PM2c1: a newer version offered, no session held: downloaded, integrity checked, self-checked, switched to; the old one kept as previous; one update record; the starter runs the new one', async () => {
  const base = tmpDir();
  const reg = await registry('9.9.9', good(keep));
  try {
    const home = path.join(base, 'h');
    const before = installRuntime({ home, from: ROOT }).folder;
    const r = await update(home, reg);
    assert.strictEqual(r.status, 0, r.out);
    assert.ok(r.out.includes(`switched from ${VERSION} to 9.9.9`), r.out);
    assert.ok(/^9\.9\.9_[0-9a-f]{12}$/.test(current(home)), current(home));
    assert.strictEqual(fs.readFileSync(path.join(home, 'runtime', 'previous'), 'utf8').trim(), before);
    assert.strictEqual(starterVersion(home), '9.9.9', 'a hook through the starter now runs 9.9.9');
    const log = readUpdatesLog(home);
    assert.strictEqual(log.ok, true, log.words);
    assert.deepStrictEqual(log.updates.map((u) => [u.from, u.to, u.integrity, u.self_check, u.switched]), [[VERSION, '9.9.9', sri(good(keep)), 'pass', true]]);
    assert.deepStrictEqual(reg.hits, ['/orunmila', '/orunmila/-/orunmila-9.9.9.tgz'], 'one lookup, one download: nothing else asked or sent');
    const again = await update(home, reg);
    assert.deepStrictEqual([again.status, again.out.includes('up to date')], [0, true], again.out);
  } finally {
    await reg.close();
    rmrf(base);
  }
});

it('PM2c1: while a session is held, the new version waits, checked, beside the current one; the next update with none held switches to it without downloading again', async () => {
  const base = tmpDir();
  const reg = await registry('9.9.9', good(keep));
  try {
    const home = path.join(base, 'h');
    const before = installRuntime({ home, from: ROOT }).folder;
    fs.mkdirSync(path.join(home, 'intake'), { recursive: true });
    fs.writeFileSync(path.join(home, 'intake', 'held.json'), JSON.stringify(['ses_held'])); // an intake stopped while holding it: its restart resumes it
    const wait = await update(home, reg);
    assert.strictEqual(wait.status, 0, wait.out);
    assert.ok(wait.out.includes('waits until no session is held'), wait.out);
    assert.strictEqual(current(home), before, 'not switched');
    assert.deepStrictEqual(readUpdatesLog(home).updates, [], 'nothing recorded until it switches');
    fs.writeFileSync(path.join(home, 'intake', 'held.json'), '[]');
    const go = await update(home, reg);
    assert.strictEqual(go.status, 0, go.out);
    assert.ok(/^9\.9\.9_/.test(current(home)), go.out);
    assert.strictEqual(reg.hits.filter((h) => h.endsWith('.tgz')).length, 1, 'downloaded once');
    assert.deepStrictEqual(readUpdatesLog(home).updates.map((u) => [u.to, u.switched]), [['9.9.9', true]]);
  } finally {
    await reg.close();
    rmrf(base);
  }
});

it('PM2c1: a download whose integrity is not what the registry says is refused: nothing kept, nothing switched, exit 1', async () => {
  const base = tmpDir();
  const reg = await registry('9.9.9', good(keep), sri(Buffer.from('another package')));
  try {
    const home = path.join(base, 'h');
    const before = installRuntime({ home, from: ROOT }).folder;
    const r = await update(home, reg);
    assert.strictEqual(r.status, 1, r.out);
    assert.ok(r.out.includes('integrity'), r.out);
    assert.strictEqual(current(home), before);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'runtime')).sort(), ['current', before].sort(), 'nothing kept');
  } finally {
    await reg.close();
    rmrf(base);
  }
});

it('PM2c1: a version whose self-check fails (its CLI names another version) is not switched to, is removed, and the refusal is recorded', async () => {
  const base = tmpDir();
  const reg = await registry('9.9.9', packed(base, '9.9.9', { lie: '1.0.0' }));
  try {
    const home = path.join(base, 'h');
    const before = installRuntime({ home, from: ROOT }).folder;
    const r = await update(home, reg);
    assert.strictEqual(r.status, 1, r.out);
    assert.ok(r.out.includes('self-check'), r.out);
    assert.strictEqual(current(home), before);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'runtime')).sort(), ['current', before].sort());
    assert.deepStrictEqual(readUpdatesLog(home).updates.map((u) => [u.to, u.self_check, u.switched]), [['9.9.9', 'fail', false]]);
  } finally {
    await reg.close();
    rmrf(base);
  }
});

it('PM2c1: an older or equal version offered changes nothing; with no copy installed, update says to install first', async () => {
  const base = tmpDir();
  const reg = await registry('0.0.1', good(keep));
  try {
    const home = path.join(base, 'h');
    const none = await update(home, reg);
    assert.deepStrictEqual([none.status, none.out.includes('orunmila install')], [1, true], none.out);
    installRuntime({ home, from: ROOT });
    const r = await update(home, reg);
    assert.deepStrictEqual([r.status, r.out.includes('up to date')], [0, true], r.out);
    assert.deepStrictEqual(reg.hits.filter((h) => h.endsWith('.tgz')), [], 'nothing downloaded');
  } finally {
    await reg.close();
    rmrf(base);
  }
});

/** A tar entry (ustar), for the unpacker's own tests. */
function entry(name, data = Buffer.alloc(0), type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgz = (...entries) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
/** A pax extended header: each record is "<its own length> key=value\n", the length counting its own digits. */
const pax = (key, value) => {
  const body = ` ${key}=${value}\n`;
  let len = body.length;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return entry('PaxHeader', Buffer.from(`${len}${body}`), 'x');
};

it('PM2c1: the unpacker takes regular files under package/, a long name from a pax header, and refuses a path that leaves the folder, a link, or anything outside package/', () => {
  const long = 'package/' + 'a/'.repeat(60) + 'f.js';
  const files = untar(tgz(entry('package/x.js', Buffer.from('x')), entry('package/d/', Buffer.alloc(0), '5'), pax('path', long), entry('ignored-short-name', Buffer.from('y'))));
  assert.deepStrictEqual(files.map((f) => [f.path, f.data.toString()]), [['x.js', 'x'], [long.slice('package/'.length), 'y']]);
  for (const [bad, words] of [
    [tgz(entry('package/../evil.js', Buffer.from('x'))), 'leaves the package'],
    [tgz(entry('/etc/evil.js', Buffer.from('x'))), 'outside package/'],
    [tgz(entry('package/link', Buffer.alloc(0), '2')), 'not a file or a folder'],
    [tgz(entry('other/x.js', Buffer.from('x'))), 'outside package/'],
  ]) assert.throws(() => untar(bad), (e) => e.message.includes(words), words);
});

it('PM2c1 (LD268): the updater is the one file that reaches the network, and nothing but the update command loads it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const loaders = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, n));
    else if (rel.endsWith('.js')) {
      const text = fs.readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) if (path.posix.basename(m[1]) === 'registry' || m[1].endsWith('/registry.js')) loaders.push(rel);
    }
  };
  for (const f of pkg.files) walk(f.replace(/\/$/, ''));
  assert.deepStrictEqual(loaders, ['src/runtime/update.js']);
});

it('cleanup', () => rmrf(keep));
runAll('update');
