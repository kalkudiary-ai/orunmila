// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/dashboard.js — DOC3 (LD340; LD320's owed item; CLAUDE.md close-out items 5 and 6): the dashboard is brought up to
 * date with the rest of the tool. Each session card and the session page it serves give the witness gap (MR3, LD316)
 * when the session has an odù log, and the cards use HTML1's neutral words (no "fabricated", no "silently ignored").
 * A throwaway home: one session's event log and turn report, and an odù log replayed from a hand-built raw log.
 */

const http = require('http');
const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, sleep, it, runAll } = require('./helpers');
const { makeLog, M, as } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');

const SID = 'ab12cd34-0000-4000-8000-000000000001';
const get = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => resolve({ status: res.statusCode, body }));
}).on('error', reject));

function home(base) {
  const h = path.join(base, 'home');
  fs.mkdirSync(path.join(h, 'reports', SID), { recursive: true });
  fs.writeFileSync(path.join(h, 'events.jsonl'), JSON.stringify({ session_id: SID, turn_id: 't1', type: 'user_prompt', ts: '2026-11-26T10:00:00.000Z', text: 'go', agent: 'claude-code' }) + '\n');
  // PG1: scored the old way (3 of 4 claims verified, the dropped part and the untracked write not scored) this read
  // "75% Trustworthy"; the trail page's header says "Untracked writes: investigate".
  fs.writeFileSync(path.join(h, 'reports', SID, 't1.json'), JSON.stringify({ summary: { verified: 3, phantom: 1, silently_dropped: 1, untracked_writes: 1 } }));
  const s = makeLog(path.join(h, 'sessions'), {}, { sessionId: SID });
  for (const m of [M.prompted(0), M.edited(100, 'e1', 'src/a.ts'), M.disk(150, 'src/a.ts'), M.disk(200, 'src/hand.ts'), M.turnEnded(300), M.tick(20000)]) s.append(as(SID, m));
  fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), replayFolder(s.dir).odu);
  return h;
}

it('DOC3 (LD340): the dashboard\'s cards and session page give the witness gap, in neutral words', async () => {
  const base = tmpDir();
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'dashboard.js')], { env: { ...process.env, ORUNMILA_HOME: home(base), PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !/:(\d+)/.test(out.replace('http://', '')); i++) await sleep(50);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('What changed on disk: 2 changes.'), 'the card gives the witness gap');
    assert.ok(!/fabricated|silently ignored/.test(page.body), 'neutral words');
    const session = await get(port, `/session/${SID}`);
    assert.strictEqual(session.status, 200);
    assert.ok(session.body.includes('What changed on disk: 2 changes.'), 'the session page gives it too, as orunmila trail does');
  } finally {
    child.kill('SIGKILL');
    rmrf(base);
  }
});

it("PG1 (F33, F34, F37): the dashboard's card uses the trail page's header words and the judge's verdict, never \"Trustworthy\"; its score tooltip says what the code scores; no claim to check every claim", async () => {
  const base = tmpDir();
  const h = home(base);
  // The judge's verdict log beside the odù log, as the intake writes it at a closeout with the judge on.
  const { sessionFolderName } = require('../src/opon/intake/paths');
  const dir = path.join(h, 'sessions', sessionFolderName(SID));
  const { judge } = require('../src/babalawo');
  const raw = require('../src/verify/session').checkLog(dir, 'raw');
  const j = judge({ header: raw.records[0].rec, oduText: fs.readFileSync(path.join(dir, 'odu.jsonl'), 'utf8') });
  assert.ok(j.ok, j.words);
  fs.writeFileSync(path.join(dir, 'verdict.jsonl'), j.text);
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'dashboard.js')], { env: { ...process.env, ORUNMILA_HOME: h, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !/:(\d+)/.test(out.replace('http://', '')); i++) await sleep(50);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
    const page = (await get(port, '/')).body;
    assert.ok(!/Trustworthy|Low trust/.test(page), 'no trust word of its own');
    assert.ok(page.includes('Untracked writes: investigate'), "the trail page's header words for an untracked write");
    assert.ok(/The Babaláwo&#39;s verdict on this session&#39;s whole record: (Violation|Look at this|Clean|Incomplete)/.test(page), 'the judge\'s verdict on the card');
    assert.ok(!page.includes('phantom/dropped score 0'), 'the tooltip no longer says dropped parts are scored');
    assert.ok(page.includes('dropped parts of the request are not scored'), 'it says what the code does');
    assert.ok(!page.includes('checks every claim'), 'no claim to check every claim');
    assert.ok(page.includes('(this check is often wrong)') && !page.includes('with no evidence and not mentioned again'), 'the dropped-part check is marked noisy, as everywhere else (LD302)');
    assert.ok(!/s-reliability" style="color:var\(--green\)/.test(page), 'the score is not green beside an untracked write');
    const session = (await get(port, `/session/${SID}`)).body;
    assert.ok(session.includes('The Babaláwo&#39;s verdict on this session&#39;s whole record'), 'the session page gives it too, as orunmila trail does');
  } finally {
    child.kill('SIGKILL');
    rmrf(base);
  }
});

runAll('dashboard');
