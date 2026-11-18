'use strict';

/**
 * src/opon/intake/test-command.js — the project's own test command, read and
 * frozen at session start (Phase 1 slice B8; brief v4 line 283, "every
 * configured value", and line 349, configuration frozen at session start;
 * decision LD70). Pure: it reads the project's package.json and nothing else.
 * Phase 3's second witness for test results (ledger A1) re-runs the frozen
 * command, never today's.
 *
 *   testCommandFrom(root, envValues?)
 *     -> { text, source, scripts_fingerprint }, the header's `test_command`:
 *        text                 package.json's scripts.test, redacted; null when
 *                             there is none
 *        source               { path: 'package.json', key: 'scripts.test' },
 *                             or null with no text
 *        scripts_fingerprint  plain SHA-256 of the RFC 8785 form of the whole
 *                             `scripts` block, its string values redacted
 *                             first (script names and non-string values are
 *                             hashed as written; only the hash is kept); null
 *                             when the block is unknown: no regular file of at
 *                             most 1 MiB (LD71), not JSON (a leading BOM
 *                             included), no `scripts` object, or a value RFC
 *                             8785 cannot hold
 *   testCommandChange(frozen, root, envValues?)
 *     -> null when the scripts block is as frozen, else the evidence for a
 *        `tampered` mark (`detail.what` `frozen_config`, brief line 245)
 *
 * Why the scripts block and not the whole file: package.json changes in
 * ordinary work (an install, a version bump), and in this repo 6 of the 7
 * changes to it touched no script (LD70). Why the whole block and not only
 * `test`: a test script can run another script (`npm run unit`), so editing
 * that one changes what the tests are. `test_changed` says whether the test
 * text itself moved.
 *
 * Limits: package.json at the project root only (no other ecosystem, no
 * workspace); files a test runner reads (its own config, the tests) are not
 * frozen here; they are ordinary changes, judged in Phase 3 (ledger A2). A
 * secret swapped for another that redacts alike is not seen. While the block
 * is unknown both at the start and now, its changes are not seen.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalize } = require('../../verify/canonical');
const { redactText } = require('./redact');

const FILE = 'package.json';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const MAX_BYTES = 1024 * 1024; // LD71

function redactedScripts(root, envValues) {
  let pkg;
  try {
    const p = path.join(root, FILE);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null; // a FIFO would stall the session start; a huge file would fill the header
    pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(pkg) || !isObject(pkg.scripts)) return null;
  // fromEntries keeps a script named __proto__ as a key of its own
  return Object.fromEntries(Object.entries(pkg.scripts).map(([k, v]) => [k, typeof v === 'string' ? redactText(v, envValues).text : v]));
}

function testCommandFrom(root, envValues = []) {
  const none = { text: null, source: null, scripts_fingerprint: null };
  const scripts = redactedScripts(root, envValues);
  if (!scripts) return none;
  let canonical;
  try {
    canonical = canonicalize(scripts);
  } catch {
    return none; // a block JCS cannot hold (a lone surrogate) would break the header's own hash
  }
  const text = typeof scripts.test === 'string' ? scripts.test : null;
  return {
    text,
    source: text === null ? null : { path: FILE, key: 'scripts.test' },
    scripts_fingerprint: 'sha256:' + crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
  };
}

function testCommandChange(frozen, root, envValues = []) {
  const now = testCommandFrom(root, envValues);
  if (now.scripts_fingerprint === frozen.scripts_fingerprint) return null;
  return {
    what: 'frozen_config',
    frozen: 'test_command',
    fingerprint_before: frozen.scripts_fingerprint,
    fingerprint: now.scripts_fingerprint,
    test_changed: now.text !== frozen.text,
    text_before: frozen.text,
    text: now.text,
  };
}

module.exports = { testCommandFrom, testCommandChange };
