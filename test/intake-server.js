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

runAll('intake-server');
