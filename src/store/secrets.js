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

const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
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

// Patterns that keep a readable prefix and mask only the secret part.
const PREFIXED = [
  ['bearer_token', /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g],
  ['url_credentials', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi],
  // FOO_TOKEN=..., API_KEY: "...", DB_PASSWORD='...'. Upper-case names only, so
  // code such as `password = input()` is left alone; a value that is itself a
  // reference ($VAR, ${VAR}, process.env.X, os.environ[...]) is not a secret.
  [
    'secret_assignment',
    /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)(?!\$|process\.env|os\.environ|\[REDACTED)([^\s"'`]{8,})/g,
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
  for (const [kind, re] of PREFIXED) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      text = text.replace(re, (_m, prefix) => `${prefix}[REDACTED:${kind}]`);
      kinds.push(kind);
    }
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

module.exports = { redactString, redactEvent, PATTERNS, PREFIXED };
