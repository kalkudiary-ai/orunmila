// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/verify-fresh.js — V2 (Phase 7; brief v4 lines 711-717, test 24): the verifier "needs no setup, no account and
 * no network". From a copy of exactly the files npm ships, in a home folder that has never held Orunmila, with every
 * network call refused and recorded by a preload, `orunmila verify <session-folder>` answers "Record intact" with its
 * counts, and leaves the home folder as empty as it found it. Two planted runs show the instrument sees what it
 * refuses: a network call, and a write into the home folder. Hand-built session logs; made-up paths.
 */

const { assert, fs, os, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { execFileSync, spawnSync } = require('child_process');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');

// Every way a Node program reaches the network, refused, each attempt written to NET_LOG (one line each).
const PRELOAD = `'use strict';
const fs = require('fs');
const note = (what) => { fs.appendFileSync(process.env.NET_LOG, what + '\\n'); return new Error('network refused: ' + what); };
const net = require('net'); const dns = require('dns'); const http = require('http'); const https = require('https'); const tls = require('tls');
net.Socket.prototype.connect = function () { throw note('net.connect'); };
net.connect = net.createConnection = () => { throw note('net.connect'); };
tls.connect = () => { throw note('tls.connect'); };
dns.lookup = () => { throw note('dns.lookup'); };
dns.resolve = () => { throw note('dns.resolve'); };
http.request = http.get = () => { throw note('http.request'); };
https.request = https.get = () => { throw note('https.request'); };
globalThis.fetch = () => { throw note('fetch'); };
`;

/** Every file and folder under dir, relative, sorted: [] for an empty folder. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      out.push(path.relative(dir, path.join(d, e.name)));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/** A fresh machine: the shipped files, an empty home, the preload, and an environment with no Orunmila setting. */
function freshMachine(shipped, home, scratch) {
  const preload = path.join(scratch, 'no-network.js');
  const netLog = path.join(scratch, 'net.log');
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(netLog, '');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NET_LOG: netLog };
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  const node = (args) => spawnSync(process.execPath, ['-r', preload, ...args], { encoding: 'utf8', env, cwd: scratch });
  return { node, attempts: () => fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean) };
}

function shippedCopy() {
  const shipped = tmpDir();
  const win = process.platform === 'win32';
  const packed = JSON.parse(execFileSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const f of packed[0].files) {
    const to = path.join(shipped, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f.path), to);
  }
  return shipped;
}

it('V2 test 24: from the shipped files, in a home that never held Orunmila, with no network, verify says "Record intact" with counts, and the home stays empty', () => {
  const dirs = { shipped: shippedCopy(), home: tmpDir(), scratch: tmpDir(), base: tmpDir() };
  try {
    const s = makeLog(dirs.base);
    s.append(M.prompted(0));
    s.append(M.started(10, 'e1', { kind: 'file', path: 'src/a.ts' }));
    s.append(M.edited(100, 'e1', 'src/a.ts'));
    s.append(M.disk(300, 'src/a.ts'));
    s.append(M.turnEnded(900));
    s.append(M.tick(10000));
    const r = replayFolder(s.dir);
    fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu);
    fs.writeFileSync(path.join(s.dir, 'verdict.jsonl'), r.verdict);
    const m = freshMachine(dirs.shipped, dirs.home, dirs.scratch);
    const v = m.node([path.join(dirs.shipped, 'bin', 'orunmila.js'), 'verify', s.dir]);
    assert.strictEqual(v.status, 0, v.stdout + v.stderr);
    assert.ok(/^Record intact: 6 marks, /.test(v.stdout), v.stdout);
    assert.ok(/odù records, each pointing to marks the raw log holds/.test(v.stdout) && /verdicts in the verdict log/.test(v.stdout), v.stdout);
    assert.deepStrictEqual(m.attempts(), [], 'no network call attempted');
    assert.deepStrictEqual(tree(dirs.home), [], 'nothing written in the home folder');
  } finally {
    for (const d of Object.values(dirs)) rmrf(d);
  }
});

it('V2: the instrument sees what it refuses: a planted network call is recorded, and a planted write in the home is listed', () => {
  const dirs = { home: tmpDir(), scratch: tmpDir() };
  try {
    const m = freshMachine(null, dirs.home, dirs.scratch);
    const call = m.node(['-e', "require('https').get('https://registry.npmjs.org/orunmila')"]);
    assert.notStrictEqual(call.status, 0, 'the call was refused');
    assert.deepStrictEqual(m.attempts(), ['https.request']);
    m.node(['-e', "require('fs').writeFileSync(require('path').join(require('os').homedir(), '.orunmila-planted'), '')"]);
    assert.deepStrictEqual(tree(dirs.home), ['.orunmila-planted'], 'os.homedir() is the fresh home on ' + os.platform());
  } finally {
    for (const d of Object.values(dirs)) rmrf(d);
  }
});

runAll('verify-fresh');
