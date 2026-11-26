// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/registry.js — the one file in the package that reaches the network (PM2c1, LD332; LD268, O: "Orunmila
 * tool cannot make internet calls to do its work, but the updates are not classified as calls to work"). It asks npm's
 * registry about Orunmila's own package and downloads it; it sends nothing but the address it asks for (no session
 * data, no identifier of the machine or the user). Only src/runtime/update.js loads it, and only `orunmila update`
 * loads that (test/update.js holds both; test/no-network.js names this file as its one exception).
 *
 *   getJson(url) -> Promise<object>     a GET, its body parsed as JSON
 *   getBuffer(url) -> Promise<Buffer>   a GET, its body as bytes
 *
 * http or https by the address; a redirect followed at most 3 times; 30 s, and 64 MB, at most; any other answer
 * than 200 is an Error naming the address and the status.
 */

const http = require('http');
const https = require('https');

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30000;

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`not an address: ${url}`));
    }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error(`not an http or https address: ${url}`));
    const req = lib.get(u, { headers: { accept: 'application/json, application/octet-stream', 'user-agent': 'orunmila-update' }, timeout: TIMEOUT_MS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).toString(), hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} answered ${res.statusCode}`));
      }
      const parts = [];
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n > MAX_BYTES) req.destroy(new Error(`${url} sent more than ${MAX_BYTES} bytes`));
        else parts.push(d);
      });
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${url} did not answer within ${TIMEOUT_MS / 1000} s`)));
    req.on('error', reject);
  });
}

const getBuffer = (url) => get(url);
const getJson = async (url) => JSON.parse((await get(url)).toString('utf8'));

module.exports = { getJson, getBuffer };
