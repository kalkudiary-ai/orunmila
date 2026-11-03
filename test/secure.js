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

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { redactString, redactEvent, PEM_TAIL_MAX, PEM_LINE_MAX, COUNT_WORDS } = require('../src/store/secrets');

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

it('an existing world-readable log, laws.json, last-turn report and log state are tightened to 0600 on the next hook run', () => {
  const home = tmpHome();
  const files = {
    'events.jsonl': '{"type":"old"}\n',
    'laws.json': '{"laws":[]}',
    'last-turn-report.txt': 'old report\n',
    'log-state.json': '{"schema_version":1,"legacy_unredacted":false}',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), text);
    fs.chmodSync(path.join(home, name), 0o644);
  }
  run(POST, { input: bashPayload('s-perm2', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  for (const name of Object.keys(files)) assert.strictEqual(modeOf(path.join(home, name)), 0o600, name);
  rmrf(home);
});

it('existing world-readable data subfolders are tightened to 0700', () => {
  const home = tmpHome();
  const dirs = ['output', 'cache', 'reports', 'laws-state', 'archive', 'warned'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(home, d));
    fs.chmodSync(path.join(home, d), 0o755);
  }
  run(POST, { input: bashPayload('s-perm3', 'ls', 'x'), env: { ORUNMILA_HOME: home } });
  for (const d of dirs) assert.strictEqual(modeOf(path.join(home, d)), 0o700, d);
  rmrf(home);
});

it('the event log, log state, last-turn report and command sidecar a hook cycle creates are owner-only (0600)', () => {
  const home = tmpHome();
  const env = { ORUNMILA_HOME: home };
  run(PROMPT, { input: promptPayload('s-files'), env });
  // Checked now: any later hook process would tighten it and hide a wrong mode.
  assert.strictEqual(modeOf(path.join(home, 'log-state.json')), 0o600, 'log-state.json after the first hook');
  run(POST, { input: bashPayload('s-files', 'ls', 'y'.repeat(2500)), env });
  run('src/capture/claude-code/stop.js', { input: JSON.stringify({ session_id: 's-files', claim: 'done' }), env });
  const [cmd] = readEvents(home).filter((e) => e.type === 'command_run');
  for (const p of [path.join(home, 'events.jsonl'), path.join(home, 'log-state.json'), path.join(home, 'last-turn-report.txt'), cmd.output_path]) {
    assert.ok(fs.existsSync(p), `${path.relative(home, p)} was not created`);
    assert.strictEqual(modeOf(p), 0o600, path.relative(home, p));
  }
  rmrf(home);
});

