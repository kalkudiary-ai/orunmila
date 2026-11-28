// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/start-worker.js — a session's start, off the intake's thread (Phase 6 slice SN1, LD294; F16: on a
 * project of 100,000 files the baseline snapshot took 4.0 s and the Sentinel's first read 4.6 s, both on the intake's
 * one thread, longer than Claude Code's HTTP hooks wait). The intake hands the work to a worker thread and goes on
 * answering; the session's payloads wait in its queue meanwhile (router.js, asyncStart).
 *
 *   prepareOffThread(job) -> Promise<{ baseline: { text, fingerprint }, store: [[abs, state], ...] | null }>
 *     job: { root, exclusions, key (bytes), envValues, sentinel: { ignore, limit } | null }
 *     The baseline is src/opon/net/baseline.js's snapshot, exactly as the session's start takes it in the thread;
 *     the store is the Sentinel's first read of each file it would watch (sentinel.js snapFile), so its watch starts
 *     without reading them again. A failure rejects, and the caller starts the session in its own thread.
 */

const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

/** The work itself, in whichever thread runs it. */
function prepare(job) {
  const { snapshot } = require('../net/baseline');
  const key = Buffer.from(job.key);
  const b = snapshot(job.root, { exclusions: job.exclusions, key, envValues: job.envValues });
  let store = null;
  if (job.sentinel) {
    const { snapFile } = require('./sentinel');
    const { isIgnored } = require('../../capture/fs-sentinel/ignore');
    const top = fs.realpathSync(job.root);
    store = [];
    const walk = (dir) => {
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // the watcher reads what it can when it starts
      }
      for (const e of list) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(top, abs).split(path.sep).join('/');
        if (isIgnored(e.isDirectory() ? rel + '/' : rel, job.sentinel.ignore)) continue;
        if (e.isDirectory() && !e.isSymbolicLink()) walk(abs);
        else if (e.isFile()) {
          const s = snapFile(abs, job.sentinel.limit, key);
          if (s) store.push([abs, s]);
        }
      }
    };
    walk(top);
  }
  return { baseline: { text: b.text, fingerprint: b.fingerprint }, store };
}

function prepareOffThread(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { ...job, key: Array.from(job.key) } });
    let done = false;
    w.once('message', (m) => {
      done = true;
      if (m && m.ok) resolve(m.result);
      else reject(new Error((m && m.error) || 'the start worker gave no answer'));
    });
    w.once('error', (e) => {
      if (!done) reject(e);
    });
    w.once('exit', (code) => {
      if (!done) reject(new Error(`the start worker exited ${code} with no answer`));
    });
  });
}

if (!isMainThread && workerData && workerData.root) {
  try {
    parentPort.postMessage({ ok: true, result: prepare(workerData) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
}

module.exports = { prepareOffThread, prepare };
