// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/support.js — DOC6 (Phase 7; brief v4 lines 727-733): how far each agent adapter is supported, stated
 * plainly, in one place, so the docs, `orunmila report` and a later test run read the same words. Not loaded by any
 * hook (capture's code is unchanged by it).
 *
 *   SUPPORT                 adapter id -> { status: 'supported' | 'experimental', words }
 *   supportOf(id)           that entry, or { status: 'none', words } for an agent with no adapter (Windsurf has none)
 *   experimentalNote(id, label)  the line a session report opens with for an experimental adapter's session, or null
 *
 * Cursor's line is set from the result of the brief's real-session tests (test 49, CU2).
 */

const SAMPLE = 'experimental: built, tested only with sample data; results may be wrong';

const SUPPORT = {
  'claude-code': { status: 'supported', words: 'fully supported, tested on real sessions' },
  // CU2 (test 49, 2026-11-28, session b4096a3b): four real sessions in Cursor's command-line agent 2026.11.22, every
  // check right and the false claim caught, after CU1. The editor's agent was not run.
  cursor: { status: 'supported', words: "supported, tested on real sessions in Cursor's command-line agent (test 49): the Stain Map only, no Closeout Gate; the editor's agent reads the same hooks file, not yet run there" },
  'gemini-cli': { status: 'experimental', words: SAMPLE },
  codex: { status: 'experimental', words: SAMPLE },
  continue: { status: 'experimental', words: SAMPLE },
  antigravity: { status: 'experimental', words: SAMPLE },
  generic: { status: 'experimental', words: SAMPLE },
  aider: { status: 'experimental', words: 'experimental, sentinel only (Aider has no hooks); results may be wrong' },
};

function supportOf(id) {
  return SUPPORT[String(id || '')] || { status: 'none', words: 'no adapter exists' };
}

function experimentalNote(id, label = id) {
  const s = supportOf(id);
  return s.status === 'experimental' ? `Experimental adapter (${label}): ${s.words}.` : null;
}

module.exports = { SUPPORT, supportOf, experimentalNote };