it('the default ~/.orunmila of an existing install is tightened to 0700', () => {
  const fakeHome = tmpDir();
  const data = path.join(fakeHome, '.orunmila');
  fs.mkdirSync(data);
  fs.chmodSync(data, 0o755);
  // An empty ORUNMILA_HOME means "not set", so the data dir is $HOME/.orunmila.
  run(POST, { input: bashPayload('s-default', 'ls', 'x'), env: { ORUNMILA_HOME: '', HOME: fakeHome } });
  assert.ok(fs.existsSync(path.join(data, 'events.jsonl')), 'the hook did not use $HOME/.orunmila');
  assert.strictEqual(modeOf(data), 0o700);
  rmrf(fakeHome);
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

// A cut-off key (no END line) is bounded by size, not by what its lines look
// like. Fixture key lines all start with QUJD, so a leak is a count of QUJD.
const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----';
const PEM_END = '-----END PRIVATE KEY-----';
const keyLine = (i) => 'QUJD' + String(i).padStart(4, '0') + 'x'.repeat(56);
const keyBody = (n, nl = '\n', indent = '') => Array.from({ length: n }, (_, i) => nl + indent + keyLine(i)).join('');
const leakedLines = (text) => text.split('QUJD').length - 1;

it('an unterminated PEM header removes its key and at most PEM_TAIL_MAX characters plus the rest of that line', () => {
  const tail = '\n' + 'plain text line\n'.repeat(12500);
  const input = PEM_BEGIN + '\nMIIEvQ' + 'g'.repeat(58) + '\nAB12cd==' + tail;
  const r = redactString(input);
  assert.ok(!r.text.includes('MIIEvQ') && !r.text.includes('AB12cd'), 'key body leaked');
  assert.ok(r.text.startsWith('[REDACTED:private_key]\nplain text line\n'), r.text.slice(0, 60));
  assert.ok(input.length - r.text.length <= PEM_BEGIN.length + PEM_TAIL_MAX + PEM_LINE_MAX, `removed ${input.length - r.text.length} chars`);
  assert.deepStrictEqual(r.kinds, ['private_key']);
});

it('a cut-off key is removed whatever its lines look like', () => {
  const cases = {
    indent2: 'key: |\n  ' + PEM_BEGIN + keyBody(5, '\n', '  ') + '\nnext: 1',
    indent8_yaml: 'stringData:\n  tls.key: |\n        ' + PEM_BEGIN + keyBody(5, '\n', '        ') + '\n',
    tab: '\t' + PEM_BEGIN + keyBody(5, '\n', '\t'),
    trailing_space: PEM_BEGIN + keyBody(5).split('\n').join(' \n').slice(1) + ' ',
    space_joined: 'PRIVATE_KEY="' + PEM_BEGIN + ' ' + keyLine(0) + ' ' + keyLine(1) + ' ' + keyLine(2),
    crlf: PEM_BEGIN + keyBody(5, '\r\n') + '\r\nafter',
    json: '{"k":"' + PEM_BEGIN + keyBody(5, '\\n'),
    json_crlf: '{"k":"' + PEM_BEGIN + keyBody(5, '\\r\\n'),
    double_escaped: '"' + PEM_BEGIN + keyBody(5, '\\\\n'),
    diff_context_then_added: ' ' + PEM_BEGIN + keyBody(3, '\n', ' ') + '\n+  ' + keyLine(9),
    encrypted_pkcs1:
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n' + keyBody(5) + '\nafter',
  };
  for (const [name, s] of Object.entries(cases)) {
    const r = redactString(s);
    assert.strictEqual(leakedLines(r.text), 0, `${name}: ${leakedLines(r.text)} key lines leaked`);
    assert.ok(r.kinds.includes('private_key'), name);
  }
});

it('a cut-off key the size of an RSA-16384 key, indented, diff-prefixed, CRLF and escaped twice, is removed whole', () => {
  const lines = Array.from({ length: 180 }, (_, i) => '+        QUJD' + String(i).padStart(4, '0') + 'y'.repeat(62));
  const s = JSON.stringify(JSON.stringify('+        ' + PEM_BEGIN + '\r\n' + lines.join('\r\n') + '\r\n')).slice(2, -2) + 'tail';
  const r = redactString(s);
  assert.strictEqual(leakedLines(r.text), 0, `${leakedLines(r.text)} key lines leaked`);
  assert.ok(s.length > 15000 && s.length < PEM_TAIL_MAX, `fixture is ${s.length} chars, not between 15000 and PEM_TAIL_MAX`);
});

it('a cut-off key does not run on to the END line of a later key, and text after that key is kept', () => {
  const pem = (n) => `${PEM_BEGIN}\nMIIEvQ${'k'.repeat(n)}`;
  const r = redactString(`${pem(30)}\nkept between\n${pem(40)}\n${PEM_END}\nkept after`);
  assert.ok(!r.text.includes('kkk'), r.text);
  assert.strictEqual(r.text.split('[REDACTED:private_key]').length - 1, 2, r.text);
  assert.ok(r.text.endsWith('\nkept after'), r.text);
});

it('text beyond PEM_TAIL_MAX plus one line after an unterminated header is untouched, even in a one-line file', () => {
  const input = PEM_BEGIN + '\nhello\nworld\n' + 'plain text line\n'.repeat(2000);
  const r = redactString(input);
  assert.ok(r.text.endsWith(input.slice(PEM_BEGIN.length + PEM_TAIL_MAX + PEM_LINE_MAX)), 'tail beyond the bound was changed');
  const oneLine = PEM_BEGIN + 'a'.repeat(1e6);
  const removed = oneLine.length - redactString(oneLine).text.length;
  assert.ok(removed <= PEM_BEGIN.length + PEM_TAIL_MAX + PEM_LINE_MAX, `one-line file lost ${removed} chars`);
});

it('the limits table in SECURITY.md states the PEM bounds the code uses', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  const row = doc.split('\n').find((l) => l.startsWith('| A PEM header with no END line'));
  assert.ok(row, 'no PEM header row in the SECURITY.md limits table');
  assert.ok(row.includes(`next ${PEM_TAIL_MAX} characters`) && row.includes(`at most ${PEM_LINE_MAX} more`), row);
  const longer = doc.split('\n').find((l) => l.startsWith('| A cut-off key longer than'));
  assert.ok(longer && longer.includes(`longer than ${PEM_TAIL_MAX} characters`), String(longer));
  const counts = doc.split('\n').find((l) => l.startsWith('| A bare number under a count word'));
  assert.ok(counts && counts.includes(`count word: ${COUNT_WORDS.join(', ')} |`), String(counts));
});

// Regression guard, not a test of this fix: it passes on every version so far.
it('a complete JSON-escaped key (a service-account file) is removed whole and the JSON after it is kept', () => {
  const whole = redactString('"-----BEGIN PRIVATE KEY-----\\nMIIEvQ' + 'j'.repeat(58) + '\\n-----END PRIVATE KEY-----\\n", "x": 1');
  assert.strictEqual(whole.text, '"[REDACTED:private_key]\\n", "x": 1');
});

it('PEM redaction stays linear: 50k cut headers and a header before 20 MB finish in under 3 s', () => {
  const start = Date.now();
  redactString((PEM_BEGIN + '\nQUJDxxxx\n').repeat(50000));
  redactString(PEM_BEGIN + '\nQUJD\n' + 'plain text line\n'.repeat(1300000));
  redactString(PEM_BEGIN + '\n' + 'A'.repeat(20e6) + '!');
  assert.ok(Date.now() - start < 3000, `${Date.now() - start} ms`);
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

it('a bare number is kept only under a count word; numeric keys, tokens and passwords are still removed', () => {
  const counts = [
    'MAX_TOKEN_COUNT=100000000',
    'TOKEN_LIMIT: 100_000_000,',
    'export API_KEY_TTL=86400000',
    'TOKEN_TTL=3600000;',
    'MAX_TOKEN_COUNT="100000000"',
    'PASSWORD_MAX_AGE=86400000',
    'SECRET_ROTATION_DAYS=10000000',
    'TOKEN_TIMEOUT_MS=30000000',
    'MAX_TOKENS: 100000000',
    'TOKEN_CACHE_SECONDS=86400000',
    'TOKEN_SIZE=12345678',
    'API_KEY_LEN=12345678',
  ];
  for (const s of counts) {
    const r = redactString(s);
    assert.strictEqual(r.text, s, `changed: ${s}`);
    assert.deepStrictEqual(r.kinds, []);
  }
  for (const name of ['ACCESS_KEY', 'PRIVATE_KEY', 'OTP_TOKEN', 'API_KEY', 'DB_PASSWORD', 'APP_SECRET', 'TOKEN_MAXWELL', 'MSG_TOKEN', 'IMAGE_TOKEN']) {
    assert.strictEqual(redactString(`${name}=123456789012`).text, `${name}=[REDACTED:secret_assignment]`, name);
  }
  assert.strictEqual(redactString('API_TOKEN=12345678abc').text, 'API_TOKEN=[REDACTED:secret_assignment]');
  assert.strictEqual(redactString('TOKEN=1e100000000').text, 'TOKEN=[REDACTED:secret_assignment]');
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

it('an indented key in long command output never reaches the 2000-char excerpt or the sidecar', () => {
  const home = tmpHome();
  // kubectl get secret -o yaml: the excerpt cuts this key off before its END line.
  let yaml = 'apiVersion: v1\nkind: Secret\nstringData:\n  tls.key: |\n    ' + PEM_BEGIN + '\n';
  for (let i = 0; i < 60; i++) yaml += '    ' + keyLine(i) + '\n';
  yaml += '    ' + PEM_END + '\n';
  const r = run(POST, { input: bashPayload('s-yaml', 'kubectl get secret tls -o yaml', yaml), env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  const [ev] = readEvents(home);
  assert.strictEqual(leakedLines(ev.stdout_excerpt), 0, `${leakedLines(ev.stdout_excerpt)} key lines in the excerpt`);
  assert.ok(ev.output_path, 'long output should go to a sidecar');
  assert.strictEqual(leakedLines(fs.readFileSync(ev.output_path, 'utf8')), 0, 'key lines in the sidecar');
  assert.ok(ev.redactions.includes('private_key'));
  rmrf(home);
});

// Output in which the 2000-char excerpt cut falls inside a complete key. Text
// after the key's END line must survive into the excerpt: the whole output is
// redacted first, so the key is removed whole and never seen cut off.
const KEY_ACROSS_THE_CUT = 'x'.repeat(1900) + '\n' + PEM_BEGIN + keyBody(30) + '\n' + PEM_END + '\nafter-the-key\n';

it('a complete key across the excerpt cut is removed whole, and the text after it is kept', () => {
  const home = tmpHome();
  run(POST, { input: bashPayload('s-cut', 'cat server.pem', KEY_ACROSS_THE_CUT), env: { ORUNMILA_HOME: home } });
  const [ev] = readEvents(home);
  assert.strictEqual(leakedLines(ev.stdout_excerpt), 0, 'key lines in the excerpt');
  assert.ok(ev.stdout_excerpt.includes('after-the-key'), 'the excerpt lost the text after the key');
  assert.deepStrictEqual(ev.redactions, ['private_key']);
  rmrf(home);
});

it('a complete key across the tool-result excerpt cut is removed whole, and the text after it is kept', () => {
  const home = tmpHome();
  const payload = JSON.stringify({ session_id: 's-tool', tool_name: 'mcp__files__read', tool_input: { path: 'server.pem' }, tool_response: KEY_ACROSS_THE_CUT });
  run(POST, { input: payload, env: { ORUNMILA_HOME: home, ORUNMILA_CAPTURE_TOOL_RESULTS: '1' } });
  const [ev] = readEvents(home);
  assert.strictEqual(leakedLines(ev.result_excerpt), 0, 'key lines in the result excerpt');
  assert.ok(ev.result_excerpt.includes('after-the-key'), 'the result excerpt lost the text after the key');
  assert.deepStrictEqual(ev.redactions, ['private_key']);
  rmrf(home);
});

it('a Sentinel diff of an edit inside a key file holds no key lines', async () => {
  const { startSentinel } = require('../src/capture/fs-sentinel');
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'server.key');
  const lines = Array.from({ length: 40 }, (_, i) => keyLine(i));
  const write = () => fs.writeFileSync(file, PEM_BEGIN + '\n' + lines.join('\n') + '\n' + PEM_END + '\n');
  write();
  const sentinel = startSentinel({ root: work, log: () => {} });
  try {
    await sleep(300);
    lines[20] = keyLine(99); // an edit in the middle: its diff hunk shows neither BEGIN nor END
    write();
    await sleep(1500);
  } finally {
    sentinel.stop();
  }
  const ev = readEvents(home).find((e) => e.source === 'fs-sentinel' && e.type === 'file_write');
  assert.ok(ev, 'the Sentinel recorded no write');
  assert.strictEqual(leakedLines(ev.diff), 0, `${leakedLines(ev.diff)} key lines in the Sentinel diff`);
  assert.ok((ev.redactions || []).includes('private_key'), 'redactions should name private_key');
  rmrf(home);
  rmrf(work);
});

const PRE = 'src/capture/claude-code/pre-tool-use.js';

it('a file holding a secret is redacted in its before-snapshot, and the diff shows only the real change', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'config.env');
  const key = SECRETS.github_token;
  const env = { ORUNMILA_HOME: home };
  const payload = (hook) => JSON.stringify({ session_id: 's-snap', hook_event_name: hook, tool_name: 'Edit', tool_input: { file_path: file } });
  fs.writeFileSync(file, `GH=${key}\nmode=old\n`);
  assert.strictEqual(run(PRE, { input: payload('PreToolUse'), env }).status, 0);
  const slot = path.join(home, 'cache', 's-snap', encodeURIComponent(file) + '.before');
  assert.ok(!fs.readFileSync(slot, 'utf8').includes(key), 'key leaked into the before-snapshot');
  assert.strictEqual(modeOf(slot), 0o600, 'before-snapshot mode');
  fs.writeFileSync(file, `GH=${key}\nmode=new\n`);
  assert.strictEqual(run(POST, { input: payload('PostToolUse'), env }).status, 0);
  const ev = readEvents(home).find((e) => e.type === 'file_write');
  assert.ok(!JSON.stringify(ev).includes(key), 'key leaked into the event');
  // Redacting only one side would show the untouched secret line as changed.
  const changed = ev.diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  assert.deepStrictEqual(changed, ['-mode=old', '+mode=new'], ev.diff);
  assert.deepStrictEqual(ev.redactions, ['github_token']);
  assert.ok(!fs.existsSync(slot), 'the before-snapshot outlived the edit');
  rmrf(home);
  rmrf(work);
});

it('the Witness column of the limits table matches what each witness records for a secret only in the before-state', async () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  const section = doc.split('### Known limits')[1].split('\n## ')[0];
  const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Case |'));
  assert.ok(rows.length >= 10, `${rows.length} limits rows`);
  for (const r of rows) {
    const cells = r.split(' | ');
    assert.strictEqual(cells.length, 3, r);
    assert.ok(['Glove', 'Sentinel', 'Glove and Sentinel', 'Storage'].includes(cells[1]), `witness "${cells[1]}" in: ${r}`);
  }
  const row = rows.find((l) => l.startsWith('| A secret the edit removed'));
  assert.ok(row, 'no before-state row in the SECURITY.md limits table');
  assert.strictEqual(row.split(' | ')[1], 'Glove', row);
  assert.ok(row.includes('does not list that kind') && row.includes('except `url_credentials`'), row);

  // The Glove: the snapshot is redacted at preTool, so postTool cannot find the kind again.
  const glove = (body) => {
    const home = tmpHome();
    const work = tmpDir();
    const file = path.join(work, 'config.env');
    const env = { ORUNMILA_HOME: home };
    const payload = (hook) => JSON.stringify({ session_id: 's-only-before', hook_event_name: hook, tool_name: 'Edit', tool_input: { file_path: file } });
    fs.writeFileSync(file, `${body}\nmode=old\n`);
    run(PRE, { input: payload('PreToolUse'), env });
    fs.writeFileSync(file, 'mode=new\n');
    run(POST, { input: payload('PostToolUse'), env });
    const ev = readEvents(home).find((e) => e.type === 'file_write');
    rmrf(home);
    rmrf(work);
    return ev;
  };
  const gh = glove(`GH=${SECRETS.github_token}`);
  assert.ok(gh && gh.diff.includes('[REDACTED:github_token]'), 'the Glove diff should show the removed secret as redacted');
  assert.strictEqual(gh.redactions, undefined, 'the Glove listed a kind found only in the before-state');
  const url = glove('DB=https://bob:hunter2pass@db.example.com/x');
  assert.deepStrictEqual(url.redactions, ['url_credentials'], 'url_credentials is the stated exception');

  // The Sentinel keeps the raw before-state in memory, so it does list the kind.
  const { startSentinel } = require('../src/capture/fs-sentinel');
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'config.env');
  fs.writeFileSync(file, `GH=${SECRETS.github_token}\nmode=old\n`);
  const sentinel = startSentinel({ root: work, log: () => {} });
  try {
    await sleep(300);
    fs.writeFileSync(file, 'mode=new\n');
    await sleep(1500);
  } finally {
    sentinel.stop();
  }
  const ev = readEvents(home).find((e) => e.source === 'fs-sentinel' && e.type === 'file_write');
  assert.ok(ev, 'the Sentinel recorded no write');
  assert.ok(ev.diff.includes('[REDACTED:github_token]'), ev.diff);
  assert.deepStrictEqual(ev.redactions, ['github_token'], 'the Sentinel should list the before-state kind');
  rmrf(home);
  rmrf(work);
});

it('each of the seven places that creates a folder under the data dir creates it owner-only (0700)', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'f.txt');
  const env = { ORUNMILA_HOME: home };
  const hook = (sid, name, payload) => run(`src/capture/claude-code/${name}`, { input: JSON.stringify({ session_id: sid, ...payload }), env });
  // Checked right after the hook that creates each folder, naming the code
  // responsible, so undoing any one of the seven modes fails here by name.
  const created = (rel, by) => {
    assert.ok(fs.existsSync(path.join(home, rel)), `${rel} was not created by ${by}`);
    assert.strictEqual(modeOf(path.join(home, rel)), 0o700, `${rel}, created by ${by}, is not owner-only`);
  };
  // handlePreTool never touches turnstate, so in a session whose first hook is
  // PreToolUse it is ensureCacheSlot that creates cache/<sid>.
  hook('s-pre', 'pre-tool-use.js', { tool_name: 'Write', tool_input: { file_path: file } });
  created('cache/s-pre', 'core.js ensureCacheSlot');
  hook('s-dirs', 'user-prompt-submit.js', { prompt: 'go' });
  created('cache/s-dirs', 'turnstate.js statePath');
  hook('s-dirs', 'post-tool-use.js', { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'ls' }, tool_response: { stdout: 'y'.repeat(2500) } });
  created('output/s-dirs', 'core.js writeOutputSidecar');
  hook('s-dirs', 'stop.js', { claim: 'done' });
  created('reports/s-dirs', 'reconcile/index.js reportPath');
  hook('s-dirs', 'law-gate.js', { claim: 'done' });
  created('laws-state/s-dirs', 'laws/gate.js statePath');
  run('bin/orunmila.js', { args: ['rescore'], env });
  const stamps = fs.readdirSync(path.join(home, 'archive'));
  assert.strictEqual(stamps.length, 1, `one archive stamp, got ${stamps.join(',')}`);
  created(`archive/${stamps[0]}`, 'rescore.js newArchiveDir');
  created(`archive/${stamps[0]}/s-dirs`, 'rescore.js rescoreAll');
  // And nothing else under the data dir is open either.
  const dirs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        dirs.push(path.join(d, e.name));
        walk(path.join(d, e.name));
      }
    }
  })(home);
  const open = dirs.filter((d) => modeOf(d) !== 0o700).map((d) => `${path.relative(home, d)} ${modeOf(d).toString(8)}`);
  assert.deepStrictEqual(open, [], `not owner-only: ${open.join(', ')}`);
  rmrf(home);
  rmrf(work);
});

