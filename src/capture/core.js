'use strict';

/**
 * core.js — agent-agnostic capture engine.
 *
 * The four lifecycle handlers below contain ALL the capture logic that used to
 * live inside src/capture/claude-code/*.js. Each takes a parsed hook payload and
 * an agent adapter (from agents.js) and writes canonical events. The per-agent
 * hook scripts are now tiny: read stdin JSON, pick the adapter, call the matching
 * handler. Adding an agent never re-implements diffing, hashing, sidecars, turn
 * counting, or reconciliation — only the adapter's field/tool mapping changes.
 *
 * Same contract as before: every handler is observe-only and must never throw or
 * block the agent. Callers wrap in try/catch and always exit 0.
 */

const fs = require('fs');
const path = require('path');
const { append, readTurn, TYPES, dataDir } = require('../store/eventlog');
const { unifiedDiff } = require('../reconcile/difftool');
const { sha256 } = require('./fs-sentinel/hasher');
const { bumpTurn, turnId } = require('./turnstate');
const { reconcileAndPersist } = require('../reconcile');
const { renderTurn } = require('../render/terminal');
const defaultTranscript = require('./transcript');

// --- shared fs helpers (moved verbatim from the claude-code hooks) ----------

function cacheSlot(sessionId, filePath) {
  return path.join(dataDir(), 'cache', sessionId || 'unknown', encodeURIComponent(filePath) + '.before');
}

function ensureCacheSlot(sessionId, filePath) {
  const dir = path.join(dataDir(), 'cache', sessionId || 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, encodeURIComponent(filePath) + '.before');
}

// Real file reads become provenance SOURCES: hash + size so lineage can say "B
// was written in a turn that read A (sha …)". Pattern reads carry no single hash.
function readProvenance(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return { hash: sha256(buf), bytes: buf.length };
  } catch {
    return { hash: null, bytes: null };
  }
}

// Full command output is kept verbatim in a local sidecar (never leaves the
// machine); only an excerpt + pointer go in the JSONL so the log stays small.
function writeOutputSidecar(sessionId, callId, full) {
  if (!full) return null;
  try {
    const dir = path.join(dataDir(), 'output', sessionId || 'unknown');
    fs.mkdirSync(dir, { recursive: true });
    const slot = path.join(dir, (callId || `cmd-${Date.now()}`) + '.txt');
    fs.writeFileSync(slot, full);
    return slot;
  } catch {
    return null;
  }
}

function hostOf(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(String(rawUrl)).host;
  } catch {
    return null; // a search query rather than a URL — keep the raw target instead
  }
}

// Failure detection is adapter-aware: ask the adapter for an exit code, then
// fall back to the universal hook-name/error signals.
function isFailure(payload, adapter, response) {
  const code = adapter.fields.exitCode(response || {});
  const hookName = payload.hook_event_name || payload.event || '';
  if (/fail|error/i.test(String(hookName))) return true;
  if (payload.error) return true;
  if (code === null) return false;
  return code !== 0;
}

// --- lifecycle handlers -----------------------------------------------------

/**
 * prompt phase: a user message arrived. Bump the turn counter and log the
 * instruction so the task-extractor can later check the diff against what was
 * actually asked (not just against what the agent claims it did).
 */
function handlePrompt(payload, adapter) {
  const sessionId = adapter.fields.sessionId(payload);
  bumpTurn(sessionId);
  append({
    session_id: sessionId,
    turn_id: turnId(sessionId),
    agent: adapter.id,
    type: TYPES.USER_PROMPT,
    text: adapter.fields.prompt(payload),
  });
}

/**
 * preTool phase: before a write happens, snapshot the file's current content so
 * postTool can compute a real before/after diff. No-op for non-write tools.
 */
function handlePreTool(payload, adapter) {
  const toolName = adapter.fields.toolName(payload);
  const input = adapter.fields.toolInput(payload);
  const sessionId = adapter.fields.sessionId(payload);
  if (adapter.classifyTool(toolName, input) !== 'write') return;
  const filePath = adapter.fields.filePath(input);
  if (!filePath) return;
  let before = '';
  try {
    before = fs.readFileSync(filePath, 'utf8');
  } catch {
    before = ''; // file doesn't exist yet — a legit "before" state too
  }
  try {
    fs.writeFileSync(ensureCacheSlot(sessionId, filePath), before);
  } catch {
    /* cache failure must never block the agent's tool call */
  }
}

/**
 * postTool phase: the main ground-truth capture point. Classifies the tool via
 * the adapter and writes the matching canonical event (write/read/command/
 * network/tool). Fires for both success and failure tool results.
 */
