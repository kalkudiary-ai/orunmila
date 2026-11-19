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
 *   envValuesFrom(text)           the values of a `.env`-style file: 8+ chars,
 *                                 or 4-7 under a secret name (LD88)
 *   onRedactionList(relPath)      true for `.env` and `.env.*`
 *   fingerprint(relPath, buf, key) keyed HMAC-SHA-256 for a file on the
 *                                 redaction list, plain SHA-256 otherwise
 *
 * `.env` values are held in memory only, by the caller; this module never
 * writes them. Redaction cannot recognise every unknown secret format.
 */

const crypto = require('crypto');
const path = require('path');
const { redactString, PREFIXED } = require('../../store/secrets');

// LD88 (replaces LD30). A value of 8+ characters is redacted wherever it
// occurs. A shorter one (4-7) is kept only under a name secrets.js's own
// secret_assignment rule calls a secret (SECRET, TOKEN, PASSWORD, ...), never a
// boolean, a no-value word (null, none) or a bare number under a count word
// (TOKEN_TTL=3600), and is redacted only as a whole word, so `pw12` hides in
// `-W pw12` but not in `pw123`. An escape in JSON text (`\npw12`) counts as a
// boundary, and a value's own non-word edge needs none. Under 4 characters
// nothing is redacted by value: it would hit ordinary text everywhere, and
// patterns may still catch it.
const MIN_ENV_VALUE = 8;
const MIN_SHORT_SECRET = 4;
const ENV_KIND = 'env_value';
const REDACTED = `[REDACTED:${ENV_KIND}]`;
const [, SECRET_ASSIGNMENT, KEEP_COUNT] = PREFIXED.find(([kind]) => kind === 'secret_assignment');
const NO_VALUE = /^(?:true|false|yes|no|on|off|null|none|nil|undefined)$/i;
const WORD = /[A-Za-z0-9_]/;
const BEFORE = String.raw`(?<![A-Za-z0-9_])|(?<=\\[A-Za-z]|\\u[0-9A-Fa-f]{4})`; // after a non-word, or after \n, \t, \u00e9
const wholeWord = (v) => {
  const body = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${WORD.test(v[0]) ? `(?:${BEFORE})` : ''}${body}${WORD.test(v[v.length - 1]) ? '(?![A-Za-z0-9_])' : ''}`, 'g');
};

/** True when secrets.js's secret_assignment rule reads NAME= as a secret's name. */
function secretName(name) {
  const prefix = `${name.toUpperCase()}=`;
  const m = new RegExp(SECRET_ASSIGNMENT.source).exec(prefix + 'x'.repeat(MIN_ENV_VALUE));
  return Boolean(m) && m.index === 0 && m[1] === prefix;
}

/** A 4-7 character value worth redacting: under a secret name, not a boolean, not a count. */
function shortSecret(name, v) {
  if (v.length < MIN_SHORT_SECRET || !secretName(name)) return false;
  if (NO_VALUE.test(v)) return false;
  return !KEEP_COUNT(`${name.toUpperCase()}=`, v);
}

function redactText(text, envValues = []) {
  if (typeof text !== 'string') return { text, kinds: [] };
  const kinds = new Set();
  let out = text;
  const values = [...new Set(envValues)].filter((v) => typeof v === 'string' && v.length >= MIN_SHORT_SECRET).sort((a, b) => b.length - a.length);
  for (const v of values) {
    const next = v.length >= MIN_ENV_VALUE ? out.split(v).join(REDACTED) : out.replace(wholeWord(v), () => REDACTED);
    if (next !== out) {
      out = next;
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

/** Values from `KEY=VALUE` lines (optional `export `, optional quotes); comments skipped, short values as LD88. */
function envValuesFrom(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = line.slice(0, eq).trim();
    if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    if (v.length >= MIN_ENV_VALUE || shortSecret(name, v)) out.push(v);
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

module.exports = { redactText, redactMark, envValuesFrom, onRedactionList, fingerprint, MIN_ENV_VALUE, MIN_SHORT_SECRET };
