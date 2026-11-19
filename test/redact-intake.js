'use strict';

/**
 * test/redact-intake.js — redaction at intake (Phase 1 slice A6; brief v3 lines
 * 248-249, 266; tests 33, 54, 58). src/opon/intake/redact.js uses today's
 * src/store/secrets.js patterns unchanged, adds `.env` values held in memory,
 * and keyed fingerprints for files on the redaction list. The session log
 * (A4) runs it on every input and every kept file before writing anything.
 * All keys below are made up for the test; none is real.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const crypto = require('crypto');
const { redactText, redactMark, envValuesFrom, fingerprint, onRedactionList } = require('../src/opon/intake/redact');
const { createSessionLog, verifySessionLog } = require('../src/opon/ledger/session-log');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const strip = (r) => {
  const o = JSON.parse(JSON.stringify(r));
  delete o.seq;
  delete o.prev_hash;
  delete o.hash;
  return o;
};

// Shapes from secrets.js's own patterns; made-up values.
const ANTHROPIC = 'sk-ant-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const GITHUB = 'ghp_' + 'a'.repeat(36);
const ENV_SECRET = 'hunter2-but-longer';

/** Every byte the session folder holds, as one string. */
function folderBytes(dir) {
  let all = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all += fs.readFileSync(p, 'latin1') + '\n';
    }
  };
  walk(dir);
  return all;
}

function withLog(opts, fn) {
  return () => {
    const base = tmpDir();
    const dir = path.join(base, 'ses');
    try {
      fn(createSessionLog(dir, strip(HEADERS.good.header), opts), dir);
    } finally {
      rmrf(base);
    }
  };
}

it('redactText: secrets.js patterns and .env values both become [REDACTED:<kind>]; kinds listed, never values', () => {
  const r = redactText(`curl -H "x-api-key: ${ANTHROPIC}" && echo ${ENV_SECRET}`, [ENV_SECRET]);
  assert.ok(!r.text.includes(ANTHROPIC) && !r.text.includes(ENV_SECRET), r.text);
  assert.ok(r.text.includes('[REDACTED:anthropic_key]') && r.text.includes('[REDACTED:env_value]'), r.text);
  assert.deepStrictEqual(r.kinds, ['anthropic_key', 'env_value']);
  assert.deepStrictEqual(redactText('nothing secret here at all', [ENV_SECRET]), { text: 'nothing secret here at all', kinds: [] });
});

it('LD88: a .env value under 8 characters is used only under a secret name, never a boolean, a count or under 4', () => {
  const env = [
    'A=true',
    'B=short',
    'C=longenough1',
    '# D=commented-out-value',
    'export E="quoted value here"',
    'DB_PASSWORD=pw12x',
    "API_TOKEN='abcd'",
    'db_passwd=zq9z',
    'USE_TOKEN=true',
    'TOKEN_TTL=3600',
    'MAX_TOKENS=4096',
    'SECRET_PIN=123',
    'AUTH_MODE=oauth2',
    'DB_PASSWORD=null',
    'API_TOKEN=None',
  ].join('\n');
  assert.deepStrictEqual(envValuesFrom(env), ['longenough1', 'quoted value here', 'pw12x', 'abcd', 'zq9z']);
});

it('LD88: a short .env value is redacted only as a whole word, none under 4 characters; a long one wherever it occurs', () => {
  const r = redactText('psql -W pw12x; pw12xy xpw12x pw12x_1 pw12x-1 DB_PASSWORD=pw12x', ['pw12x']);
  assert.strictEqual(r.text, 'psql -W [REDACTED:env_value]; pw12xy xpw12x pw12x_1 [REDACTED:env_value]-1 DB_PASSWORD=[REDACTED:env_value]');
  assert.deepStrictEqual(r.kinds, ['env_value']);
  assert.deepStrictEqual(redactText('ab cd abc', ['ab', 'abc']), { text: 'ab cd abc', kinds: [] });
  // An escape in JSON text (\n, \t, é) right before the value is a word boundary too.
  const escaped = '{"cmd": "psql -h db\\npw12x", "p": "Password:\\tpw12x", "u": "\\u00e9pw12x"}';
  assert.strictEqual(redactText(escaped, ['pw12x']).text, escaped.split('pw12x').join('[REDACTED:env_value]'));
  // A value whose edge is not a word character needs no boundary on that side.
  assert.strictEqual(redactText('x-pw1 y pw1#z', ['-pw1', 'pw1#']).text, 'x[REDACTED:env_value] y [REDACTED:env_value]z');
  assert.deepStrictEqual(redactText('xlongenough1x', ['longenough1']), { text: 'x[REDACTED:env_value]x', kinds: ['env_value'] });
});

