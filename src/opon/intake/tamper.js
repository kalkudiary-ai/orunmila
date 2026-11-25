// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/tamper.js — tampering marks for what was frozen at session
 * start (slice B3, LD147; brief v4 lines 245, 349-350; tests 10, 30, 42, 52,
 * mark side; ledger A3, NF41, NF42).
 *
 *   createTamperWatch({ header, codeRoot, lawPacks, prior, clock })
 *     header     the session's header (what was frozen, line 349)
 *     lawPacks   { name: path } as the header was built with
 *     prior      the session's earlier tampered marks (a restart goes on from them)
 *     .check()   every frozen item fingerprinted again: one `tampered` mark per
 *                item whose fingerprint differs from the last one recorded for
 *                it (the header's, or the last tampered mark's)
 *     .saw(abs, fingerprint, before)
 *                a Sentinel mark for a file in the project's `.orunmila/` (test
 *                10): a tampered mark when that fingerprint is new for the file;
 *                `before` is the Sentinel's, used for a file that was not frozen
 *   Marks carry no session_id (the router adds it): source `process`, target
 *   the file (or Orunmila's code folder, `dir`), detail { what,
 *   fingerprint_before, fingerprint, reason }; `null` fingerprints mean absent.
 *
 * `what`: the rules, byproducts and ignore lists, the law packs, and any other
 * file in `.orunmila/` are `frozen_config`; the agent's hook settings
 * `hook_settings`; Orunmila's own code `orunmila_code`. Fingerprints are plain
 * SHA-256, as the header's. Preventing the change (the separate user) is Phase
 * 5; the change to frozen configuration does not take effect until the next
 * session (Phase 3 reads the header's copy), but Claude Code reloads hook
 * settings at once (NF42), which the mark says.
 */

const path = require('path');
const crypto = require('crypto');
const { readRegular } = require('./regular-file');
const { codeFingerprint } = require('./header');

const plain = (p) => {
  const buf = readRegular(p);
  return buf === null ? null : 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
};

const REASON = {
  frozen_config: 'changed during the session; the session goes on with the copy frozen at its start, and the change takes effect only at the next session',
  hook_settings: "the agent's hook settings changed during the session; Claude Code may already use the change (NF42), so the record from here on may not be what was frozen",
  orunmila_code: "Orunmila's own code changed during the session; the code that records the rest of it may not be the code fingerprinted at its start",
};

function itemsOf(header, codeRoot, lawPacks) {
  const root = header.project_root;
  const fz = header.frozen || {};
  const items = [];
  for (const name of ['rules', 'byproducts', 'ignore']) items.push({ what: 'frozen_config', abs: path.join(root, '.orunmila', name), frozen: fz[name] === undefined ? null : fz[name], now: plain });
  for (const [name, fp] of Object.entries(fz.law_packs || {})) {
    if (lawPacks && lawPacks[name]) items.push({ what: 'frozen_config', abs: lawPacks[name], frozen: fp, now: plain });
  }
  for (const [p, fp] of Object.entries(fz.hook_settings || {})) items.push({ what: 'hook_settings', abs: p, frozen: fp, now: plain });
  if (codeRoot && header.orunmila) items.push({ what: 'orunmila_code', abs: codeRoot, dir: true, frozen: header.orunmila.code_fingerprint, now: (p) => codeFingerprint(p) });
  return items;
}

function createTamperWatch({ header, codeRoot, lawPacks, prior = [], clock }) {
  const items = itemsOf(header, codeRoot, lawPacks);
  const last = new Map(items.map((i) => [i.abs, i.frozen])); // abs path -> the last fingerprint recorded
  const whatOf = new Map(items.map((i) => [i.abs, i.what]));
  const absOf = (m) => (path.isAbsolute(m.target.path) ? m.target.path : path.join(header.project_root, m.target.path));
  for (const m of prior) if (m && m.target && typeof m.target.path === 'string' && m.detail) last.set(absOf(m), m.detail.fingerprint);

  function mark(abs, what, before, after, dir) {
    const now = clock();
    last.set(abs, after);
    return {
      schema_version: 1,
      source: 'process',
      agent: null,
      turn: null,
      sub_agent: null,
      observed_at: now.wall,
      mono_ns: now.mono,
      target: { kind: dir ? 'dir' : 'file', path: abs },
      says: 'tampered',
      detail: { what, fingerprint_before: before, fingerprint: after, reason: REASON[what] },
      cause_hint: null,
    };
  }

  function check() {
    const out = [];
    for (const i of items) {
      const fp = i.now(i.abs);
      const was = last.get(i.abs);
      if (fp !== was) out.push(mark(i.abs, i.what, was, fp, i.dir));
    }
    return out;
  }

  function saw(abs, fingerprint, before = null) {
    const was = last.has(abs) ? last.get(abs) : before;
    if (fingerprint === was) return null;
    return mark(abs, whatOf.get(abs) || 'frozen_config', was, fingerprint, false);
  }

  return { check, saw };
}

module.exports = { createTamperWatch };