function handlePostTool(payload, adapter) {
  const sessionId = adapter.fields.sessionId(payload);
  const turn = turnId(sessionId);
  const toolName = adapter.fields.toolName(payload);
  const input = adapter.fields.toolInput(payload);
  const response = adapter.fields.toolResponse(payload);
  const callId = adapter.fields.callId(payload);
  const failed = isFailure(payload, adapter, response);
  const kind = adapter.classifyTool(toolName, input);

  const base = { session_id: sessionId, turn_id: turn, agent: adapter.id, source: 'hook', failed, call_id: callId };
  // Attribute the touch to a sub-agent when the hook fired inside one. Absent on
  // the main thread, so main-thread events stay byte-for-byte as before — only a
  // sub-agent's tool calls carry these, letting the glove show who did what.
  const subAgentId = adapter.fields.subAgentId(payload);
  if (subAgentId) {
    base.sub_agent_id = subAgentId;
    base.sub_agent_type = adapter.fields.subAgentType(payload);
  }

  if (kind === 'write') {
    const filePath = adapter.fields.filePath(input);
    if (!filePath) return;
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
    append(Object.assign({}, base, {
      type: TYPES.FILE_WRITE,
      path: filePath,
      diff: unifiedDiff(before, after, filePath),
    }));
    try {
      fs.rmSync(cacheSlot(sessionId, filePath), { force: true });
    } catch {
      /* best effort */
    }
  } else if (kind === 'read' || kind === 'pattern_read') {
    const filePath = adapter.fields.filePath(input) || adapter.fields.pattern(input) || null;
    const prov = kind === 'read' && adapter.fields.filePath(input)
      ? readProvenance(adapter.fields.filePath(input))
      : { hash: null, bytes: null };
    append(Object.assign({}, base, {
      type: TYPES.FILE_READ,
      path: filePath,
      hash: prov.hash,
      bytes: prov.bytes,
    }));
  } else if (kind === 'command') {
    const full = adapter.fields.stdout(response) + (adapter.fields.stderr(response) ? '\n' + adapter.fields.stderr(response) : '');
    const outputPath = full.length > 2000 ? writeOutputSidecar(sessionId, callId, full) : null;
    // Exit code from the response if present; otherwise, if the payload itself
    // signalled failure (top-level error / a failure hook), record a non-zero
    // exit rather than null — a known failure shouldn't read as "unknown".
    const code = adapter.fields.exitCode(response);
    append(Object.assign({}, base, {
      type: TYPES.COMMAND_RUN,
      command: adapter.fields.command(input),
      exit_code: code === null && failed ? 1 : code,
      stdout_excerpt: full.slice(0, 2000),
      output_path: outputPath,
    }));
  } else if (kind === 'network') {
    const target = adapter.fields.url(input);
    append(Object.assign({}, base, {
      type: TYPES.NETWORK_CALL,
      channel: 'network',
      tool_name: toolName,
      host: hostOf(target),
      target: String(target || ''),
    }));
  } else {
    // Generic catch-all — MCP tools, plan tools, anything the agent ships next.
    // Better to log loosely than drop silently.
    append(Object.assign({}, base, {
      type: TYPES.TOOL_CALL,
      tool_name: toolName,
      input,
    }));
  }
}

/**
 * stop phase: the turn is finished, so the agent's claim text exists for the
 * first time. Log the claim, backfill the prompt if the prompt hook never fired,
 * mark the turn end, reconcile, and return the rendered report for the caller to
 * print (so the user sees it in their terminal immediately).
 */
function handleStop(payload, adapter) {
  const sessionId = adapter.fields.sessionId(payload);
  const turn = turnId(sessionId);
  const transcriptPath = adapter.fields.transcriptPath(payload);
  const transcript = adapter.transcript || defaultTranscript;

  const claimText = payload.claim || payload.response || transcript.lastAssistantText(transcriptPath);

  append({ session_id: sessionId, turn_id: turn, agent: adapter.id, type: TYPES.TURN_CLAIM, text: claimText });

  const existingPrompt = readTurn(sessionId, turn).find((e) => e.type === TYPES.USER_PROMPT);
  if (!existingPrompt) {
    append({
      session_id: sessionId,
      turn_id: turn,
      agent: adapter.id,
      type: TYPES.USER_PROMPT,
      text: transcript.lastUserText(transcriptPath),
    });
  }

  append({ session_id: sessionId, turn_id: turn, agent: adapter.id, type: TYPES.TURN_END });

  const report = reconcileAndPersist(sessionId, turn);
  return renderTurn(report);
}

// --- generic stdin runner ---------------------------------------------------
// Each per-agent hook script is one line: `runHook('postTool', adapter)`. This
// reads stdin, parses JSON, dispatches to the handler, and ALWAYS exits 0. The
// stop handler's rendered report is written to the last-turn file and stdout.

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function lastTurnReportPath() {
  return path.join(dataDir(), 'last-turn-report.txt');
}

const HANDLERS = {
  prompt: handlePrompt,
  preTool: handlePreTool,
  postTool: handlePostTool,
  stop: handleStop,
};

function runHook(phase, adapter) {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // never block the agent over a parse hiccup
  }
  try {
    const handler = HANDLERS[phase];
    const out = handler(payload, adapter);
    if (phase === 'stop' && typeof out === 'string') {
      try {
        fs.writeFileSync(lastTurnReportPath(), out + '\n');
      } catch {
        /* best effort */
      }
      process.stdout.write(out + '\n');
    }
  } catch {
    /* observe-only: a capture error must never surface to the agent */
  }
  process.exit(0);
}

module.exports = {
  handlePrompt,
  handlePreTool,
  handlePostTool,
  handleStop,
  runHook,
  // exported for tests / reuse
  cacheSlot,
  readProvenance,
  writeOutputSidecar,
  hostOf,
  isFailure,
};