it("LD91: only JSON's own escapes are a boundary, and a short value needs a letter or digit", () => {
  // \u takes four hex digits, so a hex-only value inside it stays; the same value after it is redacted.
  assert.deepStrictEqual(redactText('{"u": "\\u00e9 00e9"}', ['00e9']), { text: '{"u": "\\u00e9 [REDACTED:env_value]"}', kinds: ['env_value'] });
  // A backslash and a letter that is not a JSON escape is no boundary.
  assert.deepStrictEqual(redactText('dir\\spw12.txt', ['pw12']), { text: 'dir\\spw12.txt', kinds: [] });
  // Each of JSON's letter escapes is one.
  assert.strictEqual(redactText('"\\bpw12x\\fpw12x\\npw12x\\rpw12x\\tpw12x"', ['pw12x']).text, `"${'\\b \\f \\n \\r \\t'.split(' ').map((e) => `${e}[REDACTED:env_value]`).join('')}"`);
  // A short value of non-word characters only would match anywhere; it is not used.
  assert.deepStrictEqual(redactText('a ---- b ------', ['----']), { text: 'a ---- b ------', kinds: [] });
  // A digit is enough: a PIN is still redacted.
  assert.deepStrictEqual(redactText('psql -W 4821 ok', ['4821']), { text: 'psql -W [REDACTED:env_value] ok', kinds: ['env_value'] });
});

it('LD92: an escape is a backslash run of odd length; an escaped backslash starts none, and an escape letter is never part of a value', () => {
  const kept = (text, v) => assert.deepStrictEqual(redactText(text, [v]), { text, kinds: [] }, text);
  const hid = (text, v, want) => assert.deepStrictEqual(redactText(text, [v]), { text: want, kinds: ['env_value'] }, text);
  // \\ is one backslash, so the n after it is a letter of the word npw12x.
  kept('C:\\\\npw12x', 'pw12x');
  kept('C:\\\\u00e9pw12x', 'pw12x');
  // The n of \n belongs to the escape: a newline then 123 is not the value n123.
  kept('line1\\n123', 'n123');
  kept('a\\t0k3', 't0k3');
  kept('a\\u00e9', 'u00e9');
  // A miss inside a longer word does not hide a whole-word occurrence that overlaps it.
  hid('xab-ab-ab', 'ab-ab', 'xab-[REDACTED:env_value]');
  // After an escaped backslash the value is a whole word; three backslashes are \\ then \n.
  hid('C:\\\\n123', 'n123', 'C:\\\\[REDACTED:env_value]');
  hid('C:\\\\pw12x', 'pw12x', 'C:\\\\[REDACTED:env_value]');
  hid('a\\\\\\npw12x', 'pw12x', 'a\\\\\\n[REDACTED:env_value]');
  hid('a\\\\\\u00e9pw12x', 'pw12x', 'a\\\\\\u00e9[REDACTED:env_value]');
});

it(
  'LD88: a short secret from a .env file reaches no file of the session log; the redaction is noted',
  withLog({ envValues: envValuesFrom('DB_PASSWORD=pw12x\n') }, (log, dir) => {
    const m = strip(SPEC.good.hook_exited_fail);
    delete m.detail.output_ref;
    m.target.text = 'PGPASSWORD=pw12x psql -h db';
    m.detail.output_excerpt = 'login as pw12x failed';
    assert.strictEqual(log.append(m).ok, true);
    assert.ok(!folderBytes(dir).includes('pw12x'));
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[1]);
    assert.ok(line.detail.redactions.includes('env_value'), JSON.stringify(line.detail));
  }),
);

it('redactMark walks every string of a mark, notes the kinds in detail.redactions, and keeps earlier notes', () => {
  const m = strip(SPEC.good.hook_called);
  m.detail.tool_input = { headers: { Authorization: `Bearer ${'Z'.repeat(24)}` }, list: [GITHUB] };
  m.detail.redactions = ['jwt'];
  const { mark, kinds } = redactMark(m, []);
  const text = JSON.stringify(mark);
  assert.ok(!text.includes(GITHUB) && !text.includes('Z'.repeat(24)), text);
  assert.deepStrictEqual(kinds, ['bearer_token', 'github_token']);
  assert.deepStrictEqual(mark.detail.redactions, ['bearer_token', 'github_token', 'jwt']);
  assert.ok(!JSON.stringify(m).includes('[REDACTED'), 'the input object is not changed in place');
});

