'use strict';

/**
 * test/intake-server.js — the intake server (Phase 1 slice B1e, LD132; brief v4
 * station 1, line 343 one intake per machine; design D-I 4.1, 4.2(b), 4.7;
 * tests 83 and 84 at the server). A real Unix socket in a throwaway home;
 * payloads are hand-built in the shapes Claude Code sends. Nothing here reads
 * recorded data.
 */

const net = require('net');
const { assert, fs, path, tmpDir, rmrf, run, sleep, it, runAll } = require('./helpers');
const { createRouter } = require('../src/opon/intake/router');
const { createServer, intakePaths, statusOf, readInstallKey } = require('../src/opon/intake/server');
const { nowMono } = require('../src/opon/intake/mono');

const SRC = path.join(__dirname, '..', 'src');
const clock = () => ({ mono: nowMono(), wall: new Date().toISOString() });

function routerFor(home, more = {}) {
  return createRouter({ home, clock, checkSender: () => false, codeRoot: SRC, orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], ...more });
}

/** A throwaway home and project; the server, if started, is always stopped. */
function withHome(fn) {
  return async () => {
    const base = tmpDir();
    const home = path.join(base, 'h');
    const project = path.join(base, 'p');
    fs.mkdirSync(project, { recursive: true });
    const servers = [];
    const serve = (opts = {}) => {
      const s = createServer({ home, router: opts.router || routerFor(home, opts.routerOpts), pollMs: 10, ...opts });
      servers.push(s);
      return s;
    };
    try {
      await fn({ home, project, serve, p: intakePaths(home) });
    } finally {
      for (const s of servers) await s.stop('test over');
      rmrf(base);
    }
  };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);
const raw = (home, sid) => lines(path.join(home, 'sessions', sid, 'raw.jsonl'));

function cc(project, sid = 'ses_s1') {
  const base = { session_id: sid, transcript_path: '/tmp/t.jsonl', cwd: project };
  return {
    start: () => ({ ...base, hook_event_name: 'SessionStart', source: 'startup' }),
    prompt: (prompt) => ({ ...base, hook_event_name: 'UserPromptSubmit', prompt }),
  };
}

/** Send raw text over the socket and close; resolves with whatever came back. */
function send(sock, text) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let got = '';
    c.on('data', (d) => (got += d));
    c.on('error', reject);
    c.on('close', () => resolve(got));
    c.on('connect', () => c.end(text));
  });
}
const req = (op, payload) => JSON.stringify(payload === undefined ? { op } : { op, payload }) + '\n';

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

it(
  'B1e: payload lines over the socket reach the session log on channel command, and the sender gets no reply',
  withHome(async ({ home, project, serve, p }) => {
    const r = await serve().start();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const got = await send(p.sock, req('payload', cc(project).start()) + req('payload', cc(project).prompt('hello')));
    assert.strictEqual(got, '', 'a payload line has no reply: the sender never waits (LD122)');
    assert.ok(await until(() => raw(home, 'ses_s1').length === 2), 'the header and one mark');
    const [header, mark] = raw(home, 'ses_s1');
    assert.strictEqual(header.record, 'session_header');
    assert.deepStrictEqual([mark.says, mark.detail.channel, mark.detail.prompt], ['prompted', 'command', 'hello']);
    assert.strictEqual(fs.statSync(path.dirname(p.sock)).mode & 0o777, 0o700, 'the intake folder is private');
  }),
);

