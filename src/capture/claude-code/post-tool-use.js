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
const { sha256 } = require('../fs-sentinel/hasher');
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

// --- glove capture helpers -------------------------------------------------

// Tools that reach outside the machine. WebFetch/WebSearch are core; navigate is
// the browser MCP; mcp__* fetch/web/navigate tools are external contact too. We
// match loosely on purpose — over-tagging a benign MCP call as network is a
// visible, harmless conservatism; missing real external contact is not.
const NETWORK_TOOL = /^(WebFetch|WebSearch)$/i;
const NETWORK_MCP = /(fetch|navigate|web|http|browser|url)/i;

function isNetworkTool(toolName, input) {
  if (NETWORK_TOOL.test(toolName)) return true;
  if (/^mcp__/i.test(toolName) && NETWORK_MCP.test(toolName)) return true;
  // Any tool carrying an explicit url/query input that looks outbound.
  if (input && (input.url || input.uri) && /^https?:/i.test(String(input.url || input.uri))) return true;
  return false;
}

function hostOf(input) {
  const raw = input && (input.url || input.uri || input.query);
  if (!raw) return null;
  try {
    return new URL(String(raw)).host;
  } catch {
    return null; // a search query rather than a URL — keep the raw target instead
  }
}

// Real file reads become provenance SOURCES: tag them with a content hash + size
// so lineage can say "B was written in a turn that read A (sha …)". Glob/Grep are
// pattern reads, not a single file, so they carry no hash.
function readProvenance(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return { hash: sha256(buf), bytes: buf.length };
  } catch {
    return { hash: null, bytes: null };
  }
}

// Full command output is kept verbatim in a local sidecar (never leaves the
// machine), with only an excerpt + pointer in the JSONL so the log stays small.
function writeOutputSidecar(sessionId, callId, full) {
  if (!full) return null;
  try {
    const dir = path.join(dataDir(), 'output', sessionId || 'unknown');
    fs.mkdirSync(dir, { recursive: true });
    const slot = path.join(dir, (callId || `cmd-${Date.now()}`) + '.txt');
    fs.writeFileSync(slot, full);
    return slot;
  } catch {
    return null; // sidecar is best-effort; excerpt in the event is the fallback
  }
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
    const filePath = input.file_path || input.path || input.pattern || null;
    // Only a single concrete file (Read) can be hashed as a provenance source;
    // Glob/Grep are pattern reads over many files.
    const prov = /^Read$/i.test(toolName) && (input.file_path || input.path)
      ? readProvenance(input.file_path || input.path)
      : { hash: null, bytes: null };
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.FILE_READ,
      path: filePath,
      hash: prov.hash,
      bytes: prov.bytes,
      failed,
      call_id: callId,
    });
  } else if (/^Bash$/i.test(toolName)) {
    const r = payload.tool_response || payload.tool_result || {};
    const full = String(r.stdout || r.output || '') + (r.stderr ? '\n' + String(r.stderr) : '');
    const outputPath = full.length > 2000 ? writeOutputSidecar(sessionId, callId, full) : null;
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.COMMAND_RUN,
      command: input.command || '',
      exit_code: exitCodeOf(payload),
      stdout_excerpt: full.slice(0, 2000),
      output_path: outputPath, // null when output already fit in the excerpt
      failed,
      call_id: callId,
    });
  } else if (isNetworkTool(toolName, input)) {
    // External contact is first-class in the glove trail, not folded into the
    // generic tool_call bucket — so "what did it reach out to" is answerable.
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: 'claude-code',
      source: 'hook',
      type: TYPES.NETWORK_CALL,
      channel: 'network',
      tool_name: toolName,
      host: hostOf(input),
      target: String(input.url || input.uri || input.query || ''),
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
