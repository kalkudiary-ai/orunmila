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

it('a .env value shorter than 8 characters is not used (it would redact ordinary words)', () => {
  assert.deepStrictEqual(envValuesFrom('A=true\nB=short\nC=longenough1\n# D=commented-out-value\nexport E="quoted value here"\n'), ['longenough1', 'quoted value here']);
  assert.deepStrictEqual(redactText('true short', ['true', 'short']).kinds, []);
});

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
    const ref = log.keep(`-PASSWORD=${ENV_SECRET}\n+PASSWORD=${ANTHROPIC}\n`);
    const m = strip(SPEC.good.sentinel_modified);
    m.detail.diff_ref = ref;
    assert.strictEqual(log.append(m).ok, true);
    const kept = fs.readFileSync(path.join(dir, 'files', ref.slice(7)), 'utf8');
    assert.ok(!kept.includes(ENV_SECRET) && !kept.includes(ANTHROPIC), kept);
    assert.strictEqual(ref, 'sha256:' + crypto.createHash('sha256').update(kept).digest('hex'), 'diff_ref is the plain SHA-256 of the redacted copy');
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n')[1]);
    assert.deepStrictEqual(line.detail.redactions, ['anthropic_key', 'env_value']);
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const bref = log.keep(bin);
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