it(
  'B1e: status answers with the pid and the sessions held; a second server on the same home refuses while the first lives (line 343)',
  withHome(async ({ project, serve, p }) => {
    assert.strictEqual(await statusOf(p.sock), null, 'no intake yet');
    assert.strictEqual((await serve().start()).ok, true);
    // A SessionStart alone writes no mark, so the engine holds the session from its first mark.
    await send(p.sock, req('payload', cc(project).start()) + req('payload', cc(project).prompt('held now')));
    assert.ok(await until(() => fs.existsSync(p.held) && fs.readFileSync(p.held, 'utf8') === '["ses_s1"]'));
    const st = await statusOf(p.sock);
    assert.deepStrictEqual([st.intake, st.pid, st.held], ['orunmila', process.pid, ['ses_s1']]);
    const second = await serve().start();
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.code, 'running');
    assert.ok(second.reason.includes(String(process.pid)) && second.reason.includes(p.lock), `refused by the lock: ${second.reason}`);
    assert.strictEqual(fs.readFileSync(p.lock, 'utf8').trim(), String(process.pid), "the first server's lock is untouched");
    assert.deepStrictEqual((await statusOf(p.sock)).held, ['ses_s1'], 'the first still serves');
  }),
);

it(
  'test 83 (socket form): a squatter on the socket is recorded, the address is taken back, and the held session\'s downtime gap names the squat',
  withHome(async ({ home, project, serve, p }) => {
    // A session held by an earlier intake that stopped.
    const before = routerFor(home);
    before.payload(cc(project).start(), { channel: 'command' });
    before.payload(cc(project).prompt('one'), { channel: 'command' });
    fs.mkdirSync(path.dirname(p.sock), { recursive: true, mode: 0o700 });
    const squatter = net.createServer((c) => c.end());
    await new Promise((res) => squatter.listen(p.sock, res));
    try {
      const r = await serve({ statusTimeoutMs: 200 }).start();
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.squat, true);
      const errs = lines(p.errors);
      assert.strictEqual(errs.length, 1, JSON.stringify(errs));
      assert.ok(errs[0].reason.startsWith('squat:'), errs[0].reason);
      assert.strictEqual((await statusOf(p.sock)).intake, 'orunmila', 'the address answers as the intake again');
      const gap = raw(home, 'ses_s1').slice(-1)[0];
      assert.strictEqual(gap.says, 'gap');
      assert.ok(gap.detail.lost.includes('another process was listening on the intake\'s socket'), gap.detail.lost);
      assert.deepStrictEqual(gap.detail.sessions, ['ses_s1']);
    } finally {
      squatter.close();
    }
  }),
);

it(
  'B1e: a stale lock (a dead pid) and a socket file with no listener are taken quietly: no squat, no error',
  withHome(async ({ serve, p }) => {
    fs.mkdirSync(path.dirname(p.sock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.lock, '999999999\n');
    const dead = net.createServer();
    await new Promise((res) => dead.listen(p.sock, res));
    await new Promise((res) => dead.close(res));
    fs.writeFileSync(p.sock, ''); // what a crash leaves: the path, nobody listening
    const r = await serve().start();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.squat, false);
    assert.deepStrictEqual(lines(p.errors), []);
    assert.strictEqual(fs.readFileSync(p.lock, 'utf8').trim(), String(process.pid));
  }),
);

it(
  'B1e: a line that is not JSON, or names no known op, goes to the error log redacted, and the connection carries on (N1, LD124)',
  withHome(async ({ home, project, serve, p }) => {
    assert.strictEqual((await serve().start()).ok, true);
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    await send(p.sock, `not json ${token}\n` + req('nope') + req('payload', cc(project).start()) + req('payload', cc(project).prompt('after')));
    assert.ok(await until(() => raw(home, 'ses_s1').length === 2), 'the good lines after the bad still land');
    const errs = lines(p.errors);
    assert.strictEqual(errs.length, 2, JSON.stringify(errs));
    assert.ok(!fs.readFileSync(p.errors, 'utf8').includes(token), 'the token is redacted');
  }),
);

it(
  'B1e: a held session gets ticks while idle, from the server\'s own timer (line 360)',
  withHome(async ({ home, project, serve, p }) => {
    assert.strictEqual((await serve({ routerOpts: { tickMs: 50 } }).start()).ok, true);
    await send(p.sock, req('payload', cc(project).start()) + req('payload', cc(project).prompt('idle next')));
    assert.ok(await until(() => raw(home, 'ses_s1').filter((m) => m.says === 'tick').length >= 2), 'two ticks or more');
  }),
);

