'use strict';

/**
 * secrets.js
 *
 * Capture-time secret redaction (0.2.2). The event log is append-only in
 * spirit: once a secret is written there it sits on disk until the user acts.
 * So known secret shapes are replaced with `[REDACTED:<kind>]` BEFORE an event
 * is written, and the event records which kinds were removed in `redactions`
 * (never the values).
 *
 * Deliberately high-precision: each pattern matches a credential's published
 * shape (provider prefixes, PEM armour, JWT structure) or an upper-case
 * env-style assignment, never "anything that looks random". A false positive
 * corrupts evidence; a missed unknown format is a limit the docs state plainly.
 * Hex content hashes (sha256 etc.) match none of these.
 */

// A PEM key with no END line in the text (cut off by the 2000-char excerpt, a
// truncated tool output or a diff hunk) cannot be bounded by shape: key lines
// arrive indented, tab-led, CRLF, space-joined, JSON-escaped or escaped twice.
// It is bounded by size instead: the header and the next PEM_TAIL_MAX
// characters go, stopping early at the next `-----BEGIN ` (a later key or a
// certificate), then on to the end of the line the cut lands in, at most
// PEM_LINE_MAX more, so a one-line minified file is not eaten whole. 16384
// covers the largest real key (RSA-16384 with a passphrase, about 12.7k body
// characters) after indentation, a diff prefix and double escaping. A complete
// key is removed whole whatever its size; its END search also stops at the
// next BEGIN, so a cut-off key cannot run on to a later key's END, and many
// headers cost one pass over the text, not one each.
const PEM_TAIL_MAX = 16384;
const PEM_LINE_MAX = 128;
const PEM_HEADER = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`;
const PEM_FOOTER = String.raw`-----END [A-Z ]*PRIVATE KEY-----`;
// One character that is not the start of `-----BEGIN `. A plain lookahead, not
// an alternation: V8 keeps one backtrack entry per lazy iteration, and an
// alternation inside that loop overflowed its stack at 20 MB where this does not.
const NOT_BEGIN = String.raw`(?:(?!-----BEGIN )[\s\S])`;
// One such character that is also not a real or JSON-escaped line break.
const NOT_BEGIN_NOT_NL = String.raw`(?:(?!-----BEGIN |\\[rn])[^\r\n])`;

const PATTERNS = [
  ['private_key', new RegExp(String.raw`${PEM_HEADER}(?:${NOT_BEGIN}*?${PEM_FOOTER}|${NOT_BEGIN}{0,${PEM_TAIL_MAX}}${NOT_BEGIN_NOT_NL}{0,${PEM_LINE_MAX}})`, 'g')],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// A bare number under a secret-style name is a credential (ACCESS_KEY=123456789012,
// OTP_TOKEN=12345678, DB_PASSWORD=12345678) unless the name says it is a
// quantity: one whole `_`-separated word from the list below, digits allowed
// after it (LIMIT2). MAX_TOKEN_COUNT=100000000, API_KEY_TTL=86400000 and
// PASSWORD_MAX_AGE=86400000 are kept; TOKEN_MAXWELL, MSG_TOKEN and IMAGE_TOKEN
// hold no whole count word, so they are not.
const COUNT_WORDS = ['COUNT', 'LIMIT', 'MAX', 'MIN', 'SIZE', 'LEN', 'LENGTH', 'TTL', 'TIMEOUT', 'AGE', 'SECONDS', 'MS', 'DAYS'];
const COUNT_WORD = new RegExp(String.raw`(?:^|_)(?:${COUNT_WORDS.join('|')})\d*(?=_|\s*[=:])`);
const BARE_NUMBER = /^\d[\d_.]*[,;]?$/;

// Patterns that keep a readable prefix and mask only the secret part. An
// optional third element names matches to leave alone: (prefix, value) => bool.
const PREFIXED = [
  ['bearer_token', /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g],
  ['url_credentials', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi],
  // FOO_TOKEN=..., API_KEY: "...", DB_PASSWORD='...'. Upper-case names only, so
  // code such as `password = input()` is left alone; a value that is itself a
  // reference ($VAR, ${VAR}, process.env.X, os.environ[...]) is not a secret.
  [
    'secret_assignment',
    /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)(?!\$|process\.env|os\.environ|\[REDACTED)([^\s"'`]{8,})/g,
    (prefix, value) => BARE_NUMBER.test(value) && COUNT_WORD.test(prefix),
  ],
];

/** Redact one string. Returns { text, kinds } where kinds lists what was removed. */
function redactString(input) {
  if (typeof input !== 'string' || input.length < 8) return { text: input, kinds: [] };
  let text = input;
  const kinds = [];
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      text = text.replace(re, `[REDACTED:${kind}]`);
      kinds.push(kind);
    }
  }
  for (const [kind, re, keep] of PREFIXED) {
    re.lastIndex = 0;
    let hit = false;
    text = text.replace(re, (m, prefix, value) => {
      if (keep && keep(prefix, value)) return m;
      hit = true;
      return `${prefix}[REDACTED:${kind}]`;
    });
    if (hit) kinds.push(kind);
  }
  return { text, kinds };
}

function walk(value, kinds) {
  if (typeof value === 'string') {
    const r = redactString(value);
    for (const k of r.kinds) kinds.add(k);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, kinds));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, kinds);
    return out;
  }
  return value;
}

/**
 * Redact every string field of an event (recursively, so a tool call's raw
 * `input` object is covered). Returns a new event; when anything was removed
 * it carries `redactions: [kind, ...]`, sorted and de-duplicated.
 */
function redactEvent(event) {
  const kinds = new Set(Array.isArray(event.redactions) ? event.redactions : []);
  const out = walk(event, kinds);
  if (kinds.size) out.redactions = [...kinds].sort();
  return out;
}

module.exports = { redactString, redactEvent, PATTERNS, PREFIXED, PEM_TAIL_MAX, PEM_LINE_MAX, COUNT_WORDS };
