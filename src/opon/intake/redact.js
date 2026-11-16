'use strict';

/**
 * src/opon/intake/redact.js — redaction at intake, before anything is hashed or
 * written (brief v3 lines 248-249, 266; Phase 1 slice A6).
 *
 *   redactText(text, envValues)   { text, kinds }: today's secrets.js patterns
 *                                 (used, not changed), and the given `.env`
 *                                 values, replaced with [REDACTED:<kind>]
 *   redactMark(mark, envValues)   { mark, kinds }: every string in the mark,
 *                                 with the kinds noted in detail.redactions
 *   envValuesFrom(text)           the values of a `.env`-style file, 8+ chars
 *   onRedactionList(relPath)      true for `.env` and `.env.*`
 *   fingerprint(relPath, buf, key) keyed HMAC-SHA-256 for a file on the
 *                                 redaction list, plain SHA-256 otherwise
 *
 * `.env` values are held in memory only, by the caller; this module never
 * writes them. Redaction cannot recognise every unknown secret format.
 */

const crypto = require('crypto');
const path = require('path');
const { redactString } = require('../../store/secrets');

const MIN_ENV_VALUE = 8; // shorter values (true, 3000, dev) would redact ordinary words
const ENV_KIND = 'env_value';

function redactText(text, envValues = []) {
  if (typeof text !== 'string') return { text, kinds: [] };
  const kinds = new Set();
  let out = text;
  const values = [...new Set(envValues)].filter((v) => typeof v === 'string' && v.length >= MIN_ENV_VALUE).sort((a, b) => b.length - a.length);
  for (const v of values) {
    if (out.includes(v)) {
      out = out.split(v).join(`[REDACTED:${ENV_KIND}]`);
      kinds.add(ENV_KIND);
    }
  }
  const r = redactString(out);
  for (const k of r.kinds) kinds.add(k);
  return { text: r.text, kinds: [...kinds].sort() };
}

function walk(value, envValues, kinds) {
  if (typeof value === 'string') {
    const r = redactText(value, envValues);
    for (const k of r.kinds) kinds.add(k);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, envValues, kinds));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, envValues, kinds);
    return out;
  }
  return value;
}

/** A redacted copy of a mark (the input is not changed). Kinds go in detail.redactions when detail is an object. */
function redactMark(mark, envValues = []) {
  const found = new Set();
  const out = walk(mark, envValues, found);
  const kinds = [...found].sort();
  if (kinds.length && out && out.detail && typeof out.detail === 'object' && !Array.isArray(out.detail)) {
    const before = Array.isArray(out.detail.redactions) ? out.detail.redactions : [];
    out.detail.redactions = [...new Set([...before, ...kinds])].sort();
  }
  return { mark: out, kinds };
}

/** Values from `KEY=VALUE` lines (optional `export `, optional quotes); comments and short values skipped. */
function envValuesFrom(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq).trim())) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    if (v.length >= MIN_ENV_VALUE) out.push(v);
  }
  return out;
}

function onRedactionList(relPath) {
  const base = path.basename(String(relPath));
  return base === '.env' || base.startsWith('.env.');
}

function fingerprint(relPath, buf, key) {
  if (onRedactionList(relPath)) {
    if (!key || !key.length) throw new Error(`a file on the redaction list needs the install key to be fingerprinted: ${relPath}`);
    return 'hmac-sha256:' + crypto.createHmac('sha256', key).update(buf).digest('hex');
  }
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = { redactText, redactMark, envValuesFrom, onRedactionList, fingerprint, MIN_ENV_VALUE };