it('B1e: the install key is made once, 32 bytes, private, and read back the same', () => {
  const base = tmpDir();
  try {
    const home = path.join(base, 'h');
    const a = readInstallKey(home);
    const b = readInstallKey(home);
    assert.strictEqual(a.length, 32);
    assert.ok(a.equals(b));
    assert.strictEqual(fs.statSync(intakePaths(home).key).mode & 0o777, 0o600);
  } finally {
    rmrf(base);
  }
});

it(
  'B1e CLI: intake start, status and stop; a stop writes the closing note and removes the socket and the lock (LD56)',
  withHome(async ({ home, project, p }) => {
    const env = { ORUNMILA_HOME: home };
    assert.strictEqual(run('bin/orunmila.js', { args: ['intake', 'status'], env }).status, 1, 'not running yet');
    const started = run('bin/orunmila.js', { args: ['intake', 'start'], env });
    assert.strictEqual(started.status, 0, started.stdout + started.stderr);
    try {
      const st = run('bin/orunmila.js', { args: ['intake', 'status'], env });
      assert.strictEqual(st.status, 0, st.stdout + st.stderr);
      await send(p.sock, req('payload', cc(project).start()) + req('payload', cc(project).prompt('then stop')));
      assert.ok(await until(() => raw(home, 'ses_s1').length === 2));
    } finally {
      const stopped = run('bin/orunmila.js', { args: ['intake', 'stop'], env });
      assert.strictEqual(stopped.status, 0, stopped.stdout + stopped.stderr);
    }
    const last = raw(home, 'ses_s1').slice(-1)[0];
    assert.deepStrictEqual([last.says, last.target.name, last.detail.reason], ['exited', 'intake', 'stopped by SIGTERM']);
    assert.ok(!fs.existsSync(p.sock) && !fs.existsSync(p.lock), 'socket and lock removed');
    assert.strictEqual(run('bin/orunmila.js', { args: ['intake', 'stop'], env }).status, 1, 'nothing to stop');
  }),
);

// B1f (LD136): the lock and the install key are placed whole, a dead pid's lock is
// taken only under the takeover lock, and a lock with no pid in it is never dead.

it(
  'B1f: a lock with no pid in it (empty, or not a number) is never taken as dead: the start refuses and the lock is untouched',
  withHome(async ({ serve, p }) => {
    fs.mkdirSync(path.dirname(p.lock), { recursive: true, mode: 0o700 });
    for (const text of ['', 'not a pid\n']) {
      fs.writeFileSync(p.lock, text);
      const r = await serve().start();
      assert.strictEqual(r.ok, false, `a lock holding ${JSON.stringify(text)} was taken: ${JSON.stringify(r)}`);
      assert.strictEqual(r.code, 'error');
      assert.ok(r.reason.includes(p.lock) && r.reason.includes('no pid'), r.reason);
      assert.strictEqual(fs.readFileSync(p.lock, 'utf8'), text, 'the lock is left as it was');
      assert.ok(!fs.existsSync(p.sock), 'nothing listens');
    }
  }),
);

