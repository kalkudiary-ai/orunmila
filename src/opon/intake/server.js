'use strict';

/**
 * src/opon/intake/server.js — the intake server (Phase 1 slice B1e, LD132; brief
 * v4 station 1, line 343: one intake per machine; design D-I 4.1, 4.2(b), 4.7).
 * It runs one router (router.js) behind a Unix socket Orunmila owns, and is the
 * only thing that writes session logs. Command hooks reach it through a small
 * sender (slice B2); Claude Code's HTTP hooks post to 127.0.0.1:<httpPort>, each
 * session pinned to the posting process (slice H1, LD139; peer.js).
 *   createServer({ ..., httpPort = null, httpRetryMs = 1000, lookups })
 *     httpPort  null: no HTTP channel; 0: any free port (tests). A POST body is
 *               a hook payload, routed on channel `http` with the client's pid;
 *               the answer is 200 with an empty body, a tampered one included.
 *               A port another process holds is a squat (test 83, TCP form):
 *               written to the error log with the holder's pid where lsof
 *               gives it, tried again every httpRetryMs, and once taken back a
 *               gap in every held session names it. start() and status() give
 *               { port, listening, squat }.
 *
 *   intakePaths(home)   { dir, sock, lock, takeover, key, errors, held, out } under <home>/intake
 *   readInstallKey(home) the install's key for keyed `.env` fingerprints (line
 *                       249): 32 random bytes in <home>/intake/install.key, 0600,
 *                       made once and placed whole (B1f); a key of any other
 *                       length is refused, never replaced (fingerprints would
 *                       stop comparing)
 *   statusOf(sock, ms)  the running intake's status, or null when none answers
 *   createServer({ home, router, pollMs = 100, statusTimeoutMs = 1000,
 *                  maxLine = 32 MiB })
 *     .start()  -> { ok: true, squat, resumed, sock } or { ok: false, code, reason }
 *               In order: the lock (<home>/intake/intake.lock holds the pid,
 *               placed whole; a live pid refuses, code `running`; a dead one is
 *               taken under the takeover lock; no pid refuses, code `error`); the
 *               socket (an intake already answering refuses; any other listener
 *               is a squat (test 83): written to the error log, the path removed
 *               and the address taken back; a path nobody listens on is removed
 *               quietly); router.resume() (test 84; a squat named in each gap);
 *               listen; router.poll() every pollMs.
 *     .stop(reason) -> the router's stop (LD56), then the socket and the lock
 *               removed; null when it never started
 *
 * The protocol: newline-delimited JSON, one request per line.
 *   {"op":"payload","payload":{...}}  to the router on channel `command`; no reply
 *   {"op":"status"}                   one line back, then the connection closes
 * A line that is not JSON, names no known op, or passes maxLine bytes with no
 * end goes to the error log, redacted (LD124); the connection carries on, except
 * after an over-long line, which closes it.
 */

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const peer = require('./peer');

const MAX_LINE = 32 * 1024 * 1024;
const SOCK_MAX = 103; // sun_path is 104 bytes on macOS, 108 on Linux, with its NUL
const KEY_BYTES = 32;

