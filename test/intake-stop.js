'use strict';

/**
 * test/intake-stop.js — a stop of the intake that no one asked for (Phase 6 slice TE2, LD283; Phase 5 plan section 4;
 * guarantee 9 as O amended it, LD257). `orunmila intake stop` asks over the intake's own socket; a signal that comes
 * without that ask (SIGTERM, SIGINT, SIGHUP) is recorded in every held session that has not ended as a `tampered` mark
 * (what: intake_stop, with the signal), then the closing note, and the intake exits 1, so its launch agent restarts it
 * (KeepAlive SuccessfulExit false). The restart's gap names the stop. The judge reads it as R26, Look at this: a
 * person, a logout or shutdown, or the agent may have sent the signal, and Orunmila does not know which. A real intake
 * process in a throwaway home and project; hand-built payloads in the shapes Claude Code sends.
 */

const net = require('net');
const { spawn } = require('child_process');
const { assert, fs, path, ROOT, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { intakePaths, statusOf } = require('../src/opon/intake/server');
const { verifySession } = require('../src/verify/session');
const { replayFolder } = require('../src/opon/replay');
const { buildReport } = require('../src/babalawo/report');
const { compile, closed } = require('../src/verify/schema');
const { makeLog, M } = require('./helpers-opon');

const markSchema = compile(closed(JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'mark.schema.json'), 'utf8'))));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);

function send(sock, text) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    c.on('error', reject);
    c.on('close', () => resolve());
    c.on('connect', () => c.end(text));
  });
}
const req = (payload) => JSON.stringify({ op: 'payload', payload }) + '\n';

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return cond();
}

/** `orunmila intake run` as a child of this test: its exit code is the test's to read. */
function runIntake(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'orunmila.js'), 'intake', 'run'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

it('TE2 (LD283): a SIGTERM no one asked for is a tampered mark (intake_stop) before the closing note, the intake exits 1, and the restart gap names the stop; `orunmila intake stop` asks, exits 0 and writes no tampered mark', async () => {
  const base = tmpDir();
  const home = path.join(base, 'h');
  const project = path.join(base, 'p');
  fs.mkdirSync(project, { recursive: true });
  const env = { ORUNMILA_HOME: home, ORUNMILA_INTAKE_PORT: '0' }; // never the real port (LD140)
  const paths = intakePaths(home);
  const sid = 'ses_te2';
  const raw = path.join(home, 'sessions', sid, 'raw.jsonl');
  const p = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  let live = null;
  try {
    live = runIntake(env);
    assert.ok(await until(async () => (await statusOf(paths.sock, 300)) !== null), 'the intake answers');
    await send(paths.sock, req({ ...p, hook_event_name: 'SessionStart', source: 'startup' }) + req({ ...p, hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
    assert.ok(await until(() => lines(raw).some((m) => m.says === 'prompted')), 'the prompt is written');

    live.child.kill('SIGTERM');
    const first = await live.exited;
    assert.strictEqual(first.code, 1, 'a stop no one asked for exits 1, so launchd restarts it');
    const recs = lines(raw);
    const t = recs.findIndex((m) => m.says === 'tampered');
    assert.ok(t > 0, 'a tampered mark');
    const m = recs[t];
    assert.deepStrictEqual([m.source, m.target, m.detail.what, m.detail.signal], ['process', { kind: 'process', name: 'intake' }, 'intake_stop', 'SIGTERM']);
    assert.deepStrictEqual(markSchema(m), [], 'a valid mark naming only fields the spec declares');
    assert.deepStrictEqual([recs[t + 1].says, recs[t + 1].target.name], ['exited', 'intake'], 'the closing note follows it');
    assert.ok(fs.existsSync(path.join(paths.dir, 'last-stop.json')), 'the stop is kept for the next start');

    live = runIntake(env);
    assert.ok(await until(async () => (await statusOf(paths.sock, 300)) !== null), 'the intake answers again');
    const gap = lines(raw).find((x) => x.says === 'gap' && x.detail && x.detail.since);
    assert.ok(gap, 'the restart writes a downtime gap');
    assert.ok(gap.detail.lost.includes('stopped by SIGTERM, which no one asked for through `orunmila intake stop`'), gap.detail.lost);
    assert.ok(!fs.existsSync(path.join(paths.dir, 'last-stop.json')), 'named once, then gone');

    const r = run('bin/orunmila.js', { args: ['intake', 'stop'], env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const second = await live.exited;
    live = null;
    assert.strictEqual(second.code, 0, 'a stop asked for exits 0');
    const after = lines(raw);
    assert.strictEqual(after.filter((x) => x.says === 'tampered').length, 1, 'no tampered mark for the stop asked for');
    const note = after[after.length - 1];
    assert.deepStrictEqual([note.says, note.target.name], ['exited', 'intake']);
    assert.ok(note.detail.reason.includes('asked'), note.detail.reason);
    assert.ok(!fs.existsSync(path.join(paths.dir, 'last-stop.json')), 'a stop asked for is not kept as one no one asked for');
    const v = verifySession(path.join(home, 'sessions', sid));
    assert.ok(v.ok, v.words);
    assert.ok(v.words.includes(`the intake was stopped by SIGTERM, which no one asked for (line ${m.seq + 1} of the raw log)`), v.words);
  } finally {
    if (live) {
      live.child.kill('SIGKILL');
      await live.exited;
    }
    rmrf(base);
  }
});

it('TE2: the judge reads a stop no one asked for as R26, Look at this, and the report names the signal; a foreign sender stays R17, Violation', () => {
  const base = tmpDir();
  try {
    const s = makeLog(base);
    s.append(M.prompted(0));
    const stop = { ...M.tick(100), target: { kind: 'process', name: 'intake' }, says: 'tampered', detail: { what: 'intake_stop', signal: 'SIGHUP' } };
    s.append(stop);
    s.append({ ...M.tick(200), target: { kind: 'process' }, says: 'tampered', detail: { what: 'foreign_sender', received: '{}' } });
    s.append(M.tick(20000));
    const out = replayFolder(s.dir);
    const odus = out.odu.split('\n').slice(0, -1).map((l) => JSON.parse(l));
    const verdicts = out.verdict.split('\n').slice(0, -1).map((l) => JSON.parse(l));
    const of = (pred) => verdicts.find((v) => v.record === 'verdict' && v.odu_id === odus.find((o) => o.record === 'odu' && pred(o)).odu_id);
    const stopped = of((o) => o.action === 'tampered' && o.target.name === 'intake');
    const foreign = of((o) => o.action === 'tampered' && !o.target.name);
    assert.deepStrictEqual([stopped.verdict, stopped.rule], ['look_at_this', 'R26']);
    assert.deepStrictEqual([foreign.verdict, foreign.rule], ['violation', 'R17']);
    const marks = lines(path.join(s.dir, 'raw.jsonl'));
    const rep = buildReport({ header: marks[0], marks: marks.slice(1), odus: odus.slice(1), verdicts });
    const f = rep.findings.find((x) => x.rule === 'R26');
    assert.ok(f && f.sentence.includes('stopped by SIGHUP, which no one asked for through `orunmila intake stop`'), JSON.stringify(rep.findings));
  } finally {
    rmrf(base);
  }
});

runAll('intake-stop');