it(
  "B1f: a dead pid's lock is not taken while another starter holds the takeover lock; a dead takeover holder is refused, never cleared",
  withHome(async ({ serve, p }) => {
    fs.mkdirSync(path.dirname(p.lock), { recursive: true, mode: 0o700 });
    const takeover = `${p.lock}.takeover`;
    fs.writeFileSync(p.lock, '999999999\n');
    fs.writeFileSync(takeover, `${process.pid}\n`); // a live starter, mid-takeover
    const r = await serve().start();
    assert.strictEqual(r.ok, false, `taken under another's takeover: ${JSON.stringify(r)}`);
    assert.strictEqual(r.code, 'running');
    assert.ok(r.reason.includes(takeover), r.reason);
    assert.strictEqual(fs.readFileSync(p.lock, 'utf8'), '999999999\n', 'the dead lock is left for the takeover holder');
    fs.writeFileSync(takeover, '999999998\n'); // a starter that died mid-takeover
    const r2 = await serve().start();
    assert.strictEqual(r2.ok, false, JSON.stringify(r2));
    assert.strictEqual(r2.code, 'error');
    assert.ok(r2.reason.includes(takeover) && r2.reason.includes('by hand'), r2.reason);
    assert.ok(fs.existsSync(takeover), 'a dead takeover lock is not cleared by the next starter');
    fs.rmSync(takeover);
    const r3 = await serve().start();
    assert.strictEqual(r3.ok, true, JSON.stringify(r3));
    assert.strictEqual(fs.readFileSync(p.lock, 'utf8'), `${process.pid}\n`);
    assert.ok(!fs.existsSync(takeover), 'the takeover lock is released after a takeover');
  }),
);

/** Start `n` children at once on one home; resolve when all but one exited (or ms passed). */
function startMany(n, argv, env, ms = 6000) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const kids = [];
    for (let i = 0; i < n; i++) {
      const c = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const k = { c, out: '', code: undefined };
      c.stdout.on('data', (d) => (k.out += d));
      c.stderr.on('data', (d) => (k.out += d));
      c.on('exit', (code) => {
        k.code = code;
        check();
      });
      kids.push(k);
    }
    const timer = setTimeout(() => done(), ms);
    let finished = false;
    function check() {
      if (kids.filter((k) => k.code === undefined).length <= 1) setTimeout(done, 300); // a second survivor would show by then
    }
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(kids);
    }
  });
}

it(
  "B1f (silence): eight intakes started at once on one home holding a dead pid's lock, three times: exactly one runs, the rest refuse (exit 3), none crashes",
  withHome(async ({ home, p }) => {
    const bin = path.join(__dirname, '..', 'bin', 'orunmila.js');
    for (let round = 0; round < 3; round++) {
      fs.mkdirSync(path.dirname(p.lock), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p.lock, '999999999\n');
      fs.rmSync(p.key, { force: true }); // each round races to make the install key too
      const kids = await startMany(8, [bin, 'intake', 'run'], { ORUNMILA_HOME: home });
      const alive = kids.filter((k) => k.code === undefined);
      try {
        assert.strictEqual(alive.length, 1, `round ${round}: ${alive.length} intakes running; exits ${JSON.stringify(kids.map((k) => k.code))}`);
        const others = kids.filter((k) => k.code !== undefined);
        assert.deepStrictEqual(others.map((k) => k.code), Array(7).fill(3), `round ${round}: ${others.filter((k) => k.code !== 3).map((k) => k.out.slice(0, 300)).join(' | ')}`);
        const st = await statusOf(p.sock);
        assert.strictEqual(st && st.pid, alive[0].c.pid, 'the one running intake is the one answering');
      } finally {
        for (const k of kids) if (k.code === undefined) k.c.kill('SIGTERM');
        await until(() => kids.every((k) => k.code !== undefined), 5000);
        for (const k of kids) if (k.code === undefined) k.c.kill('SIGKILL');
      }
    }
  }),
);

it('B1f (silence): twelve processes reading the install key at once, three times, all get the same 32 bytes and none fails', async () => {
  const base = tmpDir();
  try {
    const home = path.join(base, 'h');
    const server = path.join(__dirname, '..', 'src', 'opon', 'intake', 'server.js');
    const code = `try { process.stdout.write(require(${JSON.stringify(server)}).readInstallKey(process.env.H).toString('hex')) } catch (e) { process.stdout.write('ERR ' + e.message); process.exitCode = 9 }`;
    for (let round = 0; round < 3; round++) {
      rmrf(home);
      const kids = await startMany(12, ['-e', code], { H: home }, 8000);
      await until(() => kids.every((k) => k.code !== undefined), 5000);
      assert.deepStrictEqual(kids.map((k) => k.code), Array(12).fill(0), `round ${round}: ${kids.filter((k) => k.code !== 0).map((k) => k.out).join(' | ')}`);
      const keys = new Set(kids.map((k) => k.out));
      assert.strictEqual(keys.size, 1, `round ${round}: ${keys.size} different keys`);
      assert.strictEqual([...keys][0].length, 64);
    }
  } finally {
    rmrf(base);
  }
});