it(
  'test 33: an API key in a command never appears in any file of the session log; the redaction is noted',
  withLog({}, (log, dir) => {
    const m = strip(SPEC.good.hook_exited_fail);
    delete m.detail.output_ref;
    m.target.text = `ANTHROPIC_API_KEY=${ANTHROPIC} npm run deploy`;
    m.detail.output_excerpt = `using key ${ANTHROPIC}`;
    assert.strictEqual(log.append(m).ok, true);
    const bytes = folderBytes(dir);
    assert.ok(!bytes.includes(ANTHROPIC));
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[1]);
    assert.ok(line.detail.redactions.includes('anthropic_key'), JSON.stringify(line.detail));
    assert.strictEqual(verifySessionLog(dir).ok, true);
  }),
);

it(
  'test 58: an MCP tool input holding a key: called mark, key in no file, redaction noted',
  withLog({}, (log, dir) => {
    const m = strip(SPEC.good.hook_called);
    m.detail.tool_input = { query: 'select 1', api_token: GITHUB };
    assert.strictEqual(log.append(m).ok, true);
    assert.ok(!folderBytes(dir).includes(GITHUB));
  }),
);

it(
  'quarantined input is redacted too: a malformed mark holding a key leaves no trace of it',
  withLog({ envValues: [ENV_SECRET] }, (log, dir) => {
    const r = log.append(`{"broken": "${ANTHROPIC} ${ENV_SECRET}"`);
    assert.strictEqual(r.ok, false);
    const r2 = log.append({ ...strip(SPEC.good.hook_started), says: 'edited', note: GITHUB });
    assert.strictEqual(r2.ok, false);
    const bytes = folderBytes(dir);
    for (const s of [ANTHROPIC, ENV_SECRET, GITHUB]) assert.ok(!bytes.includes(s), s);
    const q = fs.readFileSync(path.join(dir, 'quarantine.jsonl'), 'utf8').split('\n').slice(1, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(q[0].redactions, ['anthropic_key', 'env_value']);
    assert.deepStrictEqual(q[1].redactions, ['github_token']);
  }),
);

it(
  'a kept file (a diff, full output) is redacted before it is written, and the mark naming it notes the kinds',
  withLog({ envValues: [ENV_SECRET] }, (log, dir) => {
    const m = strip(SPEC.good.sentinel_modified);
    delete m.detail.diff_ref;
    assert.strictEqual(log.append(m, [{ slot: 'diff_ref', text: `-PASSWORD=${ENV_SECRET}\n+PASSWORD=${ANTHROPIC}\n` }]).ok, true);
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[1]);
    const ref = line.detail.diff_ref;
    const kept = fs.readFileSync(path.join(dir, 'files', ref.slice(7)), 'utf8');
    assert.ok(!kept.includes(ENV_SECRET) && !kept.includes(ANTHROPIC), kept);
    assert.strictEqual(ref, 'sha256:' + crypto.createHash('sha256').update(kept).digest('hex'), 'diff_ref is the plain SHA-256 of the redacted copy');
    assert.deepStrictEqual(line.detail.redactions, ['anthropic_key', 'env_value']);
    assert.ok(!folderBytes(dir).includes(ENV_SECRET) && !folderBytes(dir).includes(ANTHROPIC), 'in no file of the folder');
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    assert.strictEqual(log.append(m, [{ slot: 'diff_ref', text: bin }]).ok, true);
    const bref = JSON.parse(fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[2]).detail.diff_ref;
    assert.ok(fs.readFileSync(path.join(dir, 'files', bref.slice(7))).equals(bin), 'binary content is kept as is');
  }),
);

it('test 54: a file on the redaction list is fingerprinted with a keyed hash; without the key its value cannot be checked', () => {
  const key = crypto.randomBytes(32);
  const content = Buffer.from(`DB_PASS=${ENV_SECRET}\n`);
  assert.strictEqual(onRedactionList('.env'), true);
  assert.strictEqual(onRedactionList('config/.env.production'), true);
  assert.strictEqual(onRedactionList('src/env.js'), false);
  assert.strictEqual(onRedactionList('.envrc'), false);
  const fp = fingerprint('.env', content, key);
  assert.ok(/^hmac-sha256:[0-9a-f]{64}$/.test(fp), fp);
  assert.strictEqual(fp, 'hmac-sha256:' + crypto.createHmac('sha256', key).update(content).digest('hex'));
  assert.notStrictEqual(fp, 'sha256:' + crypto.createHash('sha256').update(content).digest('hex'), 'a guess hashed without the key does not match');
  assert.notStrictEqual(fingerprint('.env', content, crypto.randomBytes(32)), fp, 'another install key gives another fingerprint');
  assert.strictEqual(fingerprint('src/a.js', content, key), 'sha256:' + crypto.createHash('sha256').update(content).digest('hex'));
  assert.throws(() => fingerprint('.env', content, null), /key/);
});

runAll('redact-intake');
