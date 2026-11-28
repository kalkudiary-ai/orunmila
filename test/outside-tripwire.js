// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/outside-tripwire.js — CF4 (LD385): a tripwire on the files outside the watched folders that run code as you,
 * fingerprinted at session start and at the closeout, a change named by its path, never its content. A throwaway
 * folder stands for the home folder; the platform is passed in, so each OS's list is checked on every OS.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { tripwirePaths, tripwireFingerprints, tripwireChanges } = require('../src/capture/outside-tripwire');
const { createRouter } = require('../src/opon/intake/router');
const { verifySessionLog } = require('../src/opon/ledger/session-log');

const KEY = Buffer.alloc(32, 7);
const slash = (p) => p.split(path.sep).join('/');

it('CF4 (LD385): the files that run code as you, on each OS: shell start-up files, git and ssh config, the agents\' own hook settings, and the start-up folders', () => {
  const home = '/h';
  const rel = (platform, env = {}) => tripwirePaths(home, platform, env).map((e) => `${e.kind} ${e.path.replace(/\\/g, '/').replace('/h/', '')}`);
  const common = ['file .bashrc', 'file .zshrc', 'file .profile', 'file .gitconfig', 'file .ssh/config', 'file .ssh/authorized_keys', 'file .npmrc', 'file .claude/settings.json', 'file .cursor/hooks.json'];
  for (const platform of ['darwin', 'linux', 'win32']) for (const c of common) assert.ok(rel(platform).includes(c), `${platform}: ${c}`);
  assert.ok(rel('darwin').includes('dir Library/LaunchAgents'));
  assert.ok(rel('linux').includes('dir .config/systemd/user') && rel('linux').includes('dir .config/autostart'));
  const win = rel('win32', { APPDATA: '/h/AppData/Roaming' });
  assert.ok(win.includes('dir AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup'), win.join('\n'));
  assert.ok(win.includes('file Documents/PowerShell/Microsoft.PowerShell_profile.ps1'));
  assert.ok(!rel('linux').includes('dir Library/LaunchAgents'), "one OS's start-up folder is not another's");
});

it('CF4: fingerprints are keyed (no fingerprint confirms a guessed secret); a change, a new file, a removed file and a link added to a start-up folder are each named, by path only', () => {
  const home = tmpDir();
  try {
    fs.writeFileSync(path.join(home, '.zshrc'), 'export A=1\n');
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
    const agents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'a.plist'), '<plist/>');
    const list = tripwirePaths(home, 'darwin', {});
    const before = tripwireFingerprints(list, KEY);
    const zsh = slash(path.join(home, '.zshrc'));
    assert.match(before[zsh], /^hmac-sha256:[0-9a-f]{64}$/);
    assert.strictEqual(before[slash(path.join(home, '.bashrc'))], null, 'absent: null');
    assert.deepStrictEqual(tripwireChanges(before, tripwireFingerprints(list, KEY)), [], 'nothing changed');
    fs.appendFileSync(path.join(home, '.zshrc'), 'curl x | sh\n');
    fs.writeFileSync(path.join(home, '.bashrc'), 'x\n');
    fs.rmSync(path.join(home, '.gitconfig'));
    let linked = true;
    try {
      fs.symlinkSync(path.join(home, 'elsewhere.plist'), path.join(agents, 'b.plist'));
    } catch {
      linked = false; // Windows without the right to make links: the folder change is checked by a new file instead
      fs.writeFileSync(path.join(agents, 'b.plist'), '<plist/>');
    }
    const ch = tripwireChanges(before, tripwireFingerprints(list, KEY));
    assert.deepStrictEqual(ch.map((c) => c.path), [zsh, slash(path.join(home, '.bashrc')), slash(path.join(home, '.gitconfig')), slash(agents)].sort(), `link made: ${linked}`);
    const was = ch.find((c) => c.path === slash(path.join(home, '.bashrc')));
    assert.deepStrictEqual([was.fingerprint_before, typeof was.fingerprint], [null, 'string']);
    assert.ok(!JSON.stringify(ch).includes('curl'), 'never the content');
  } finally {
    rmrf(home);
  }
});

it('CF4 at the router: with commandFacts, the header holds the tripwire\'s fingerprints and the closeout names each path that changed, verified intact; without it (the default), neither', () => {
  for (const on of [true, false]) {
    const base = tmpDir();
    try {
      const home = path.join(base, 'home');
      const fakeHome = path.join(base, 'user');
      const project = path.join(base, 'project');
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(fakeHome, { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.zshrc'), 'a\n');
      let mono = 5000n * 1000000n;
      let wall = Date.UTC(2026, 10, 28, 9, 0, 0);
      const clock = () => ({ mono: mono.toString(), wall: new Date(wall).toISOString() });
      const router = createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: KEY, hookSettingsFor: () => [], baseline: true, outsideHome: fakeHome, outsidePlatform: 'linux', ...(on ? { commandFacts: true } : {}) });
      const p = { session_id: 'ses_t1', transcript_path: '/tmp/t.jsonl', cwd: project };
      router.payload({ ...p, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
      fs.appendFileSync(path.join(fakeHome, '.zshrc'), 'b\n');
      router.payload({ ...p, hook_event_name: 'Stop', last_assistant_message: 'Done.' }, { channel: 'command' });
      router.payload({ ...p, hook_event_name: 'SessionEnd', reason: 'exit' }, { channel: 'command' });
      mono += 10000n * 1000000n;
      wall += 10000;
      router.poll();
      const dir = path.join(home, 'sessions', 'ses_t1');
      const recs = fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const zsh = slash(path.join(fs.realpathSync(fakeHome), '.zshrc'));
      const end = recs.find((r) => r.says === 'exited' && r.target && r.target.name === 'closeout');
      assert.ok(end, 'the closeout ran');
      if (on) {
        assert.match(recs[0].tripwire[zsh], /^hmac-sha256:/, 'the header holds the start fingerprints');
        assert.deepStrictEqual(end.detail.outside_changed.map((c) => c.path), [zsh]);
        assert.strictEqual(end.detail.outside_checked, Object.keys(recs[0].tripwire).length);
      } else {
        assert.deepStrictEqual([recs[0].tripwire, end.detail.outside_changed], [undefined, undefined]);
      }
      assert.strictEqual(verifySessionLog(dir).ok, true);
    } finally {
      rmrf(base);
    }
  }
});

runAll('outside-tripwire');