// --- H1 (LD139): the HTTP channel, pinned to the posting process ------------------

const http = require('http');

/** POST a JSON body to the intake's HTTP port from this process; resolves { status, body }. */
function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, agent: false }, (res) => {
      let got = '';
      res.on('data', (d) => (got += d));
      res.on('end', () => resolve({ status: res.statusCode, body: got }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

/** POST from a child process (another pid), as a forger on the same machine would; never blocks this process's loop. */
function postFromChild(port, body) {
  const { spawn } = require('child_process');
  const code = `const h=require('http');const d=process.argv[1];const r=h.request({host:'127.0.0.1',port:${port},path:'/hook',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)}},(s)=>{s.resume();s.on('end',()=>{process.stdout.write(String(process.pid)+' '+s.statusCode)})});r.end(d);`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code, JSON.stringify(body)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => c.kill('SIGKILL'), 10000);
    c.on('exit', () => {
      clearTimeout(t);
      const [pid, status] = out.split(' ').map(Number);
      resolve({ pid, status });
    });
  });
}

const mine = { checkSender: (pid) => pid === process.pid };

it(
  'H1: a POST to the HTTP port reaches the session log on channel http, pinned to the posting process, with a 200 and an empty body',
  withHome(async ({ home, project, serve }) => {
    const r = await serve({ httpPort: 0, routerOpts: mine }).start();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.http && Number.isInteger(r.http.port) && r.http.port > 0 && r.http.listening === true, JSON.stringify(r.http));
    const res = await post(r.http.port, cc(project).prompt('over http'));
    assert.deepStrictEqual(res, { status: 200, body: '' }, 'an empty 2xx is success with no output for Claude Code');
    assert.ok(await until(() => raw(home, 'ses_s1').length === 2));
    const mark = raw(home, 'ses_s1')[1];
    assert.deepStrictEqual([mark.says, mark.detail.channel, mark.detail.sender_pid], ['prompted', 'http', process.pid]);
  }),
);

it(
  'test 82 (over HTTP): a payload for a pinned session posted by another process is a tampered mark naming both pids, never the session\'s mark',
  withHome(async ({ home, project, serve }) => {
    const r = await serve({ httpPort: 0, routerOpts: mine }).start();
    await post(r.http.port, cc(project).prompt('pinned to me'));
    const forged = await postFromChild(r.http.port, cc(project).prompt('forged'));
    assert.strictEqual(forged.status, 200, 'the forger learns nothing from the answer');
    assert.ok(await until(() => raw(home, 'ses_s1').some((m) => m.says === 'tampered')));
    const t = raw(home, 'ses_s1').find((m) => m.says === 'tampered');
    assert.deepStrictEqual([t.detail.what, t.detail.sender_pid, t.detail.pinned_pid], ['foreign_sender', forged.pid, process.pid]);
    assert.ok(!raw(home, 'ses_s1').some((m) => m.says === 'prompted' && m.detail.prompt === 'forged'), 'the forged prompt is not the session\'s');
  }),
);

