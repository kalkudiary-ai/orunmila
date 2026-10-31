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

// --- legacy (pre-0.2.2) log: warn, then let the user redact or delete -------------

const PROMPT = 'src/capture/claude-code/user-prompt-submit.js';
const CLI = 'bin/orunmila.js';
const OLD_KEY = SECRETS.github_token;

function promptPayload(sessionId) {
  return JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
}

/** A data dir as 0.2.1 left it: unredacted log, sidecar and report, no log-state.json. */
function legacyHome() {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, 'events.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', session_id: 'old', type: 'command_run', command: `GH=${OLD_KEY} gh pr list` }) +
      '\n' +
      `{"half-written": "${OLD_KEY}\n`
  );
  fs.mkdirSync(path.join(home, 'output', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'output', 'old', 'c1.txt'), `token ${OLD_KEY}\n`);
  fs.mkdirSync(path.join(home, 'reports', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'reports', 'old', 't1.json'), JSON.stringify({ claims: [{ text: `used ${OLD_KEY}` }] }));
  return home;
}

function warningsIn(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((o) => o.systemMessage);
}

it('a fresh install is not legacy and its prompt hook prints nothing', () => {
  const home = tmpHome();
  const r = run(PROMPT, { input: promptPayload('s-fresh'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'log-state.json'), 'utf8'));
  assert.strictEqual(state.legacy_unredacted, false);
  rmrf(home);
});

it('a pre-0.2.2 log makes the Claude Code prompt hook warn once per session, without blocking', () => {
  const home = legacyHome();
  const env = { ORUNMILA_HOME: home };
  const first = run(PROMPT, { input: promptPayload('s-a'), env });
  assert.strictEqual(first.status, 0);
  const w = warningsIn(first.stdout);
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].systemMessage.includes('orunmila log redact'));
  assert.strictEqual(w[0].decision, undefined, 'the warning must never block');
  assert.strictEqual(warningsIn(run(PROMPT, { input: promptPayload('s-a'), env }).stdout).length, 0, 'second prompt, same session');
  assert.strictEqual(warningsIn(run(PROMPT, { input: promptPayload('s-b'), env }).stdout).length, 1, 'new session warns again');
  rmrf(home);
});

it('other agents never get the warning on hook stdout (status carries it instead)', () => {
  const home = legacyHome();
  const r = run('src/capture/connector.js', { args: ['cursor', 'prompt'], input: promptPayload('s-c'), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(warningsIn(r.stdout).length, 0);
  rmrf(home);
});

it('orunmila status shows the warning while the old log is unredacted', () => {
  const home = legacyHome();
  const r = run(CLI, { args: ['status'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('written before 0.2.2'), r.stdout);
  rmrf(home);
});

it('orunmila log redact scrubs the log, half-written lines, sidecars and reports, and clears the warning', () => {
  const home = legacyHome();
  const env = { ORUNMILA_HOME: home };
  run(CLI, { args: ['status'], env }); // first 0.2.2 run records the legacy state
  const r = run(CLI, { args: ['log', 'redact'], env });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const rel of ['events.jsonl', 'output/old/c1.txt', 'reports/old/t1.json']) {
    const text = fs.readFileSync(path.join(home, rel), 'utf8');
    assert.ok(!text.includes(OLD_KEY), `${rel} still holds the key`);
  }
  const lines = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, 'no event line lost');
  assert.deepStrictEqual(JSON.parse(lines[0]).redactions, ['github_token']);
  assert.strictEqual(modeOf(path.join(home, 'events.jsonl')), 0o600);
  assert.ok(!run(CLI, { args: ['status'], env }).stdout.includes('written before 0.2.2'));
  assert.strictEqual(warningsIn(run(PROMPT, { input: promptPayload('s-d'), env }).stdout).length, 0);
  rmrf(home);
});

it('orunmila log delete lists and refuses without --yes, then deletes and keeps laws.json', () => {
  const home = legacyHome();
  const env = { ORUNMILA_HOME: home };
  fs.writeFileSync(path.join(home, 'laws.json'), '{"laws":[]}');
  const dry = run(CLI, { args: ['log', 'delete'], env });
  assert.strictEqual(dry.status, 1);
  assert.ok(dry.stdout.includes('events.jsonl'));
  assert.ok(fs.existsSync(path.join(home, 'events.jsonl')), 'nothing deleted without --yes');
  const r = run(CLI, { args: ['log', 'delete', '--yes'], env });
  assert.strictEqual(r.status, 0);
  for (const rel of ['events.jsonl', 'output', 'reports']) assert.ok(!fs.existsSync(path.join(home, rel)), rel);
  assert.ok(fs.existsSync(path.join(home, 'laws.json')));
  assert.ok(!run(CLI, { args: ['status'], env }).stdout.includes('written before 0.2.2'));
  rmrf(home);
});

it('orunmila log with no subcommand prints usage and exits 1', () => {
  const home = tmpHome();
  const r = run(CLI, { args: ['log'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('orunmila log redact'));
  rmrf(home);
});

runAll('secure (0.2.2: permissions + redaction + legacy log)');