// --- legacy (pre-0.2.2) log: warn, then let the user redact or delete -------------

const PROMPT = 'src/capture/claude-code/user-prompt-submit.js';
const CLI = 'bin/orunmila.js';
const OLD_KEY = SECRETS.github_token;

function promptPayload(sessionId) {
  return JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
}

/** A data dir as 0.2.1 left it: unredacted log, sidecar, report, last-turn report, law state, snapshot and archive, no log-state.json. */
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
  fs.writeFileSync(path.join(home, 'last-turn-report.txt'), `claim: used ${OLD_KEY}\n`);
  fs.mkdirSync(path.join(home, 'laws-state', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'laws-state', 'old', 't1.json'), JSON.stringify({ blocks: 1, claim: `used ${OLD_KEY}` }));
  fs.mkdirSync(path.join(home, 'cache', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'old', 'f.before'), `GH=${OLD_KEY}\n`);
  fs.mkdirSync(path.join(home, 'archive', '20260101-000000', 'old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'archive', '20260101-000000', 'old', 't1.json'), JSON.stringify({ claims: [{ text: `used ${OLD_KEY}` }] }));
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
  assert.strictEqual(modeOf(path.join(home, 'warned')), 0o700, 'warned/ mode');
  assert.strictEqual(modeOf(path.join(home, 'warned', 's-a')), 0o600, 'warned/ marker mode');
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

it('orunmila log redact scrubs the log, half-written lines, sidecars, reports, snapshots and archives, and clears the warning', () => {
  const home = legacyHome();
  const env = { ORUNMILA_HOME: home };
  run(CLI, { args: ['status'], env }); // first 0.2.2 run records the legacy state
  const r = run(CLI, { args: ['log', 'redact'], env });
  assert.strictEqual(r.status, 0, r.stderr);
  // Checked now: any later Orunmila process would tighten it and hide a wrong mode.
  assert.strictEqual(modeOf(path.join(home, 'last-turn-report.txt')), 0o600, 'a file log redact rewrote is not owner-only');
  for (const rel of ['events.jsonl', 'output/old/c1.txt', 'reports/old/t1.json', 'last-turn-report.txt', 'laws-state/old/t1.json', 'cache/old/f.before', 'archive/20260101-000000/old/t1.json']) {
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
  for (const rel of ['events.jsonl', 'last-turn-report.txt', 'output', 'reports', 'laws-state', 'cache', 'archive']) assert.ok(!fs.existsSync(path.join(home, rel)), rel);
  assert.ok(fs.existsSync(path.join(home, 'laws.json')));
  assert.ok(!run(CLI, { args: ['status'], env }).stdout.includes('written before 0.2.2'));
  rmrf(home);
});

it('orunmila prune rewrites the log owner-only (0600)', () => {
  const home = tmpHome();
  const ev = (sid) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', session_id: sid, type: 'user_prompt', text: 'hi' });
  fs.writeFileSync(path.join(home, 'events.jsonl'), ev('old') + '\n' + ev('new') + '\n');
  const r = run(CLI, { args: ['prune', '--keep', '1'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readEvents(home).map((e) => e.session_id), ['new'], 'prune did not rewrite the log');
  assert.strictEqual(modeOf(path.join(home, 'events.jsonl')), 0o600);
  rmrf(home);
});

it('orunmila laws --init writes your laws.json owner-only (0600), and a project laws file with the default mode', () => {
  const home = tmpHome();
  const r = run(CLI, { args: ['laws', '--init'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Wrote '), r.stdout);
  assert.strictEqual(modeOf(path.join(home, 'laws.json')), 0o600);
  // A project file is repo config: it gets whatever mode a new file gets here.
  const proj = tmpDir();
  fs.writeFileSync(path.join(proj, 'probe'), '');
  const p = run(CLI, { args: ['laws', '--init', '--project', '--root', proj], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.strictEqual(modeOf(path.join(proj, '.orunmila', 'laws.json')), modeOf(path.join(proj, 'probe')), 'project laws file mode');
  rmrf(home);
  rmrf(proj);
});

it('orunmila log with no subcommand prints usage and exits 1', () => {
  const home = tmpHome();
  const r = run(CLI, { args: ['log'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('orunmila log redact'));
  rmrf(home);
});

// --- dashboard: loopback only -----------------------------------------------------

const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

function get(host, port, urlPath = '/api/sessions') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ error: err.code }));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}

function externalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

it('the dashboard answers on 127.0.0.1 and refuses connections on the network address', async () => {
  const home = tmpHome();
  const hostile = '<img src=x onerror=alert(1)>';
  fs.writeFileSync(
    path.join(home, 'events.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), session_id: hostile, agent: 'claude-code', type: 'user_prompt', text: 'hi' }) + '\n'
  );
  // The dashboard lists only sessions with at least one reported claim.
  fs.mkdirSync(path.join(home, 'reports', hostile), { recursive: true });
  fs.writeFileSync(path.join(home, 'reports', hostile, 't1.json'), JSON.stringify({ summary: { verified: 1 } }));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn('node', [path.join(__dirname, '..', 'bin', 'dashboard.js')], {
    env: { ...process.env, ORUNMILA_HOME: home, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('dashboard did not start')), 5000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('dashboard')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    assert.strictEqual((await get('127.0.0.1', port)).status, 200);
    const page = await get('127.0.0.1', port, '/');
    assert.ok(page.body.includes('&lt;img src=x'), 'session id should appear, escaped');
    assert.ok(!page.body.includes(hostile), 'a session id reached the page as live HTML');
    const ext = externalIPv4();
    if (ext) {
      const r = await get(ext, port);
      assert.ok(r.error, `dashboard reachable on ${ext}: ${JSON.stringify(r)}`);
    } else {
      console.log('      (no external IPv4 interface on this machine: network-side check not run)');
    }
  } finally {
    child.kill();
    rmrf(home);
  }
});

runAll('secure (0.2.2: permissions + redaction + legacy log + dashboard)');