it(
  'H1: for a pinned session, an HTTP payload whose sender cannot be named (the lookup failed) is tampered, never the session\'s mark',
  withHome(async ({ home, project, serve }) => {
    const peer = require('../src/opon/intake/peer');
    const lookups = { peerPid: peer.peerPid, holderPid: peer.holderPid };
    const r = await serve({ httpPort: 0, routerOpts: mine, lookups }).start();
    await post(r.http.port, cc(project).prompt('pinned'));
    lookups.peerPid = async () => null;
    await post(r.http.port, cc(project).prompt('unnamed'));
    assert.ok(await until(() => raw(home, 'ses_s1').some((m) => m.says === 'tampered')));
    const t = raw(home, 'ses_s1').find((m) => m.says === 'tampered');
    assert.deepStrictEqual(['sender_pid' in t.detail, t.detail.pinned_pid], [false, process.pid], 'no pid is written where none is known');
    assert.ok(!raw(home, 'ses_s1').some((m) => m.says === 'prompted' && m.detail.prompt === 'unnamed'));
  }),
);

it(
  'H1: a first HTTP sender the agent-program check refuses pins nothing and is tampered (LD58)',
  withHome(async ({ home, project, serve }) => {
    const r = await serve({ httpPort: 0 }).start(); // routerFor's checkSender refuses every pid
    await post(r.http.port, cc(project).prompt('not the agent'));
    assert.ok(await until(() => raw(home, 'ses_s1').some((m) => m.says === 'tampered')));
    const t = raw(home, 'ses_s1').find((m) => m.says === 'tampered');
    assert.deepStrictEqual([t.detail.sender_pid, 'pinned_pid' in t.detail], [process.pid, false]);
  }),
);

it(
  'test 83 (TCP form): the HTTP port held by another process is recorded with its pid; the intake takes the port when it frees, and the held session\'s gap names the squat',
  withHome(async ({ home, project, serve, p }) => {
    const before = routerFor(home);
    before.payload(cc(project).start(), { channel: 'command' });
    before.payload(cc(project).prompt('one'), { channel: 'command' });
    const squatter = net.createServer((c) => c.end());
    await new Promise((res) => squatter.listen(0, '127.0.0.1', res));
    const port = squatter.address().port;
    const r = await serve({ httpPort: port, httpRetryMs: 50, routerOpts: mine }).start();
    assert.strictEqual(r.ok, true, 'the socket channel still serves');
    assert.deepStrictEqual([r.http.listening, r.http.squat], [false, process.pid], JSON.stringify(r.http));
    const errs = lines(p.errors);
    assert.ok(errs.length === 1 && errs[0].reason.startsWith('squat:') && errs[0].reason.includes(`pid ${process.pid}`) && errs[0].reason.includes(String(port)), JSON.stringify(errs));
    await new Promise((res) => squatter.close(res));
    assert.ok(await until(() => raw(home, 'ses_s1').some((m) => m.says === 'gap' && m.detail.lost.includes(`127.0.0.1:${port}`))), 'a gap naming the squat once the port is taken back');
    const res = await post(port, cc(project).prompt('back'));
    assert.strictEqual(res.status, 200);
  }),
);

it('H1: the agent-program check accepts a process whose program is named claude and refuses others; the peer lookup names the posting pid', async () => {
  const { isAgentProgram, peerPid } = require('../src/opon/intake/peer');
  assert.strictEqual(isAgentProgram(process.pid), false, 'node is not the agent');
  assert.strictEqual(isAgentProgram(999999999), false, 'a dead pid is not the agent');
  const base = tmpDir();
  const { spawn } = require('child_process');
  const link = path.join(base, 'claude');
  fs.symlinkSync(process.execPath, link);
  const k = spawn(link, ['-e', 'setTimeout(()=>{},3000)']);
  try {
    await sleep(300);
    assert.strictEqual(isAgentProgram(k.pid), true, 'a program named claude (the stated limit: any program so named passes)');
  } finally {
    k.kill();
    rmrf(base);
  }
  const srv = http.createServer((req, res) => {
    peerPid(req.socket).then((pid) => res.end(String(pid)));
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    const got = await post(srv.address().port, {});
    assert.strictEqual(Number(got.body), process.pid);
  } finally {
    srv.close();
  }
});

runAll('intake-server');
