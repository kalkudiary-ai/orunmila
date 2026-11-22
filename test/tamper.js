'use strict';

/**
 * test/tamper.js — tampering marks for configuration changed mid-session
 * (slice B3, LD147; brief v4 lines 245, 349-350; tests 10, 30, 42, 52, mark
 * side; ledger A3, NF41, NF42). Throwaway projects, code folders and homes;
 * made-up contents only.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll, awaitWatching } = require('./helpers');
const crypto = require('crypto');
const { createRouter } = require('../src/opon/intake/router');
const { checkLog } = require('../src/verify/session');
const { nowMono } = require('../src/opon/intake/mono');

const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

function setup({ sentinel = false } = {}) {
  const home = fs.realpathSync(tmpDir());
  const root = fs.realpathSync(tmpDir());
  const code = fs.realpathSync(tmpDir());
  fs.mkdirSync(path.join(code, 'laws', 'packs'), { recursive: true });
  fs.writeFileSync(path.join(code, 'laws', 'packs', 'canon.json'), '{"laws":[]}');
  fs.writeFileSync(path.join(code, 'core.js'), '// v1');
  fs.mkdirSync(path.join(root, '.orunmila'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.orunmila', 'byproducts'), 'dist/\n');
  fs.writeFileSync(path.join(root, '.orunmila', 'laws.json'), '{"laws":[]}');
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"hooks":{}}');
  const make = () =>
    createRouter({
      home,
      clock: () => ({ mono: nowMono(), wall: new Date().toISOString() }),
      checkSender: () => true,
      codeRoot: code,
      orunmilaVersion: 't',
      installKey: crypto.randomBytes(32),
      hookSettingsFor: (r) => [path.join(r, '.claude', 'settings.local.json')],
      sentinel,
    });
  const t = { home, root, code, router: make() };
  t.again = () => {
    t.router.stop('restart');
    t.router = make();
    t.router.resume();
  };
  t.send = (ev = 'UserPromptSubmit') => t.router.payload({ session_id: 's1', hook_event_name: ev, cwd: root, prompt: 'p' }, { channel: 'command' });
  t.tampered = () => checkLog(path.join(home, 'sessions', 's1'), 'raw').records.map((r) => r.rec).filter((m) => m.says === 'tampered');
  t.done = () => {
    t.router.stop('over');
    for (const d of [home, root, code]) rmrf(d);
  };
  return t;
}

it('test 52: the project law pack edited mid-session is one tampered mark (frozen_config), with the frozen and the new fingerprint', () => {
  const t = setup();
  try {
    t.send();
    fs.writeFileSync(path.join(t.root, '.orunmila', 'laws.json'), '{"laws":[{"id":"no-green-without-command","enabled":false}]}');
    t.send();
    const m = t.tampered();
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].source, 'process');
    assert.strictEqual(m[0].detail.what, 'frozen_config');
    assert.deepStrictEqual(m[0].target, { kind: 'file', path: '.orunmila/laws.json' });
    assert.strictEqual(m[0].detail.fingerprint_before, sha('{"laws":[]}'));
    assert.strictEqual(m[0].detail.fingerprint, sha('{"laws":[{"id":"no-green-without-command","enabled":false}]}'));
    t.send();
    t.send();
    assert.strictEqual(t.tampered().length, 1, 'no new mark while nothing changes again');
    fs.writeFileSync(path.join(t.root, '.orunmila', 'laws.json'), '{"laws":[1]}');
    t.send();
    assert.strictEqual(t.tampered().length, 2, 'a second change is a second mark');
    assert.strictEqual(t.tampered()[1].detail.fingerprint_before, m[0].detail.fingerprint);
  } finally {
    t.done();
  }
});

it('test 30: the byproducts list changed mid-session is a tampered mark; a deleted one has fingerprint null', () => {
  const t = setup();
  try {
    t.send();
    fs.writeFileSync(path.join(t.root, '.orunmila', 'byproducts'), 'dist/\nsrc/auth.ts\n');
    t.send();
    fs.rmSync(path.join(t.root, '.orunmila', 'byproducts'));
    t.send();
    const m = t.tampered();
    assert.deepStrictEqual(m.map((x) => [x.detail.what, x.target.path, x.detail.fingerprint === null]), [
      ['frozen_config', '.orunmila/byproducts', false],
      ['frozen_config', '.orunmila/byproducts', true],
    ]);
  } finally {
    t.done();
  }
});

it("test 42: the agent's hook settings edited mid-session are a tampered mark (hook_settings), saying Claude Code may already use them (NF42)", () => {
  const t = setup();
  try {
    t.send();
    fs.writeFileSync(path.join(t.root, '.claude', 'settings.local.json'), '{"hooks":{"Stop":[]}}');
    t.send('PreToolUse');
    const m = t.tampered();
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].detail.what, 'hook_settings');
    assert.deepStrictEqual(m[0].target, { kind: 'file', path: '.claude/settings.local.json' });
    assert.ok(/NF42/.test(m[0].detail.reason), m[0].detail.reason);
  } finally {
    t.done();
  }
});

it("A3 (NF41): Orunmila's own code changed mid-session is a tampered mark (orunmila_code) on its folder", () => {
  const t = setup();
  try {
    t.send();
    fs.writeFileSync(path.join(t.code, 'core.js'), '// v2');
    t.send();
    const m = t.tampered();
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].detail.what, 'orunmila_code');
    assert.deepStrictEqual(m[0].target, { kind: 'dir', path: t.code, outside: true });
    const header = checkLog(path.join(t.home, 'sessions', 's1'), 'raw').records[0].rec;
    assert.strictEqual(m[0].detail.fingerprint_before, header.orunmila.code_fingerprint);
  } finally {
    t.done();
  }
});

it('B3: after a restart, a change already recorded is not recorded again', () => {
  const t = setup();
  try {
    t.send();
    fs.writeFileSync(path.join(t.root, '.orunmila', 'byproducts'), 'x/\n');
    t.send();
    assert.strictEqual(t.tampered().length, 1);
    t.again();
    t.send();
    assert.strictEqual(t.tampered().length, 1);
  } finally {
    t.done();
  }
});

it("test 10: with the Sentinel watching, any write in the project's .orunmila/ is a tampered mark at once, and the payload check does not repeat it", async () => {
  const t = setup({ sentinel: true });
  try {
    t.send();
    const dir = path.join(t.root, '.orunmila');
    const seen = (p) => t.tampered().some((m) => m.target.path === path.relative(t.root, p));
    assert.ok(await awaitWatching(dir, seen), 'a probe write in .orunmila/ became a tampered mark');
    const before = t.tampered().length;
    fs.writeFileSync(path.join(dir, 'byproducts'), 'changed/\n');
    for (const end = Date.now() + 5000; Date.now() < end && t.tampered().length === before; ) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(t.tampered().length, before + 1);
    t.send();
    assert.strictEqual(t.tampered().length, before + 1, 'the payload check sees the same fingerprint: no second mark');
  } finally {
    t.done();
  }
});

runAll('tamper');
