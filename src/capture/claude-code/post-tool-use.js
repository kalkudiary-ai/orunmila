#!/usr/bin/env node
'use strict';

/**
 * post-tool-use.js
 *
 * Wired to both PostToolUse and PostToolUseFailure in settings.json (same
 * script - failure payloads carry the same tool_name/tool_input plus error
 * fields, so we branch on that instead of duplicating logic).
 *
 * This is the main ground-truth capture point:
 *   - Write/Edit/MultiEdit -> real before/after diff, using the snapshot
 *     pre-tool-use.js cached.
 *   - Bash -> command + exit code (this is what later lets us catch a claim
 *     like "tests pass" against an actual non-zero exit code).
 *   - everything else (including MCP tools) -> generic tool_call/tool_result
 *     pair with a success flag. This is what powers the "sent but failed,
 *     claimed success anyway" provenance check (forensic gap on disregarded
 *     failures) - we need a record that the tool fired AND that it errored,
 *     not just a record that something happened.
 *
 * Field names here (tool_response.exit_code, .success, etc.) are best-effort
 * against documented Claude Code hook payloads. If your installed version
 * names things differently, run `orunmila debug-hook` (see bin/orunmila.js)
 * to dump a raw payload and adjust the field lookups below - this is the
 * single most likely spot to need a tweak after a Claude Code update.
 */

const fs = require('fs');
const path = require('path');
const { append, TYPES, dataDir } = require('../../store/eventlog');
const { unifiedDiff } = require('../../reconcile/difftool');
const { turnId } = require('./turnstate');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function cacheSlot(sessionId, filePath) {
  return path.join(dataDir(), 'cache', sessionId || 'unknown', encodeURIComponent(filePath) + '.before');
}

function exitCodeOf(payload) {
  const r = payload.tool_response || payload.tool_result || {};
  if (typeof r.exit_code === 'number') return r.exit_code;
  if (typeof r.exitCode === 'number') return r.exitCode;
  if (typeof r.success === 'boolean') return r.success ? 0 : 1;
  if (payload.error || payload.hook_event_name === 'PostToolUseFailure') return 1;
  return null; // unknown - don't fabricate a 0
}

function isFailure(payload) {
  const code = exitCodeOf(payload);
  if (payload.hook_event_name === 'PostToolUseFailure') return true;
  if (code === null) return false;
  return code !== 0;
}

function main() {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id || 'unknown';
  const turn = turnId(sessionId);
  const toolName = payload.tool_name || '';
  const input = payload.tool_input || {};
  const callId = payload.tool_use_id || payload.call_id || null;
  const failed = isFailure(payload);

  if (/^(Write|Edit|MultiEdit)$/i.test(toolName)) {
    const filePath = input.file_path || input.path;
    if (filePath) {
      let before = '';
      try {
        before = fs.readFileSync(cacheSlot(sessionId, filePath), 'utf8');
      } catch {
        before = '';
      }
      let after = '';
      try {
        after = fs.readFileSync(filePath, 'utf8');
      } catch {
        after = ''; // file was deleted as part of this action
      }
      const diff = unifiedDiff(before, after, filePath);
      append({
        session_id: sessionId,
        turn_id: turn,
        agent: 'claude-code',
        source: 'hook',
        type: TYPES.FILE_WRITE,
        path: filePath,
        diff,
        failed,
        call_id: callId,
      });
      try {
        fs.rmSync(cacheSlot(sessionId, filePath), { force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  } else if (/^(Read|Glob|Grep)$/i.test(toolName)) {
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.FILE_READ,
      path: input.file_path || input.path || input.pattern || null,
      call_id: callId,
    });
  } else if (/^Bash$/i.test(toolName)) {
    const r = payload.tool_response || payload.tool_result || {};
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.COMMAND_RUN,
      command: input.command || '',
      exit_code: exitCodeOf(payload),
      stdout_excerpt: String(r.stdout || r.output || '').slice(0, 2000),
      failed,
      call_id: callId,
    });
  } else {
    // Generic catch-all - MCP tools (mcp__server__tool), ExitPlanMode, anything
    // new Claude Code ships. We'd rather log it loosely than drop it silently.
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.TOOL_CALL,
      tool_name: toolName,
      input,
      failed,
      call_id: callId,
    });
  }

  process.exit(0);
}

main();
