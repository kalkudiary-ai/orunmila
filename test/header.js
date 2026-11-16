'use strict';

/**
 * test/header.js — the session header builder (Phase 1 slice A10; brief v3
 * lines 266, 282, 337, 339, 343; ledger A3 / NF41; test 35's seed). Built over
 * a throwaway project; nothing here reads this machine's real settings.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { buildHeader, codeFingerprint, hooksReportFrom, configFromHeader, DEFAULT_CONFIG } = require('../src/opon/intake/header');
const { compile } = require('../src/verify/schema');
const { createSessionLog } = require('../src/opon/ledger/session-log');

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
