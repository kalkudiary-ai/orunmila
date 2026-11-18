'use strict';

/**
 * src/opon/intake/header.js — builds a session's header record (brief v3 line
 * 282; Phase 1 slice A10): everything needed to reproduce the session's
 * results, as it was at session start. Replay reads these values from the
 * header, never from current settings (configFromHeader).
 *
 *   buildHeader({ sessionId, root, agent, orunmilaVersion, codeRoot, lawPacks,
 *                 hookSettings, config?, observedAt?, monoNs?, envValues? })
 *     -> the header without seq / prev_hash / hash (intake seals it); its
 *        test_command is the project's test command, frozen (slice B8, LD70)
 *   codeFingerprint(dir)       one fingerprint over every file under dir
 *                              (path and content), for Orunmila's own code
 *                              (ledger A3, NF41); a change mid-session is a
 *                              tampering mark (slice B3)
 *   hooksReportFrom(settings)  which tools the agent's hooks report before and
 *                              after they run (line 337), from its settings
 *   configFromHeader(header)   the configuration replay must use
 *
 * Frozen files are fingerprinted with plain SHA-256; an absent file, or one
 * that is not a regular file (a FIFO, a folder; NF83), is null.
 * Accounts: the agent's and Orunmila's are the same until the separate-user
 * setup in Phase 5 (line 587).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { monoString, nowMono } = require('./mono');
const { testCommandFrom } = require('./test-command');
const { readRegular } = require('./regular-file');

// Brief v3: quiet window 1,500 ms (line 356), ceiling 30 s (357), lag grace
// 3,000 ms (362). The diff size limit (line 266) is the agent's choice (LD38).
const DEFAULT_CONFIG = { quiet_window_ms: 1500, ceiling_ms: 30000, lag_grace_ms: 3000, exclusions: [], diff_size_limit_bytes: 10 * 1024 * 1024 };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Only a regular file is read (NF83): a FIFO would stall the session start.
const fingerprintOf = (buf) => (buf === null ? null : 'sha256:' + sha256(buf));
const fileFingerprint = (p) => fingerprintOf(readRegular(p));

function codeFingerprint(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(dir);
  const lines = files
    .map((p) => `${path.relative(dir, p).split(path.sep).join('/')}\0${sha256(fs.readFileSync(p))}\n`)
    .sort();
  return 'sha256:' + sha256(lines.join(''));
}

function hooksReportFrom(settingsList) {
  const out = { before: [], after: [] };
  const add = (list, matcher) => {
    for (const m of String(matcher || '*').split('|').map((s) => s.trim() || '*')) if (!list.includes(m)) list.push(m);
  };
  for (const s of settingsList) {
    const hooks = (s && s.hooks) || {};
    for (const [event, list] of [['PreToolUse', out.before], ['PostToolUse', out.after]]) {
      for (const entry of hooks[event] || []) {
        const ours = ((entry && entry.hooks) || []).some((h) => /(pre|post)-tool-use\.js/.test(String(h && h.command)));
        if (ours) add(list, entry.matcher);
      }
    }
  }
  return out;
}

function buildHeader(o) {
  const user = os.userInfo().username;
  const orunmilaDir = path.join(o.root, '.orunmila');
  const settings = [];
  const hookSettings = {};
  for (const p of o.hookSettings || []) {
    const buf = readRegular(p); // read once: the fingerprint and the hooks report are of the same bytes
    hookSettings[p] = fingerprintOf(buf);
    try {
      if (buf !== null) settings.push(JSON.parse(buf.toString('utf8')));
    } catch {}
  }
  const lawPacks = {};
  for (const [name, p] of Object.entries(o.lawPacks || {})) lawPacks[name] = fileFingerprint(p);
  const config = { ...DEFAULT_CONFIG, exclusions: [...DEFAULT_CONFIG.exclusions], ...(o.config || {}) };
  return {
    schema_version: 1,
    record: 'session_header',
    session_id: o.sessionId,
    observed_at: o.observedAt || new Date().toISOString(),
    mono_ns: monoString(o.monoNs) || nowMono(), // a decimal string (brief v4 line 238)
    orunmila: { version: o.orunmilaVersion, code_fingerprint: codeFingerprint(o.codeRoot) },
    agent: { name: o.agent.name, version: o.agent.version === undefined ? null : o.agent.version },
    os: { platform: process.platform, release: os.release() },
    accounts: { agent_user: user, orunmila_user: user },
    project_root: fs.realpathSync(o.root),
    config,
    frozen: {
      rules: fileFingerprint(path.join(orunmilaDir, 'rules')),
      byproducts: fileFingerprint(path.join(orunmilaDir, 'byproducts')),
      ignore: fileFingerprint(path.join(orunmilaDir, 'ignore')),
      law_packs: lawPacks,
      hook_settings: hookSettings,
    },
    hooks_report: hooksReportFrom(settings),
    test_command: testCommandFrom(o.root, o.envValues),
  };
}

function configFromHeader(header) {
  if (!header || !header.config || typeof header.config !== 'object') throw new Error('the session header has no config to replay with');
  return JSON.parse(JSON.stringify(header.config));
}

module.exports = { buildHeader, codeFingerprint, hooksReportFrom, configFromHeader, DEFAULT_CONFIG };
