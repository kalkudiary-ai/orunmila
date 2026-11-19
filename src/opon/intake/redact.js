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
 *   envEntriesFrom(text)          [{ name, value }] of a `.env`-style file, each
 *                                 line cut by dotenv's and a shell's rules (LD98): 8+ chars,
 *                                 or 4-7 under a secret name (LD88)
 *   envValuesFrom(text)           the values of envEntriesFrom
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
// `-W pw12` but not in `pw123`. A JSON escape (`\b \f \n \r \t`, or `\u` and
// four hex digits) before it counts as a boundary, and a value's own non-word
// edge needs none; a short value with no letter or digit is not used (LD91).
// An escape is an odd run of backslashes, and an escape's letter is never the
// start of a value (LD92). Under 4 characters
// nothing is redacted by value: it would hit ordinary text everywhere, and
// patterns may still catch it.
const MIN_ENV_VALUE = 8;
const MIN_SHORT_SECRET = 4;
const ENV_KIND = 'env_value';
const REDACTED = `[REDACTED:${ENV_KIND}]`;
const [, SECRET_ASSIGNMENT, KEEP_COUNT] = PREFIXED.find(([kind]) => kind === 'secret_assignment');
const NO_VALUE = /^(?:true|false|yes|no|on|off|null|none|nil|undefined)$/i;
const WORD = /[A-Za-z0-9_]/;
// LD92: an escape is a backslash run of odd length, so `\\` (an escaped
// backslash) starts none. The character at i is escaped when an odd run ends
// just before it.
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const escapedAt = (s, i) => {
  let k = 0;
  while (i - 1 - k >= 0 && s[i - 1 - k] === '\\') k++;
  return k % 2 === 1;
};
// A JSON escape's letter sits at i: \b \f \n \r \t, or \u and four hex digits.
const escapeLetterAt = (s, i) => 'bfnrt'.includes(s[i]) || (s[i] === 'u' && HEX4.test(s.slice(i + 1, i + 5)));
// A JSON escape ends just before i (LD91), counted from a real escape (LD92).
const escapeEndsAt = (s, i) => ('bfnrt'.includes(s[i - 1]) && escapedAt(s, i - 1))
  || (i >= 5 && s[i - 5] === 'u' && HEX4.test(s.slice(i - 4, i)) && escapedAt(s, i - 5));
// Before a value at i: a non-word, or the end of a JSON escape. A value whose
// first letter is an escape's own (`\n123` for n123) is not there: that n is
// the escape's. Plain text cannot be told from JSON, so `C:\n123` keeps n123:
// a declared miss, never a damaged record (LD92).
function boundaryBefore(s, i) {
  if (i === 0) return true;
  if (escapedAt(s, i)) return !escapeLetterAt(s, i);
  return !WORD.test(s[i - 1]) || escapeEndsAt(s, i);
}
// Each occurrence is tested where it stands, stepping one character past a miss,
// so a value inside a longer word never hides a later whole-word one.
function replaceWholeWord(s, v) {
  const needBefore = WORD.test(v[0]);
  const needAfter = WORD.test(v[v.length - 1]);
  let out = '';
  let from = 0;
  let i = s.indexOf(v);
  while (i !== -1) {
    const end = i + v.length;
    if ((!needBefore || boundaryBefore(s, i)) && (!needAfter || end === s.length || !WORD.test(s[end]))) {
      out += s.slice(from, i) + REDACTED;
      from = end;
      i = s.indexOf(v, end);
    } else {
      i = s.indexOf(v, i + 1);
    }
  }
  return out + s.slice(from);
}

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
  const values = [...new Set(envValues)]
    .filter((v) => typeof v === 'string' && (v.length >= MIN_ENV_VALUE || (v.length >= MIN_SHORT_SECRET && /[A-Za-z0-9]/.test(v))))
    .sort((a, b) => b.length - a.length);
  for (const v of values) {
    const next = v.length >= MIN_ENV_VALUE ? out.split(v).join(REDACTED) : replaceWholeWord(out, v);
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

/**
 * The name and the values one `.env` line may mean (LD96, LD98). A quoted value
 * (' " `) ends at the first matching quote followed only by spaces or a
 * comment. An unquoted value is cut at a `#`: dotenv cuts at any `#`, a shell
 * only at ` #`, so both are kept; `NAME= #x` (space, then #) is all comment,
 * `NAME=#x` is `#x` to a shell. Each value's core (trimmed, one pair of ' or "
 * off) is kept beside it, so a bare inner value is caught too. An empty value
 * is none.
 */
const core = (x) => {
  const t = x.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
};
function dotenvLine(raw) {
  const line = raw.trim().replace(/^export\s+/, '');
  const eq = line.indexOf('=');
  if (eq < 1) return { name: '', values: [] };
  const name = line.slice(0, eq).trim();
  const after = line.slice(eq + 1);
  const v = after.trim();
  let values = [v];
  if (v[0] === '"' || v[0] === "'" || v[0] === '`') {
    for (let end = v.indexOf(v[0], 1); end !== -1; end = v.indexOf(v[0], end + 1)) {
      if (/^\s*(?:#.*)?$/.test(v.slice(end + 1))) {
        values = [v.slice(1, end)];
        break;
      }
    }
  } else if (/^\s+#/.test(after)) {
    values = []; // `NAME= # comment`: the whole value is a comment
  } else if (v.includes('#')) {
    values = [v.slice(0, v.indexOf('#')).trimEnd(), v.slice(0, v.search(/\s#|$/)).trimEnd()];
  }
  return { name, values: [...new Set(values.flatMap((x) => [x, core(x)]))].filter(Boolean) };
}

/**
 * [{ name, value }] from `KEY=VALUE` lines (optional `export `), each cut as
 * dotenvLine says; a line whose name is not a shell name (`# KEY=v` gives
 * `# KEY`) is skipped; short values as LD88. The leak check reads this too,
 * so it looks for exactly what is redacted (LD98).
 */
function envEntriesFrom(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const { name, values } = dotenvLine(raw);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    for (const v of values) if (v.length >= MIN_ENV_VALUE || shortSecret(name, v)) out.push({ name, value: v });
  }
  return out;
}

/** The values of envEntriesFrom, in order. */
function envValuesFrom(text) {
  return envEntriesFrom(text).map((e) => e.value);
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

module.exports = { redactText, redactMark, envEntriesFrom, envValuesFrom, onRedactionList, fingerprint, MIN_ENV_VALUE, MIN_SHORT_SECRET };
