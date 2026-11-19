'use strict';

/**
 * src/opon/intake/leak-check.js — the leak check (LD93, LD95). Redaction
 * cannot catch every secret, so this searches what Orunmila wrote for the
 * exact values of a project's `.env` files, with no word rules, and reports
 * where each one is by its name, never its value.
 *
 *   envEntriesFrom(text)         [{ name, value }]: the values the intake
 *                                redacts (envValuesFrom, LD88), with their names;
 *                                a line is first cut by dotenv's rules (a quoted
 *                                value ends at its quote, an unquoted one at ` #`)
 *   readEnvEntries(root)         { entries: [{ names, value }], files, unreadable }:
 *                                root's own `.env` and `.env.*` files (top level;
 *                                a symbolic link to a file is followed), merged by value
 *   spellings(value)             the value as written, JSON-escaped once and
 *                                twice, as a script-safe JSON string (`<` `>` `&`
 *                                as < > &, alone or together), and
 *                                HTML-escaped
 *   scanFile(file, entries, o)   [{ names, length, count, line, byte }], one per
 *                                value found; overlapping matches of one value
 *                                count once; read in chunks that overlap
 *   defaultTargets(o)            the data dir, and the report files `orunmila
 *                                html|trail|json|feedback` write into root
 *   scan(targets, entries)       { hits, files, unreadable } over files and
 *                                folders; one file reached twice is read once
 *
 * Values stay in this process's memory; nothing here writes. A hit inside a
 * longer word (pw12 in pw123) is reported too: an alarm hides nothing. The
 * `.env` files the values came from are never scanned; any other is.
 */

const fs = require('fs');
const path = require('path');
const { envValuesFrom, onRedactionList } = require('./redact');

