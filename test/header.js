'use strict';

/**
 * test/header.js — the session header builder (Phase 1 slice A10; brief v3
 * lines 266, 282, 337, 339, 343; ledger A3 / NF41; test 35's seed). Built over
 * a throwaway project; nothing here reads this machine's real settings.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const { buildHeader, codeFingerprint, hooksReportFrom, configFromHeader, DEFAULT_CONFIG } = require('../src/opon/intake/header');
const { compile } = require('../src/verify/schema');
const { createSessionLog } = require('../src/opon/ledger/session-log');
const { testCommandFrom } = require('../src/opon/intake/test-command');
const { readRegular } = require('../src/opon/intake/regular-file');

const checkHeader = compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'session-header.schema.json'), 'utf8')));
const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

function project() {
  const root = fs.realpathSync(tmpDir());
  fs.mkdirSync(path.join(root, '.orunmila'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(root, 'code', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'rules'), 'rule 1\n');
  fs.writeFileSync(path.join(root, '.orunmila', 'laws.json'), '{"laws":[]}\n');
  fs.writeFileSync(path.join(root, 'canon.json'), '{"laws":[{"id":"x"}]}\n');
  fs.writeFileSync(path.join(root, 'code', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, 'code', 'sub', 'b.js'), 'b');
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "/x/src/capture/claude-code/pre-tool-use.js"' }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/x/src/capture/claude-code/post-tool-use.js"' }] }],
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/x/src/capture/claude-code/stop.js"' }] }],
    },
  };
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(settings));
  return root;
}

function opts(root, over = {}) {
  return {
    sessionId: 'ses_hdr_1',
    root,
    agent: { name: 'claude-code', version: null },
    orunmilaVersion: '0.3.0-dev',
    codeRoot: path.join(root, 'code'),
    lawPacks: { canon: path.join(root, 'canon.json'), project: path.join(root, '.orunmila', 'laws.json') },
    hookSettings: [path.join(root, '.claude', 'settings.local.json')],
    observedAt: '2026-11-16T12:00:00.000Z',
    monoNs: 123,
    ...over,
  };
}

const withProject = (fn) => () => {
  const root = project();
  try {
    fn(root);
  } finally {
    rmrf(root);
  }
};

it(
  'a built header is a valid session header, and starts a session log',
  withProject((root) => {
    const h = buildHeader(opts(root));
    const sealed = { ...h, seq: 0, prev_hash: null, hash: 'sha256:' + '0'.repeat(64) };
    assert.deepStrictEqual(checkHeader(sealed), []);
    assert.doesNotThrow(() => createSessionLog(path.join(root, 'log'), h));
    assert.strictEqual(h.project_root, root);
    assert.deepStrictEqual(h.config, DEFAULT_CONFIG);
    assert.deepStrictEqual([DEFAULT_CONFIG.quiet_window_ms, DEFAULT_CONFIG.ceiling_ms, DEFAULT_CONFIG.lag_grace_ms], [1500, 30000, 3000]);
  }),
);

it(
  'frozen files are fingerprinted as they were at session start; an absent one is null',
  withProject((root) => {
    const h = buildHeader(opts(root));
    assert.strictEqual(h.frozen.rules, sha('rule 1\n'));
    assert.strictEqual(h.frozen.byproducts, null);
    assert.strictEqual(h.frozen.ignore, null);
    assert.strictEqual(h.frozen.law_packs.canon, sha('{"laws":[{"id":"x"}]}\n'));
    assert.strictEqual(h.frozen.hook_settings[path.join(root, '.claude', 'settings.local.json')], sha(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'))));
  }),
);

// buildHeader in a child with a deadline, so a read that blocks fails this test
// instead of hanging the suite (the mutation gate's runSuite has no timeout).
const HEADER = path.join(__dirname, '..', 'src', 'opon', 'intake', 'header.js');
const CHILD = 'const h = require(process.argv[1]).buildHeader(JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify(h));';

it(
  'NF83: a frozen file that is not a regular file (a FIFO, a device, a folder) is never read: its fingerprint is null and the header still builds',
  withProject((root) => {
    const dot = path.join(root, '.orunmila');
    const settings = path.join(root, '.claude', 'settings.local.json');
    const fifoSettings = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.join(dot, 'byproducts'));
    const fifos = process.platform !== 'win32'; // no mkfifo on Windows; the folder case still runs there
    if (fifos) {
      fs.rmSync(path.join(dot, 'rules'));
      fs.rmSync(path.join(root, 'canon.json'));
      for (const p of [path.join(dot, 'rules'), path.join(root, 'canon.json'), fifoSettings]) execFileSync('mkfifo', [p]);
      fs.symlinkSync('/dev/null', path.join(dot, 'ignore')); // a character device: reads empty, never blocks
    }
    const r = spawnSync(process.execPath, ['-e', CHILD, HEADER, JSON.stringify(opts(root, { hookSettings: [fifoSettings, settings] }))], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.signal, null, `buildHeader did not return within 10 s (killed by ${r.signal})`);
    assert.strictEqual(r.status, 0, r.stderr);
    const h = JSON.parse(r.stdout);
    assert.strictEqual(h.frozen.byproducts, null, 'a folder');
    if (fifos) {
      assert.strictEqual(h.frozen.rules, null, 'a FIFO at .orunmila/rules');
      assert.strictEqual(h.frozen.ignore, null, 'a device (/dev/null) at .orunmila/ignore');
      assert.strictEqual(h.frozen.law_packs.canon, null, 'a FIFO as a law pack');
      assert.strictEqual(h.frozen.hook_settings[fifoSettings], null, 'a FIFO as a hook settings file');
    }
    assert.strictEqual(h.frozen.law_packs.project, sha('{"laws":[]}\n'), 'a regular file beside them is still read');
    assert.strictEqual(h.frozen.hook_settings[settings], sha(fs.readFileSync(settings)));
    assert.deepStrictEqual(h.hooks_report, { before: ['Write', 'Edit', 'MultiEdit'], after: ['*'] }, "the regular settings file's hooks are still reported");
  }),
);

it(
  'NF83: readRegular closes every file it opens, whatever it finds there',
  withProject((root) => {
    if (process.platform === 'win32') return; // /dev/fd lists open descriptors on macOS and Linux only
    const dot = path.join(root, '.orunmila');
    fs.mkdirSync(path.join(dot, 'byproducts'));
    // no FIFO here: this runs in the suite's own process, and a blocking open would hang it
    const open = () => fs.readdirSync('/dev/fd').length;
    const before = open();
    for (let i = 0; i < 20; i++) for (const f of ['rules', 'byproducts', 'absent']) readRegular(path.join(dot, f));
    assert.strictEqual(open(), before);
    assert.strictEqual(readRegular(path.join(dot, 'rules')).toString(), 'rule 1\n');
  }),
);

it(
  'A10\'s failing test: a changed law pack gives a different header fingerprint',
  withProject((root) => {
    const before = buildHeader(opts(root));
    fs.writeFileSync(path.join(root, 'canon.json'), '{"laws":[{"id":"x","enabled":false}]}\n');
    const after = buildHeader(opts(root));
    assert.notStrictEqual(after.frozen.law_packs.canon, before.frozen.law_packs.canon);
    assert.strictEqual(after.frozen.rules, before.frozen.rules);
  }),
);

it(
  "NF41: Orunmila's own code is fingerprinted; any change to a file under the code root changes it, the order files are found in does not",
  withProject((root) => {
    const code = path.join(root, 'code');
    const a = codeFingerprint(code);
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(a));
    assert.strictEqual(codeFingerprint(code), a);
    fs.writeFileSync(path.join(code, 'sub', 'b.js'), 'b2');
    assert.notStrictEqual(codeFingerprint(code), a);
    fs.writeFileSync(path.join(code, 'sub', 'b.js'), 'b');
    fs.renameSync(path.join(code, 'sub', 'b.js'), path.join(code, 'sub', 'c.js'));
    assert.notStrictEqual(codeFingerprint(code), a, 'a rename is a change');
    assert.strictEqual(buildHeader(opts(root)).orunmila.code_fingerprint, codeFingerprint(code));
  }),
);

it(
  "line 337: which tool calls the hooks report before and after they run, read from the agent's own hook settings",
  withProject((root) => {
    const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(hooksReportFrom([s]), { before: ['Write', 'Edit', 'MultiEdit'], after: ['*'] });
    assert.deepStrictEqual(hooksReportFrom([{}]), { before: [], after: [] });
    assert.deepStrictEqual(buildHeader(opts(root)).hooks_report, { before: ['Write', 'Edit', 'MultiEdit'], after: ['*'] });
  }),
);

it(
  "B8: the header freezes the project's test command and its scripts block (LD70); none found is null, and the header is still valid",
  withProject((root) => {
    const none = buildHeader(opts(root));
    assert.deepStrictEqual(none.test_command, { text: null, source: null, scripts_fingerprint: null });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test/all.js' } }));
    const h = buildHeader(opts(root));
    assert.deepStrictEqual(h.test_command, testCommandFrom(root));
    assert.strictEqual(h.test_command.text, 'node test/all.js');
    const sealed = { ...h, seq: 0, prev_hash: null, hash: 'sha256:' + '0'.repeat(64) };
    assert.deepStrictEqual(checkHeader(sealed), []);
    const { test_command: _gone, ...without } = sealed;
    assert.deepStrictEqual(checkHeader(without).map((e) => `${e.path} ${e.keyword}`), ['/test_command required'], 'a header without it is refused');
  }),
);

it(
  "A1a: with byproducts on, the header carries .orunmila/byproducts' list as config.byproducts, from the same bytes as its frozen fingerprint; none is []; off, nothing changes",
  withProject((root) => {
    const file = path.join(root, '.orunmila', 'byproducts');
    const text = '# build output\ndist/\n\n  coverage/  \n.cache\n';
    fs.writeFileSync(file, text);
    const h = buildHeader(opts(root, { byproducts: true }));
    assert.deepStrictEqual(h.config.byproducts, ['dist/', 'coverage/', '.cache'], 'one entry per line; blank lines and # comments left out');
    assert.strictEqual(h.frozen.byproducts, sha(text));
    const sealed = { ...h, seq: 0, prev_hash: null, hash: 'sha256:' + '0'.repeat(64) };
    assert.deepStrictEqual(checkHeader(sealed), []);
    assert.deepStrictEqual(checkHeader({ ...sealed, config: { ...sealed.config, byproducts: [1] } }).map((e) => `${e.path} ${e.keyword}`), ['/config/byproducts/0 type']);
    const off = buildHeader(opts(root));
    assert.strictEqual('byproducts' in off.config, false, 'off: the header is as before');
    assert.strictEqual(off.frozen.byproducts, sha(text));
    fs.rmSync(file);
    assert.deepStrictEqual(buildHeader(opts(root, { byproducts: true })).config.byproducts, [], 'no file: no byproducts, known');
    fs.mkdirSync(file);
    const folder = buildHeader(opts(root, { byproducts: true }));
    assert.deepStrictEqual([folder.frozen.byproducts, folder.config.byproducts], [null, []], 'not a regular file (NF83): read as none, as its fingerprint is');
  }),
);

it(
  "test 35's seed: replay reads configuration from the header, never from today's settings",
  withProject((root) => {
    const h = buildHeader(opts(root, { config: { quiet_window_ms: 900 } }));
    assert.strictEqual(h.config.quiet_window_ms, 900);
    assert.strictEqual(h.config.ceiling_ms, 30000);
    const saved = DEFAULT_CONFIG.quiet_window_ms;
    try {
      DEFAULT_CONFIG.quiet_window_ms = 1; // today's settings change after the session
      assert.strictEqual(configFromHeader(h).quiet_window_ms, 900);
    } finally {
      DEFAULT_CONFIG.quiet_window_ms = saved;
    }
    assert.throws(() => configFromHeader({ ...h, config: undefined }), /config/);
  }),
);

runAll('header');