function intakePaths(home) {
  const dir = path.join(home, 'intake');
  return {
    dir,
    sock: path.join(dir, 'intake.sock'),
    lock: path.join(dir, 'intake.lock'),
    takeover: path.join(dir, 'intake.lock.takeover'),
    key: path.join(dir, 'install.key'),
    errors: path.join(dir, 'errors.jsonl'),
    held: path.join(dir, 'held.json'),
    out: path.join(dir, 'intake.out'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/**
 * Put `content` at `target` whole, or not at all (B1f, LD136): written to a temp
 * file beside it, then hard-linked into place, which fails with EEXIST when the
 * target exists. A reader never sees the target empty or half written, so an
 * empty lock or key is never "a writer in progress"; it is damage, for a person.
 * Returns true when placed, false when the target already existed.
 */
function placeWhole(target, content) {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readInstallKey(home) {
  const p = intakePaths(home);
  ensureDir(p.dir);
  for (let i = 0; i < 2; i++) {
    try {
      const key = fs.readFileSync(p.key);
      if (key.length !== KEY_BYTES) throw new Error(`${p.key} holds ${key.length} bytes, not ${KEY_BYTES}: it is refused, not replaced, because every keyed fingerprint depends on it`);
      return key;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    placeWhole(p.key, crypto.randomBytes(KEY_BYTES)); // false: made by another process meanwhile, read it
  }
  return fs.readFileSync(p.key);
}

/** The pid a lock file names, `null` when it names none, `undefined` when the file is gone. */
function lockPid(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  return /^[1-9][0-9]*\n$/.test(text) ? Number(text.slice(0, -1)) : null;
}

/** Who listens on `sock`: { listening, status } (status: the intake's answer, or null). */
function probe(sock, ms = 1000) {
  return new Promise((resolve) => {
    let connected = false;
    let got = Buffer.alloc(0);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const c = net.createConnection(sock);
    const timer = setTimeout(() => finish({ listening: connected, status: null }), ms);
    c.on('connect', () => {
      connected = true;
      c.write('{"op":"status"}\n');
    });
    c.on('data', (d) => {
      got = Buffer.concat([got, d]);
      const i = got.indexOf(10);
      if (i === -1) return;
      let st = null;
      try {
        st = JSON.parse(got.subarray(0, i).toString('utf8'));
      } catch {
        /* not an intake's answer */
      }
      finish({ listening: true, status: st && st.intake === 'orunmila' ? st : null });
    });
    c.on('error', () => finish({ listening: connected, status: null }));
    c.on('close', () => finish({ listening: connected, status: null }));
  });
}

async function statusOf(sock, ms = 1000) {
  return (await probe(sock, ms)).status;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function createServer({ home, router, pollMs = 100, statusTimeoutMs = 1000, maxLine = MAX_LINE, httpPort = null, httpRetryMs = 1000, lookups = peer }) {
  const p = intakePaths(home);
  let server = null;
  let timer = null;
  let startedAt = null;
  let lockHeld = false;
  const conns = new Set();
  // The HTTP channel (slice H1, LD139): Claude Code's own HTTP hooks post to
  // 127.0.0.1:<httpPort>. Each connection's client pid is looked up once (lsof);
  // the router pins the session to it (NF49). `squat`: false, or the pid (null if
  // not known) of the process that held the port when the intake wanted it.
  let httpServer = null;
  let httpTimer = null;
  let httpState = null;
  const pids = new WeakMap(); // socket -> Promise<pid | null>

  function onHttp(req, res) {
    const answer = (code) => {
      res.statusCode = code;
      res.end(); // an empty 2xx is success with no output for Claude Code
    };
    if (req.method !== 'POST') {
      router.error(`a ${req.method} request reached the intake's HTTP port; only POST is read`, null);
      answer(405);
      return;
    }
    const sock = req.socket;
    if (!pids.has(sock)) pids.set(sock, lookups.peerPid(sock)); // while the connection is open
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (d) => {
      if (over) return;
      size += d.length;
      if (size > maxLine) {
        over = true;
        router.error(`a request over ${maxLine} bytes reached the intake's HTTP port: it was not read`, null);
        answer(413);
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', async () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        router.error("a request body that is not JSON reached the intake's HTTP port", text);
        answer(400);
        return;
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        router.error("a request body that is not a JSON object reached the intake's HTTP port", payload);
        answer(400);
        return;
      }
      const pid = await pids.get(sock);
      try {
        const out = router.payload(payload, { channel: 'http', pid });
        for (const r of (out && out.results) || []) {
          if (r && r.tampered === null) router.error(`a tampered mark could not be written to the session's log: ${r.refused}`, payload);
        }
      } catch (e) {
        router.error(`the router failed on a payload: ${e.message}`, payload);
      }
      answer(200); // the same answer for a tampered payload: a forger learns nothing
    });
  }

  async function listenHttp() {
    httpTimer = null;
    if (!server) return;
    const s = http.createServer(onHttp);
    try {
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(httpState.port, '127.0.0.1', () => {
          s.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      if (e.code !== 'EADDRINUSE') {
        router.error(`the intake's HTTP port 127.0.0.1:${httpState.port} could not be opened (${e.code || e.message}); it is tried again every ${httpRetryMs} ms`, null);
      } else if (httpState.squat === false) {
        httpState.squat = lookups.holderPid(httpState.port);
        router.error(
          `squat: another process (${httpState.squat === null ? 'pid not known' : `pid ${httpState.squat}`}) holds the intake's HTTP port 127.0.0.1:${httpState.port}, so Claude Code's HTTP hook payloads go to it until the intake takes the port back; tried again every ${httpRetryMs} ms`,
          null,
        );
      }
      if (server) httpTimer = setTimeout(listenHttp, httpRetryMs);
      return;
    }
    if (!server) {
      s.close();
      return;
    }
    s.on('error', (e) => router.error(`the intake's HTTP port failed: ${e.code || e.message}`, null));
    httpServer = s;
    httpState.port = s.address().port;
    httpState.listening = true;
    if (httpState.squat !== false) {
      router.gap(`HTTP hook payloads sent to 127.0.0.1:${httpState.port} while another process (${httpState.squat === null ? 'pid not known' : `pid ${httpState.squat}`}) held it may have gone to that process (test 83)`);
    }
  }

  // The lock (B1f, LD136). It is placed whole, so it always names its holder. A
  // dead holder's lock is removed only by the starter holding the takeover lock
  // (<lock>.takeover, placed the same way), and only if it still names that same
  // dead pid; without that, two starters that both read the dead pid could each
  // remove the other's fresh lock, and two intakes would run (seen in a probe:
  // 1 round of 8). A lock or takeover lock that names no pid, or a takeover lock
  // whose holder died, is never cleared here: the start refuses and a person
  // removes it. That costs a manual step after a rare crash; it never costs two
  // intakes.
  const mine = `${process.pid}\n`;
  function acquire() {
    for (let i = 0; i < 5; i++) {
      if (placeWhole(p.lock, mine)) {
        lockHeld = true;
        return { ok: true };
      }
      const pid = lockPid(p.lock);
      if (pid === undefined) continue; // removed meanwhile: try again
      if (pid === null) return { ok: false, code: 'error', reason: `${p.lock} holds no pid, so its holder is unknown; it is never taken as dead: remove it by hand if no intake runs` };
      if (alive(pid)) {
        return { ok: false, code: 'running', reason: `another intake holds ${p.lock} (pid ${pid}); if that pid is not an intake (a reused pid), remove the lock by hand` };
      }
      const t = takeOver(pid);
      if (t) return t;
    }
    return { ok: false, code: 'error', reason: `${p.lock} could not be taken` };
  }

  /** Remove a dead holder's lock under the takeover lock; a refusal, or null to try again. */
  function takeOver(deadPid) {
    if (!placeWhole(p.takeover, mine)) {
      const holder = lockPid(p.takeover);
      if (holder === undefined) return null;
      if (holder !== null && alive(holder)) return { ok: false, code: 'running', reason: `another starter (pid ${holder}) is taking over a dead intake's lock (${p.takeover})` };
      return { ok: false, code: 'error', reason: `${p.takeover} is left by a starter that died taking over a dead intake's lock (or names no pid); remove it by hand if no intake runs` };
    }
    try {
      if (lockPid(p.lock) === deadPid) fs.rmSync(p.lock, { force: true });
    } finally {
      fs.rmSync(p.takeover, { force: true });
    }
    return null;
  }

  function releaseLock() {
    if (!lockHeld) return;
    lockHeld = false;
    if (lockPid(p.lock) === process.pid) fs.rmSync(p.lock, { force: true });
  }

  const status = () => ({ intake: 'orunmila', pid: process.pid, started_at: startedAt, held: router.held(), socket: p.sock, http: httpState && { ...httpState } });

  function handle(line, c) {
    if (!line.trim()) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      router.error('a line that is not JSON reached the intake\'s socket', line);
      return;
    }
    if (r && r.op === 'payload' && r.payload !== null && typeof r.payload === 'object') {
      try {
        router.payload(r.payload, { channel: 'command' });
      } catch (e) {
        router.error(`the router failed on a payload: ${e.message}`, r.payload);
      }
      return;
    }
    if (r && r.op === 'status') {
      c.end(JSON.stringify(status()) + '\n');
      return;
    }
    router.error('a line with no known op (payload or status) reached the intake\'s socket', r);
  }

  function onConnection(c) {
    conns.add(c);
    let buf = Buffer.alloc(0);
    let closed = false;
    c.on('data', (d) => {
      if (closed) return;
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let i;
      while ((i = buf.indexOf(10)) !== -1) {
        handle(buf.subarray(0, i).toString('utf8'), c);
        buf = buf.subarray(i + 1);
      }
      if (buf.length > maxLine) {
        router.error(`a line over ${maxLine} bytes with no end reached the intake's socket: the connection was closed and the line not read`, buf.subarray(0, 4000).toString('utf8'));
        buf = Buffer.alloc(0);
        closed = true;
        c.destroy();
      }
    });
    c.on('end', () => {
      if (!closed && buf.length) handle(buf.toString('utf8'), c); // a last line with no newline
      buf = Buffer.alloc(0);
    });
    c.on('error', (e) => {
      if (buf.length) router.error(`a connection to the intake broke with part of a line unread (${e.code || e.message})`, buf.subarray(0, 4000).toString('utf8'));
      buf = Buffer.alloc(0);
    });
    c.on('close', () => conns.delete(c));
  }

  async function start() {
    if (server) return { ok: false, code: 'running', reason: 'this server has already started' };
    if (Buffer.byteLength(p.sock) > SOCK_MAX) return { ok: false, code: 'error', reason: `the socket path ${p.sock} is over ${SOCK_MAX} bytes, longer than a Unix socket's address allows` };
    ensureDir(p.dir);
    const l = acquire();
    if (!l.ok) return l;
    try {
      const pr = await probe(p.sock, statusTimeoutMs);
      if (pr.status) {
        releaseLock();
        return { ok: false, code: 'running', reason: `an intake (pid ${pr.status.pid}) already answers on ${p.sock} without holding the lock` };
      }
      const squat = pr.listening;
      if (squat) {
        router.error(
          `squat: another process was listening on the intake's socket ${p.sock} when the intake started; its pid is not known (Node cannot read a Unix socket's peer); the intake removed the path and took the address back`,
          null,
        );
      }
      fs.rmSync(p.sock, { force: true });
      const resumed = router.resume(squat ? { also: "another process was listening on the intake's socket when it started (its pid is not known), so marks sent before then may have gone to it" } : {});
      const s = net.createServer(onConnection);
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(p.sock, () => {
          s.off('error', reject);
          resolve();
        });
      });
      s.on('error', (e) => router.error(`the intake's socket failed: ${e.code || e.message}`, null));
      fs.chmodSync(p.sock, 0o600);
      server = s;
      startedAt = new Date().toISOString();
      timer = setInterval(() => {
        try {
          router.poll();
        } catch (e) {
          router.error(`the intake's poll failed: ${e.message}`, null);
        }
      }, pollMs);
      if (httpPort !== null) {
        httpState = { port: httpPort, listening: false, squat: false };
        await listenHttp();
      }
      return { ok: true, squat, resumed, sock: p.sock, http: httpState && { ...httpState } };
    } catch (e) {
      releaseLock();
      return { ok: false, code: 'error', reason: e.message };
    }
  }

  async function stop(reason) {
    if (!server) return null;
    clearInterval(timer);
    clearTimeout(httpTimer);
    const out = router.stop(reason);
    const s = server;
    server = null;
    for (const c of conns) c.destroy();
    await new Promise((resolve) => s.close(resolve));
    if (httpServer) {
      const h = httpServer;
      httpServer = null;
      httpState.listening = false;
      h.closeAllConnections();
      await new Promise((resolve) => h.close(resolve));
    }
    fs.rmSync(p.sock, { force: true });
    releaseLock();
    return out;
  }

  return { start, stop, status, paths: p };
}

const DEFAULT_HTTP_PORT = 47390; // LD140: free on this machine when chosen (lsof, 2026-11-22)

/**
 * The Ọpọ́n's live path in the intake (LD166, LD170): on only with
 * ORUNMILA_OPON_LIVE=1, exactly; anything else, or nothing, is off. Today it
 * takes the baseline snapshot at session start (slice N1b); stations 1-6 join it in L1.
 */
const oponLive = (env = process.env) => env.ORUNMILA_OPON_LIVE === '1';

/** The intake's HTTP port: ORUNMILA_INTAKE_PORT, or the default; a value that is not a port throws. */
function intakePort(env = process.env) {
  const v = env.ORUNMILA_INTAKE_PORT;
  if (v === undefined || v === '') return DEFAULT_HTTP_PORT;
  const n = Number(v);
  if (!/^[0-9]+$/.test(String(v)) || n > 65535) throw new Error(`ORUNMILA_INTAKE_PORT is ${JSON.stringify(v)}, not a port number`);
  return n;
}

module.exports = { createServer, intakePaths, readInstallKey, statusOf, intakePort, oponLive, DEFAULT_HTTP_PORT, MAX_LINE };