const CHUNK = 16 * 1024 * 1024;
const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const html = (s) => s.replace(/[&<>"']/g, (c) => HTML[c]);
const json = (s) => JSON.stringify(s).slice(1, -1);
const U = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };
const scriptSafe = (s, chars) => s.replace(chars, (c) => U[c]);

/**
 * The `NAME=value` lines a `.env` line may mean, or []. A quoted value (' " `)
 * ends at the first matching quote followed only by spaces or a comment. An
 * unquoted value is cut at a `#`: dotenv cuts at any `#`, a shell only at ` #`,
 * so both are tried; a value that is then empty is none.
 */
function dotenvLines(raw) {
  const line = raw.trim().replace(/^export\s+/, '');
  const eq = line.indexOf('=');
  if (eq < 1) return [];
  const name = line.slice(0, eq).trim();
  const v = line.slice(eq + 1).trim();
  let values = [v];
  if (v[0] === '"' || v[0] === "'" || v[0] === '`') {
    for (let end = v.indexOf(v[0], 1); end !== -1; end = v.indexOf(v[0], end + 1)) {
      if (/^\s*(?:#.*)?$/.test(v.slice(end + 1))) {
        values = [v.slice(1, end)];
        break;
      }
    }
  } else if (v[0] === '#') {
    values = []; // `NAME= # comment`: the whole value is a comment
  } else if (v.includes('#')) {
    values = [v.slice(0, v.indexOf('#')).trimEnd(), v.slice(0, v.search(/\s#|$/)).trimEnd()];
  }
  return [...new Set(values)].filter(Boolean).map((x) => `${name}=${x}`);
}

/** Entries for the values envValuesFrom keeps from those lines, so the rules are the intake's (LD88). */
function envEntriesFrom(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    for (const l of dotenvLines(raw)) {
      const [value] = envValuesFrom(l);
      if (value !== undefined) out.push({ name: l.slice(0, l.indexOf('=')), value });
    }
  }
  return out;
}

function readEnvEntries(root) {
  const byValue = new Map();
  const files = [];
  const unreadable = [];
  const sources = [];
  let names = [];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    /* no such folder: no entries */
  }
  for (const n of names) {
    if (!onRedactionList(n)) continue;
    const p = path.join(root, n);
    let text;
    try {
      if (!fs.statSync(p).isFile()) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch {
      unreadable.push(p);
      continue;
    }
    files.push(n);
    sources.push(fs.realpathSync(p));
    for (const { name, value } of envEntriesFrom(text)) {
      if (!byValue.has(value)) byValue.set(value, new Set());
      byValue.get(value).add(name);
    }
  }
  const entries = [...byValue].map(([value, ns]) => ({ names: [...ns].sort(), value }));
  return { entries, files, unreadable, sources };
}

function spellings(value) {
  const j = json(value);
  return [...new Set([value, j, json(j), scriptSafe(j, /</g), scriptSafe(j, /[<>&]/g), html(value), html(j)])];
}

function readFull(fd, buf, pos) {
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

function scanFile(file, entries, { chunk = CHUNK } = {}) {
  const needles = [];
  for (const e of entries) for (const s of spellings(e.value)) needles.push({ e, buf: Buffer.from(s, 'utf8') });
  const overlap = Math.max(1, ...needles.map((n) => n.buf.length)) - 1;
  const found = new Map();
  const lastEnd = new Map(); // per value: where its last counted occurrence ends
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let line = 1;
    let lineStart = 0;
    for (let pos = 0; pos < size; pos += chunk) {
      const buf = Buffer.alloc(Math.min(chunk + overlap, size - pos));
      const len = readFull(fd, buf, pos);
      // A match is counted in the chunk where it starts; the overlap only lets it finish there.
      const primary = Math.min(chunk, len);
      const hits = [];
      for (const n of needles) {
        for (let i = buf.indexOf(n.buf); i !== -1 && i < primary; i = buf.indexOf(n.buf, i + 1)) hits.push([i, i + n.buf.length, n.e]);
      }
      hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let counted = 0;
      const advance = (to) => {
        for (let k = buf.indexOf(10, counted); k !== -1 && k < to; k = buf.indexOf(10, k + 1)) {
          line++;
          lineStart = pos + k + 1;
        }
        counted = to;
      };
      for (const [i, end, e] of hits) {
        // Two spellings of one occurrence overlap (`a\` and its JSON `a\\`): one occurrence.
        const prev = lastEnd.get(e);
        if (prev !== undefined && pos + i < prev) {
          lastEnd.set(e, Math.max(prev, pos + end));
          continue;
        }
        lastEnd.set(e, pos + end);
        advance(i);
        const f = found.get(e);
        if (f) f.count++;
        else found.set(e, { names: e.names, length: e.value.length, count: 1, line, byte: pos + i - lineStart + 1 });
      }
      advance(primary);
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...found.values()];
}

function defaultTargets({ dataDir, root }) {
  const targets = [{ path: dataDir }, { path: path.join(root, '.orunmila-feedback') }];
  let dirents = [];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    /* no such folder */
  }
  for (const d of dirents) {
    if (d.isFile() && d.name.startsWith('orunmila-') && (d.name.endsWith('.html') || d.name.endsWith('.json'))) {
      targets.push({ path: path.join(root, d.name) });
    }
  }
  return targets;
}

/**
 * Targets are { path, required }: a missing required path is unreadable; a
 * missing default is skipped. Inside a folder, a symbolic link is listed as
 * unreadable, never followed. `opts.skip` holds the real paths of the `.env`
 * files the values came from; every other file is read, whatever its name.
 */
function scan(targets, entries, opts = {}) {
  const hits = [];
  const unreadable = [];
  const seen = new Set(opts.skip || []);
  let files = 0;
  const visit = (file) => {
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return;
      seen.add(real);
      for (const h of scanFile(file, entries, { chunk: opts.chunk })) hits.push({ file, ...h });
      files++;
    } catch {
      unreadable.push(file);
    }
  };
  const walk = (dir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) visit(p);
      else unreadable.push(p);
    }
  };
  for (const t of targets) {
    let st;
    try {
      st = fs.statSync(t.path);
    } catch {
      if (t.required) unreadable.push(t.path);
      continue;
    }
    if (st.isDirectory()) walk(t.path);
    else if (st.isFile()) visit(t.path);
    else unreadable.push(t.path);
  }
  return { hits, files, unreadable };
}

module.exports = { envEntriesFrom, readEnvEntries, spellings, scanFile, defaultTargets, scan, CHUNK };
