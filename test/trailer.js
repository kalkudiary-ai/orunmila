// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/trailer.js — `orunmila trailer` (MR4, LD318; O's approval of R4, LD315): a session's verdict as git trailers on
 * a commit message, so a reviewer sees it in the pull request. A convenience outside the evidence path: it writes only
 * the commit message file it is given, never anything of Orunmila's. Hand-built session logs, made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { trailerLines, appendTrailers } = require('../src/render/trailer');

const SV = { verdict: 'look_at_this', judge: { name: 'babalawo', version: '1.2.0' } };
const FOOT = { raw: { seq: 9, hash: 'sha256:' + 'a'.repeat(64) } };
/** Every file under `dir`, with its bytes, so a test can show nothing in it changed. */
function snapshot(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const p = path.join(rel, name);
    if (fs.statSync(path.join(dir, p)).isDirectory()) out.push(...snapshot(dir, p)); // a walk of its own: Node 18 before 18.17 has no recursive readdir
    else out.push([p, fs.readFileSync(path.join(dir, p), 'utf8')]);
  }
  return out;
}

it('MR4: the trailers say the session, its verdict and the seal; open and not-judged sessions say so, never a verdict', () => {
  assert.deepStrictEqual(trailerLines({ sessionId: 's1', footer: FOOT, sessionVerdict: SV }), ['Orunmila-Session: s1', 'Orunmila-Verdict: look_at_this (babalawo 1.2.0)', `Orunmila-Seal: ${FOOT.raw.hash}`]);
  assert.deepStrictEqual(trailerLines({ sessionId: 's1', footer: FOOT, sessionVerdict: null }), ['Orunmila-Session: s1', 'Orunmila-Verdict: not judged (no verdict log)', `Orunmila-Seal: ${FOOT.raw.hash}`]);
  assert.deepStrictEqual(trailerLines({ sessionId: 's1', footer: null, sessionVerdict: null }), ['Orunmila-Session: s1', 'Orunmila-Verdict: open (not closed out yet)']);
});

it("MR4: appended as the message's trailers: joined to a trailer block, after a blank line otherwise, an old Orunmila trailer replaced, never twice", () => {
  const lines = ['Orunmila-Session: s2', 'Orunmila-Verdict: clean (babalawo 1.2.0)'];
  assert.strictEqual(appendTrailers('Fix the parser\n', lines), 'Fix the parser\n\nOrunmila-Session: s2\nOrunmila-Verdict: clean (babalawo 1.2.0)\n');
  assert.strictEqual(appendTrailers('Fix it\n\nCo-Authored-By: A <a@b.c>\n', lines), 'Fix it\n\nCo-Authored-By: A <a@b.c>\nOrunmila-Session: s2\nOrunmila-Verdict: clean (babalawo 1.2.0)\n');
  const once = appendTrailers('Fix it\n\nOrunmila-Session: s1\nOrunmila-Verdict: violation (babalawo 1.2.0)\n', lines);
  assert.strictEqual(once, 'Fix it\n\nOrunmila-Session: s2\nOrunmila-Verdict: clean (babalawo 1.2.0)\n');
  assert.strictEqual(appendTrailers(once, lines), once, 'appending again changes nothing');
});

it('MR4: `orunmila trailer --session ID` prints them from the session folder; --append writes them into a commit message file; nothing of Orunmila\'s is written', () => {
  const base = tmpDir();
  try {
    const s = makeLog(path.join(base, 'sessions'));
    s.append(M.prompted(0));
    s.append(M.disk(100, 'src/hand.ts'));
    s.append(M.tick(10000));
    const r = replayFolder(s.dir);
    fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu);
    fs.writeFileSync(path.join(s.dir, 'verdict.jsonl'), r.verdict);
    fs.writeFileSync(path.join(s.dir, 'footer.json'), JSON.stringify({ schema_version: 1, record: 'session_footer', session_id: 'ses_replay_test', ...FOOT, odu: null, verdict: null }) + '\n');
    const before = snapshot(s.dir);
    const env = { ORUNMILA_HOME: base };
    const out = run('bin/orunmila.js', { args: ['trailer', '--session', 'ses_replay_test'], env });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    const session = r.verdict.split('\n').slice(0, -1).map((l) => JSON.parse(l)).pop();
    assert.strictEqual(out.stdout, `Orunmila-Session: ses_replay_test\nOrunmila-Verdict: ${session.verdict} (babalawo ${session.judge.version})\nOrunmila-Seal: ${FOOT.raw.hash}\n`);
    const msg = path.join(base, 'COMMIT_EDITMSG');
    fs.writeFileSync(msg, 'Fix the parser\n');
    const a = run('bin/orunmila.js', { args: ['trailer', '--session', 'ses_replay_test', '--append', msg], env });
    assert.strictEqual(a.status, 0, a.stdout + a.stderr);
    assert.ok(fs.readFileSync(msg, 'utf8').startsWith('Fix the parser\n\nOrunmila-Session: ses_replay_test\n'));
    assert.deepStrictEqual(snapshot(s.dir), before, 'the session folder is unchanged');
    assert.strictEqual(run('bin/orunmila.js', { args: ['trailer', '--session', 'ses_missing'], env }).status, 1);
    assert.strictEqual(run('bin/orunmila.js', { args: ['trailer'], env }).status, 2);
    fs.appendFileSync(path.join(s.dir, 'verdict.jsonl'), '{"edited":true}\n');
    assert.strictEqual(run('bin/orunmila.js', { args: ['trailer', '--session', 'ses_replay_test'], env }).status, 1, 'a verdict log that does not verify gives no verdict');
  } finally {
    rmrf(base);
  }
});

runAll('trailer');
