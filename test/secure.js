'use strict';

/**
 * test/secure.js
 *
 * The 0.2.2 security patch: owner-only permissions on everything Orunmila
 * stores, and capture-time secret redaction. Asserts on what actually lands on
 * disk (mode bits, file bytes), not on what the code intends, because a
 * permission or redaction bug is silent everywhere else in the suite.
 * Hook-level checks run as child processes so each one gets a fresh process
 * (the data dir is secured once per process).
 *
 * Run: node test/secure.js
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { redactString, redactEvent } = require('../src/store/secrets');

const POST = 'src/capture/claude-code/post-tool-use.js';

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

function bashPayload(sessionId, command, stdout) {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_sec_1',
    tool_input: { command },
    tool_response: { stdout, stderr: '' },
  });
}

function readEvents(home) {
  return fs
    .readFileSync(path.join(home, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- permissions -------------------------------------------------------------

it('a new log is created owner-only (0600)', () => {
  const home = tmpHome();
  const r = run(POST, { input: bashPayload('s-perm', 'ls', 'a\nb'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(modeOf(path.join(home, 'events.jsonl')), 0o600);
  rmrf(home);
});

it('an existing world-readable log is tightened to 0600 on the next hook run', () => {
  const home = tmpHome();
  const log = path.join(home, 'events.jsonl');
  fs.writeFileSync(log, '{"type":"old"}\n');
  fs.chmodSync(log, 0o644);
  run(POST, { input: bashPayload('s-perm2', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(modeOf(log), 0o600);
  rmrf(home);
});

it('existing world-readable data subfolders are tightened to 0700', () => {
  const home = tmpHome();
  for (const d of ['output', 'cache', 'reports']) {
    fs.mkdirSync(path.join(home, d));
    fs.chmodSync(path.join(home, d), 0o755);
  }
  run(POST, { input: bashPayload('s-perm3', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  for (const d of ['output', 'cache', 'reports']) assert.strictEqual(modeOf(path.join(home, d)), 0o700, d);
  rmrf(home);
});

it('a data dir Orunmila creates itself is 0700', () => {
  const parent = tmpDir();
  const home = path.join(parent, 'fresh-home');
  run(POST, { input: bashPayload('s-perm4', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(modeOf(home), 0o700);
  rmrf(parent);
});

it('a pre-existing custom ORUNMILA_HOME is not chmodded (it may be shared)', () => {
  const home = tmpHome();
  fs.chmodSync(home, 0o755);
  run(POST, { input: bashPayload('s-perm5', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(modeOf(home), 0o755);
  assert.strictEqual(modeOf(path.join(home, 'events.jsonl')), 0o600);
  rmrf(home);
});

// --- redaction: patterns -----------------------------------------------------

const SECRETS = {
  aws_access_key: 'AKIAIOSFODNN7EXAMPLE',
  github_token: 'ghp_' + 'a'.repeat(36),
  anthropic_key: 'sk-ant-api03-' + 'b'.repeat(40),
  openai_key: 'sk-proj-' + 'c'.repeat(40),
  stripe_key: 'sk_live_' + 'd'.repeat(24),
  slack_token: 'xoxb-1234567890-abcdefghij',
  google_api_key: 'AIza' + 'e'.repeat(35),
  npm_token: 'npm_' + 'f'.repeat(36),
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
};

for (const [kind, secret] of Object.entries(SECRETS)) {
  it(`redacts a ${kind}`, () => {
    const r = redactString(`run with ${secret} now`);
    assert.ok(!r.text.includes(secret), r.text);
    assert.ok(r.text.includes(`[REDACTED:${kind}]`), r.text);
    assert.deepStrictEqual(r.kinds, [kind]);
  });
}

it('redacts a PEM private key block, armour and body', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow' + 'x'.repeat(60) + '\n-----END RSA PRIVATE KEY-----';
  const r = redactString(`+${pem}\n+next line`);
  assert.ok(!r.text.includes('MIIEow'), r.text);
  assert.ok(r.text.includes('+next line'));
});

it('keeps the readable prefix of bearer tokens, URL credentials and env assignments', () => {
  const r = redactString(
    'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://bob:hunter2pass@db.example.com/x && export DB_PASSWORD=correcthorsebattery'
  );
  assert.ok(r.text.includes('Authorization: Bearer [REDACTED:bearer_token]'), r.text);
  assert.ok(r.text.includes('https://bob:[REDACTED:url_credentials]@db.example.com/x'), r.text);
  assert.ok(r.text.includes('DB_PASSWORD=[REDACTED:secret_assignment]'), r.text);
  assert.ok(!/abcdefghijklmnop1234|hunter2pass|correcthorsebattery/.test(r.text));
});

it('leaves non-secrets alone: hashes, code, env references, short values', () => {
  const benign = [
    'sha256 9f2c0d3e51aa' + '0'.repeat(52),
    'const password = input()',
    'API_KEY = process.env.API_KEY',
    'export GITHUB_TOKEN=$GITHUB_TOKEN',
    'TOKEN=short',
    'node src/capture/claude-code/post-tool-use.js',
    'session 1b171541-ea5f-440a-a537-cf054fb209bd call toolu_01VcKMETiK6LckM4UwrnrS8P',
    'git commit -m "fix(laws): see Tests pass."',
  ];
  for (const s of benign) {
    const r = redactString(s);
    assert.strictEqual(r.text, s, `changed: ${s}`);
    assert.deepStrictEqual(r.kinds, []);
  }
});

it('redactEvent walks nested objects and records kinds, never values', () => {
  const ev = redactEvent({ type: 'tool_call', input: { env: { A: SECRETS.github_token }, list: [SECRETS.aws_access_key] } });
  assert.ok(!JSON.stringify(ev).includes(SECRETS.github_token));
  assert.ok(!JSON.stringify(ev).includes(SECRETS.aws_access_key));
  assert.deepStrictEqual(ev.redactions, ['aws_access_key', 'github_token']);
});

it('an event with nothing to redact gains no redactions field', () => {
  const ev = redactEvent({ type: 'command_run', command: 'npm test', exit_code: null });
  assert.strictEqual(ev.redactions, undefined);
});

// --- redaction: end to end through a real hook ----------------------------------

it('a command containing an API key never reaches the log, excerpt or sidecar', () => {
  const home = tmpHome();
  const key = SECRETS.anthropic_key;
  const longOut = `token is ${key}\n` + 'y'.repeat(2500);
  const r = run(POST, { input: bashPayload('s-red', `ANTHROPIC_API_KEY=${key} node app.js`, longOut), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  const raw = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(key), 'key leaked into events.jsonl');
  const [ev] = readEvents(home);
  assert.ok(ev.redactions.includes('anthropic_key'));
  assert.ok(ev.output_path, 'long output should go to a sidecar');
  const side = fs.readFileSync(ev.output_path, 'utf8');
  assert.ok(!side.includes(key), 'key leaked into the sidecar');
  assert.strictEqual(modeOf(ev.output_path), 0o600);
  rmrf(home);
});

runAll('secure (0.2.2: permissions + redaction)');
