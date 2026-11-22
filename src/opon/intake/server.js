'use strict';

/**
 * src/opon/intake/server.js — the intake server (Phase 1 slice B1e, LD132; brief
 * v4 station 1, line 343: one intake per machine; design D-I 4.1, 4.2(b), 4.7).
 * It runs one router (router.js) behind a Unix socket Orunmila owns, and is the
 * only thing that writes session logs. Command hooks reach it through a small
 * sender (slice B2); HTTP hooks with pid pinning are a later slice.
 *
 *   intakePaths(home)   { dir, sock, lock, key, errors, held, out } under <home>/intake
 *   readInstallKey(home) the install's key for keyed `.env` fingerprints (line
 *                       249): 32 random bytes in <home>/intake/install.key, 0600,
 *                       made once; a key of any other length is refused, never
 *                       replaced (fingerprints would stop comparing)
 *   statusOf(sock, ms)  the running intake's status, or null when none answers
 *   createServer({ home, router, pollMs = 100, statusTimeoutMs = 1000,
 *                  maxLine = 32 MiB })
 *     .start()  -> { ok: true, squat, resumed, sock } or { ok: false, code, reason }
 *               In order: the lock (<home>/intake/intake.lock holds the pid; a
 *               live pid refuses, code `running`; a dead one is taken); the
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
const path = require('path');
const crypto = require('crypto');

const MAX_LINE = 32 * 1024 * 1024;
const SOCK_MAX = 103; // sun_path is 104 bytes on macOS, 108 on Linux, with its NUL
const KEY_BYTES = 32;

function intakePaths(home) {
  const dir = path.join(home, 'intake');
  return {
    dir,
    sock: path.join(dir, 'intake.sock'),
    lock: path.join(dir, 'intake.lock'),
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
    try {
      const fd = fs.openSync(p.key, 'wx', 0o600);
      try {
        fs.writeSync(fd, crypto.randomBytes(KEY_BYTES));
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // made by another process meanwhile: read it
    }
  }
  return fs.readFileSync(p.key);
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

function createServer({ home, router, pollMs = 100, statusTimeoutMs = 1000, maxLine = MAX_LINE }) {
  const p = intakePaths(home);
  let server = null;
  let timer = null;
  let startedAt = null;
  let lockHeld = false;
  const conns = new Set();

  function acquire() {
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(p.lock, 'wx', 0o600);
        try {
          fs.writeSync(fd, `${process.pid}\n`);
        } finally {
          fs.closeSync(fd);
        }
        lockHeld = true;
        return { ok: true };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const pid = parseInt(fs.readFileSync(p.lock, 'utf8'), 10);
      if (alive(pid)) {
        return { ok: false, code: 'running', reason: `another intake holds ${p.lock} (pid ${pid}); if that pid is not an intake (a reused pid), remove the lock by hand` };
      }
      fs.rmSync(p.lock, { force: true }); // a dead holder's lock: taken
    }
    return { ok: false, code: 'error', reason: `${p.lock} could not be taken` };
  }

  function releaseLock() {
    if (!lockHeld) return;
    lockHeld = false;
    try {
      if (parseInt(fs.readFileSync(p.lock, 'utf8'), 10) === process.pid) fs.rmSync(p.lock, { force: true });
    } catch {
      /* already gone */
    }
  }

  const status = () => ({ intake: 'orunmila', pid: process.pid, started_at: startedAt, held: router.held(), socket: p.sock });

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
      return { ok: true, squat, resumed, sock: p.sock };
    } catch (e) {
      releaseLock();
      return { ok: false, code: 'error', reason: e.message };
    }
  }

  async function stop(reason) {
    if (!server) return null;
    clearInterval(timer);
    const out = router.stop(reason);
    const s = server;
    server = null;
    for (const c of conns) c.destroy();
    await new Promise((resolve) => s.close(resolve));
    fs.rmSync(p.sock, { force: true });
    releaseLock();
    return out;
  }

  return { start, stop, status, paths: p };
}

module.exports = { createServer, intakePaths, readInstallKey, statusOf, MAX_LINE };
