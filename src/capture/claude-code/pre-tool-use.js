#!/usr/bin/env node
'use strict';

/**
 * pre-tool-use.js
 *
 * Wired into .claude/settings.json as a PreToolUse hook. Claude Code pipes a
 * JSON payload on stdin and expects this process to exit fast (it's on the
 * critical path before the tool actually runs).
 *
 * Job here is narrow: for Write/Edit/MultiEdit tools, snapshot the file's
 * current content to a cache slot keyed by session+path, so post-tool-use.js
 * can compute a real before/after diff once the write actually happens.
 * Nothing here judges anything - this script only ever records, never blocks.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../../store/eventlog');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function cacheSlot(sessionId, filePath) {
  const dir = path.join(dataDir(), 'cache', sessionId || 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, encodeURIComponent(filePath) + '.before');
}

function main() {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // never block the agent over a parse hiccup
  }

  const toolName = payload.tool_name || '';
  const input = payload.tool_input || {};
  const sessionId = payload.session_id || 'unknown';

  if (/^(Write|Edit|MultiEdit)$/i.test(toolName)) {
    const filePath = input.file_path || input.path;
    if (filePath) {
      let before = '';
      try {
        before = fs.readFileSync(filePath, 'utf8');
      } catch {
        before = ''; // file doesn't exist yet - that's a legit "before" state too
      }
      try {
        fs.writeFileSync(cacheSlot(sessionId, filePath), before);
      } catch {
        // cache write failing should never block the agent's actual tool call
      }
    }
  }

  // Always exit 0 here. This hook observes; it does not gate. If you want a
  // gating hook (e.g. block edits to .env), write a separate one - don't
  // overload this script with policy decisions.
  process.exit(0);
}

main();
