// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/helpers-opon.js — session logs built by hand for the Ọpọ́n's replay
 * tests (Phase 2). Each mark gets the time the test chooses (`ms`, milliseconds
 * on the session's monotonic clock), so settling is shown on exact numbers.
 * Hand-built fixtures, labelled as such (brief line 761); made-up paths.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionLog } = require('../src/opon/ledger/session-log');
const { buildHeader } = require('../src/opon/intake/header');
const crypto = require('crypto');
const { canonicalize } = require('../src/verify/canonical');

const SID = 'ses_replay_test';
const NS = 1000000n;
const T0 = 1000n * 1000000000n; // the clock at the header: 1,000 s since boot
const ns = (ms) => String(T0 + BigInt(ms) * NS);
const wall = (ms) => new Date(Date.UTC(2026, 10, 22, 12, 0, 0) + ms).toISOString();
const FP = (c) => 'sha256:' + String(c).repeat(64).slice(0, 64);

let codeDir = null;
function tinyCode() {
  if (!codeDir) {
    codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-code-'));
    fs.writeFileSync(path.join(codeDir, 'x.js'), '// code\n');
  }
  return codeDir;
}

/**
 * A new session folder under `base` with `config` in its header; returns { dir, root, append(mark), seqs }.
 * `baseline`: entries for a baseline snapshot kept beside the log (slice N2), sorted and written as
 * src/opon/net/baseline.js writes them, its fingerprint in the header.
 * `byproducts`: { text, inHeader } writes the project's `.orunmila/byproducts` before the header is
 * built (its fingerprint is then frozen), and with `inHeader` the header carries the list (A1a).
 * `sessionId`, `root` and `startMs` build a second session beside the first (A2): its own id, the
 * same or another project folder, and when its header was written. `onRecord` is the session log's
 * callback (L1c), so a test can feed a live engine; `sealedHeader` is the header as written.
 */
function makeLog(base, config = {}, { baseline = null, byproducts = null, sessionId = SID, root: rootIn = null, startMs = 0, onRecord = null, guard = null } = {}) {
  // .native: on Windows the long name (CI's temp folder is RUNNER~1, and a claim reader's path ends at a `~`); elsewhere as realpathSync.
  const root = rootIn || fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-root-')));
  const dir = path.join(base, sessionId);
  if (byproducts) {
    fs.mkdirSync(path.join(root, '.orunmila'));
    fs.writeFileSync(path.join(root, '.orunmila', 'byproducts'), byproducts.text);
  }
  const header = buildHeader({ sessionId, root, agent: { name: 'claude-code', version: null }, orunmilaVersion: '0.0.0-test', codeRoot: tinyCode(), lawPacks: {}, hookSettings: [], config, observedAt: wall(startMs), monoNs: ns(startMs), byproducts: Boolean(byproducts && byproducts.inHeader) });
  let text = null;
  if (baseline) {
    text = [...baseline].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => canonicalize(e) + '\n').join('');
    header.baseline = { fingerprint: 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
  }
  const log = createSessionLog(dir, header, { baseline: text, onRecord, guard });
  const append = (m, files = []) => {
    const r = log.append(m, files);
    if (!r.ok) throw new Error(`the test's mark was refused: ${JSON.stringify(r)}`);
    return r.seq;
  };
  return { dir, root, append, header, sealedHeader: log.header(), log };
}

const base = (ms, over) => ({ schema_version: 1, session_id: SID, agent: null, turn: null, sub_agent: null, observed_at: wall(ms), mono_ns: ns(ms), cause_hint: null, ...over });

/** Mark builders: each takes the time in ms and the facts it needs. */
const M = {
  tick: (ms) => base(ms, { source: 'process', target: null, says: 'tick', detail: {} }),
  started: (ms, call, target, tool = 'Edit', turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, cause_hint: call, target, says: 'started', detail: { tool } }),
  edited: (ms, call, file, says = 'modified', turn = 't1') =>
    base(ms, {
      source: 'hook',
      agent: 'claude-code',
      turn,
      cause_hint: call,
      target: { kind: 'file', path: file },
      says,
      detail: says === 'created' ? { tool: 'Write', exit_status: 'pass', size: 4, fingerprint: FP('b'), lines_added: null, lines_removed: null } : { tool: 'Edit', exit_status: 'pass', size: 4, fingerprint_before: says === 'deleted' ? FP('a') : FP('a'), fingerprint: says === 'deleted' ? null : FP('b'), lines_added: null, lines_removed: null },
    }),
  disk: (ms, file, says = 'modified', extra = {}) =>
    base(ms, {
      source: 'sentinel',
      target: { kind: 'file', path: file },
      says,
      detail: says === 'created' ? { root: '/r', size: 4, fingerprint: FP('c'), lines_added: null, lines_removed: null, ...extra } : { root: '/r', size: 4, fingerprint_before: says === 'renamed' ? FP('c') : FP('c'), fingerprint: says === 'deleted' ? null : FP('d'), lines_added: null, lines_removed: null, ...extra },
    }),
  exited: (ms, call, text, status = 'pass', turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, cause_hint: call, target: { kind: 'command', text }, says: 'exited', detail: { tool: 'Bash', exit_status: status, output_excerpt: '' } }),
  read: (ms, call, file, turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, cause_hint: call, target: { kind: 'file', path: file }, says: 'read', detail: { tool: 'Read', exit_status: 'pass', read_kind: 'full', size: 4, fingerprint: FP('a') } }),
  prompted: (ms, turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, target: { kind: 'turn', id: turn }, says: 'prompted', detail: { prompt: 'go', from_human: true } }),
  claimed: (ms, turn = 't1') => base(ms, { source: 'agent_claim', agent: 'claude-code', turn, target: { kind: 'claim' }, says: 'claimed', detail: { text: 'done' } }),
  turnEnded: (ms, turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, target: { kind: 'turn', id: turn }, says: 'ended', detail: {} }),
  // A tool call other than a command that failed: `ended` (line 259).
  failed: (ms, call, target, tool = 'Edit', turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, cause_hint: call, target, says: 'ended', detail: { tool, exit_status: 'fail' } }),
  called: (ms, call, name, turn = 't1') => base(ms, { source: 'hook', agent: 'claude-code', turn, cause_hint: call, target: { kind: 'tool', name }, says: 'called', detail: { tool: name, exit_status: 'pass', tool_input: {} } }),
  sessionEnded: (ms) => base(ms, { source: 'hook', agent: 'claude-code', target: { kind: 'session', id: SID }, says: 'ended', detail: {} }),
  gap: (ms, lost = 'a test gap') => base(ms, { source: 'process', target: null, says: 'gap', detail: { lost } }),
  // Station 4 (N2, LD171): the Opon's own fingerprint of a target at settle time; 'absent' when no file is there.
  fingerprinted: (ms, file, fp) =>
    base(ms, { source: 'process', target: { kind: 'file', path: file }, says: 'fingerprinted', detail: fp === 'absent' ? { exists: false } : { exists: true, size: 4, fingerprint: fp } }),
};

/** A mark of another session (A2): the same mark, its session id swapped, and a session end naming that session. */
const as = (sid, m) => ({ ...m, session_id: sid, ...(m.target && m.target.kind === 'session' ? { target: { kind: 'session', id: sid } } : {}) });

module.exports = { makeLog, M, ns, wall, SID, FP, as };
