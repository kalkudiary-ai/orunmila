'use strict';

/**
 * test/retention.js — src/opon/ledger/retention.js: old sessions are removed
 * only whole, each removal written first to a hash-chained retention log
 * (brief v4 line 348; test 45; N4, NF7; Phase 1 slice B6, pure part; LD66).
 * Not wired. Fixtures are synthetic.
 */

const { assert, fs, path, ROOT, tmpDir, rmrf, it, runAll } = require('./helpers');
const { createSessionLog } = require('../src/opon/ledger/session-log');
const { verifySession } = require('../src/verify/session');
const { verifyText } = require('../src/verify/chain');
const { compile } = require('../src/verify/schema');
const { retire, plan, readRetentionLog } = require('../src/opon/ledger/retention');

const schemaOf = (f) => compile(JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', f), 'utf8')));

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'marks.json'), 'utf8'));
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'spec', 'session-headers.json'), 'utf8'));
const NOW = '2026-11-18T12:00:00.000Z';

const strip = (r) => {
  const o = JSON.parse(JSON.stringify(r));
  delete o.seq;
  delete o.prev_hash;
  delete o.hash;
  return o;
};

/** A session folder in `sessions`: its header at `start`, then one mark at `last` (when given). */
function makeSession(sessions, id, start, last) {
  const dir = path.join(sessions, id);
  const log = createSessionLog(dir, { ...strip(HEADERS.good.header), session_id: id, observed_at: start });
  if (last) {
    const r = log.append({ ...strip(SPEC.good.tick), session_id: id, observed_at: last });
    assert.strictEqual(r.ok, true, 'the fixture mark is written');
  }
  return dir;
}

function withHome(fn) {
  return () => {
    const base = tmpDir();
    try {
      const sessions = path.join(base, 'sessions');
      fs.mkdirSync(sessions);
      fn({ base, sessions, logFile: path.join(base, 'retention.jsonl') });
    } finally {
      rmrf(base);
    }
  };
}

const lastLine = (dir, name) => {
  const lines = fs.readFileSync(path.join(dir, `${name}.jsonl`), 'utf8').split('\n').slice(0, -1);
  return JSON.parse(lines[lines.length - 1]);
};

it(
  'retire removes the whole session folder and records it first: its id, final hashes and counts (test 45)',
  withHome(({ sessions, logFile }) => {
    const dir = makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    const raw = lastLine(dir, 'raw');
    const q = lastLine(dir, 'quarantine');
    const r = retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'older than 30 days', now: NOW });
    assert.deepStrictEqual(r, { ok: true, seq: 1 });
    assert.strictEqual(fs.existsSync(dir), false, 'the whole folder is gone');
    const text = fs.readFileSync(logFile, 'utf8');
    assert.deepStrictEqual(verifyText(text), { ok: true, lines: 2 });
    const recs = text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.strictEqual(recs[0].record, 'retention_header');
    const rec = recs[1];
    assert.strictEqual(rec.record, 'removed');
    assert.strictEqual(rec.session_id, 'ses_a');
    assert.strictEqual(rec.removed_at, NOW);
    assert.strictEqual(rec.reason, 'older than 30 days');
    assert.deepStrictEqual(rec.raw, { seq: raw.seq, hash: raw.hash });
    assert.deepStrictEqual(rec.quarantine, { seq: q.seq, hash: q.hash });
    assert.deepStrictEqual(rec.counts, { marks: 1, quarantined: 0, kept_files: 0 });
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(logFile).mode & 0o777, 0o600);
  }),
);

it(
  'retire leaves every other session intact, and a second removal extends the same chain (test 45)',
  withHome(({ sessions, logFile }) => {
    makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z');
    const b = makeSession(sessions, 'ses_b', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z');
    makeSession(sessions, 'ses_c', '2026-01-03T00:00:00.000Z');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW }), { ok: true, seq: 1 });
    assert.strictEqual(verifySession(b).ok, true, 'ses_b still verifies');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_c', logFile, reason: 'r', now: NOW }), { ok: true, seq: 2 });
    assert.deepStrictEqual(fs.readdirSync(sessions), ['ses_b']);
    assert.strictEqual(verifySession(b).ok, true);
    const log = readRetentionLog(logFile);
    assert.strictEqual(log.ok, true);
    assert.deepStrictEqual(log.removed.map((x) => x.session_id), ['ses_a', 'ses_c']);
  }),
);

it(
  'a session that does not verify is never removed, and nothing is recorded',
  withHome(({ sessions, logFile }) => {
    const dir = makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    const raw = path.join(dir, 'raw.jsonl');
    fs.writeFileSync(raw, fs.readFileSync(raw, 'utf8').replace('2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.001Z'));
    const r = retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /Record broken/);
    assert.strictEqual(fs.existsSync(raw), true, 'the broken record is kept as evidence');
    assert.strictEqual(fs.existsSync(logFile), false, 'no removal recorded');
  }),
);

it(
  'a removal cut short after its record is finished by the next call, with no second record',
  withHome(({ sessions, logFile }) => {
    const dir = makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    const crash = () => {
      fs.rmSync(path.join(dir, 'raw.jsonl')); // part of the folder goes, then the process dies
      throw new Error('crashed mid-removal');
    };
    assert.throws(() => retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW, remove: crash }), /crashed mid-removal/);
    assert.deepStrictEqual(readRetentionLog(logFile).removed.map((x) => x.session_id), ['ses_a'], 'recorded before anything was removed');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW }), { ok: true, seq: 1, finished: true });
    assert.strictEqual(fs.existsSync(dir), false);
    assert.strictEqual(readRetentionLog(logFile).removed.length, 1);
  }),
);

