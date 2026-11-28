// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/runtime/untar.js — the files of an npm package tarball (PM2c1, LD332), read with Node's own zlib: the package has
 * no dependency to unpack it with. Plain code, no file system.
 *
 *   untar(tgz) -> [{ path, data }]   every regular file under `package/`, its path `/`-separated with `package/` taken
 *                                    off, in the tarball's order. Folders are skipped (each file's path names its own).
 *
 * Refused, with an Error naming the entry: a path outside `package/` or that leaves it (`..`, an absolute path), and
 * any entry that is not a file or a folder (a link: npm packages hold none, and one could point outside the copy).
 * Read: ustar headers (the name and its 155-byte prefix), pax extended headers (`x`, their `path`), and the global pax
 * header (`g`), whose settings an npm tarball does not use. A header whose checksum does not add up ends the reading
 * as damaged.
 */

const zlib = require('zlib');

const text = (buf, at, len) => {
  const s = buf.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? s.length : end).toString('utf8');
};
const octal = (buf, at, len) => {
  const s = text(buf, at, len).trim();
  return s ? parseInt(s, 8) : 0;
};

/** The `path` a pax extended header sets, or null. */
function paxPath(data) {
  let at = 0;
  const s = data.toString('utf8');
  while (at < s.length) {
    const sp = s.indexOf(' ', at);
    const len = parseInt(s.slice(at, sp), 10);
    if (!(len > 0)) break;
    const rec = s.slice(sp + 1, at + len - 1); // without the length and the final newline
    const eq = rec.indexOf('=');
    if (rec.slice(0, eq) === 'path') return rec.slice(eq + 1);
    at += len;
  }
  return null;
}

function untar(tgz) {
  const tar = zlib.gunzipSync(tgz);
  const out = [];
  let at = 0;
  let longPath = null;
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break; // the end of the archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error(`the package's archive is damaged at byte ${at} (a header's checksum does not add up)`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longPath = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    const prefix = text(h, 345, 155);
    const name = longPath !== null ? longPath : prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100);
    longPath = null;
    if (!name.startsWith('package/') || name.includes('\\')) throw new Error(`the package's archive holds ${JSON.stringify(name)}, outside package/`);
    const rel = name.slice('package/'.length).replace(/\/+$/, '');
    if (rel.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error(`the package's archive holds ${JSON.stringify(name)}, which leaves the package`);
    if (type === '5') continue;
    if (type !== '0' && type !== '7') throw new Error(`the package's archive holds ${JSON.stringify(name)}, which is not a file or a folder (type ${type})`);
    if (rel) out.push({ path: rel, data: Buffer.from(data) });
  }
  return out;
}

module.exports = { untar };