it(
  'a later removal cut short is recorded first too (the log already exists)',
  withHome(({ sessions, logFile }) => {
    makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z');
    const b = makeSession(sessions, 'ses_b', '2026-01-02T00:00:00.000Z');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW }), { ok: true, seq: 1 });
    const crash = () => {
      throw new Error('crashed mid-removal');
    };
    assert.throws(() => retire({ sessionsDir: sessions, id: 'ses_b', logFile, reason: 'r', now: NOW, remove: crash }), /crashed mid-removal/);
    assert.deepStrictEqual(readRetentionLog(logFile).removed.map((x) => x.session_id), ['ses_a', 'ses_b'], 'recorded before anything was removed');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_b', logFile, reason: 'r', now: NOW }), { ok: true, seq: 2, finished: true });
    assert.strictEqual(fs.existsSync(b), false);
    assert.strictEqual(readRetentionLog(logFile).removed.length, 2, 'the finish wrote no second record');
  }),
);

it(
  'every line retire writes is valid by its schema in spec/: the log header, then each removal (LD77)',
  withHome(({ sessions, logFile }) => {
    makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    makeSession(sessions, 'ses_b', '2026-01-02T00:00:00.000Z');
    for (const id of ['ses_a', 'ses_b']) assert.strictEqual(retire({ sessionsDir: sessions, id, logFile, reason: 'older than 30 days', now: NOW }).ok, true);
    const recs = fs.readFileSync(logFile, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
    assert.deepStrictEqual(recs.map((r) => r.record), ['retention_header', 'removed', 'removed']);
    const header = schemaOf('retention-header.schema.json');
    const removal = schemaOf('retention-removal.schema.json');
    recs.forEach((r, i) => assert.deepStrictEqual((i === 0 ? header : removal)(r), [], `line ${i + 1}`));
  }),
);

it(
  'a new session under an id removed before is not taken for a cut-short removal',
  withHome(({ sessions, logFile }) => {
    makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW }), { ok: true, seq: 1 });
    const again = makeSession(sessions, 'ses_a', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:01.000Z');
    const raw = path.join(again, 'raw.jsonl');
    const text = fs.readFileSync(raw, 'utf8');
    fs.writeFileSync(raw, text.replace('2026-02-01T00:00:01.000Z', '2026-02-01T00:00:01.001Z'));
    const r = retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW });
    assert.strictEqual(r.ok, false, 'a broken folder that is not the recorded session is refused, not finished');
    assert.match(r.reason, /Record broken/);
    assert.strictEqual(fs.existsSync(raw), true);
    fs.writeFileSync(raw, text);
    assert.deepStrictEqual(retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW }), { ok: true, seq: 2 }, 'intact, it gets its own record');
    const log = readRetentionLog(logFile);
    assert.notStrictEqual(log.removed[0].header, log.removed[1].header);
    assert.strictEqual(fs.existsSync(again), false);
  }),
);

it(
  'retire refuses an unsafe id, a missing session and a symlinked folder, and records nothing',
  withHome(({ base, sessions, logFile }) => {
    const elsewhere = makeSession(base, 'ses_x', '2026-01-01T00:00:00.000Z');
    fs.symlinkSync(elsewhere, path.join(sessions, 'ses_link'));
    assert.throws(() => retire({ sessionsDir: sessions, id: '../ses_x', logFile, reason: 'r', now: NOW }), /unsafe session id/);
    const missing = retire({ sessionsDir: sessions, id: 'ses_none', logFile, reason: 'r', now: NOW });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.reason, /no session folder/);
    const link = retire({ sessionsDir: sessions, id: 'ses_link', logFile, reason: 'r', now: NOW });
    assert.strictEqual(link.ok, false);
    assert.match(link.reason, /symbolic link/);
    assert.strictEqual(verifySession(elsewhere).ok, true, 'the target of the link is untouched');
    assert.strictEqual(fs.existsSync(logFile), false);
  }),
);

it(
  'a retention log whose chain is broken is never extended',
  withHome(({ sessions, logFile }) => {
    makeSession(sessions, 'ses_a', '2026-01-01T00:00:00.000Z');
    makeSession(sessions, 'ses_b', '2026-01-01T00:00:00.000Z');
    retire({ sessionsDir: sessions, id: 'ses_a', logFile, reason: 'r', now: NOW });
    fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').replace('ses_a', 'ses_z'));
    assert.strictEqual(readRetentionLog(logFile).ok, false);
    assert.throws(() => retire({ sessionsDir: sessions, id: 'ses_b', logFile, reason: 'r', now: NOW }), /retention log .* broken/);
    assert.strictEqual(fs.existsSync(path.join(sessions, 'ses_b')), true);
  }),
);

it(
  'plan names, sorted, the sessions whose last record is older than the setting; never a newer one',
  withHome(({ sessions }) => {
    makeSession(sessions, 'ses_old', '2026-09-01T00:00:00.000Z', '2026-10-18T11:59:59.999Z');
    makeSession(sessions, 'ses_edge', '2026-10-18T12:00:00.000Z');
    makeSession(sessions, 'ses_new', '2026-09-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z');
    makeSession(sessions, 'ses_aold', '2026-01-01T00:00:00.000Z');
    fs.mkdirSync(path.join(sessions, 'not_a_session'));
    assert.deepStrictEqual(plan({ sessionsDir: sessions, keepDays: 31, now: NOW }), ['ses_aold', 'ses_old']);
  }),
);

it('plan refuses a setting that is not a whole number of days, at least 1', () => {
  for (const keepDays of [0, -1, 1.5, '30', undefined]) {
    assert.throws(() => plan({ sessionsDir: '/nowhere', keepDays, now: NOW }), /keepDays/);
  }
});

runAll('retention');
