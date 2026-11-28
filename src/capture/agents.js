// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * agents.js — the agent adapter registry.
 *
 * orunmila's whole pipeline downstream of capture (reconcile, trail, render) is
 * already agent-agnostic: it reads one canonical events.jsonl and never cares
 * which agent produced an event. The ONLY agent-specific knowledge is at the
 * capture seam: where the agent's config lives, what its hook events are called,
 * how its hook payload names fields, and how it classifies a tool. This file is
 * the single place that knowledge lives, so adding a new agent is a data entry,
 * not a code fork.
 *
 * An adapter is a plain object:
 *   id          canonical `agent` value stamped on every event ('claude-code', 'cursor', ...)
 *   label       human name for CLI/output
 *   config      { dir, file } — where `install` writes hooks, relative to home or cwd
 *               (dir is the agent's config folder name; file is the settings file)
 *   events      map of orunmila lifecycle phase -> the agent's own hook event name(s):
 *                 prompt   (user message arrived; bump turn + log prompt)
 *                 preTool  (before a write; snapshot for diffing)
 *                 postTool (after a tool ran; the main capture point)
 *                 stop     (turn finished; reconcile)
 *               A value can be a string or an array of names (some agents fire
 *               both a success and a failure variant of the same phase).
 *   fields      payload field accessors — every agent names these differently.
 *               Each is a function (payload) => value, so a new agent only writes
 *               the few that differ from the defaults.
 *   classifyTool(toolName, input) -> one of:
 *               'write' | 'read' | 'pattern_read' | 'command' | 'network' | 'tool'
 *               This is what makes "Edit" (Claude) and "edit_file" (Cursor) and
 *               "apply_patch" (Codex) all become the same FILE_WRITE event.
 *   transcript  optional module with lastAssistantText/lastUserText for the stop
 *               phase. Defaults to the shared JSONL transcript reader.
 *
 * Defaults below are deliberately liberal: they already understand the common
 * Claude-Code field names AND a number of alternatives (toolName/tool, path/
 * file_path, exitCode/exit_code), so most agents need only override `id`,
 * `config`, `events`, and any genuinely different tool names.
 */

const path = require('path');

// --- shared tool classification --------------------------------------------
// Names are matched case-insensitively. The lists are unions across agents on
// purpose: over-recognizing a tool name from another agent is harmless (that
// agent never emits it), while a missing name silently drops a touch.

const WRITE_TOOLS = /^(write|edit|multiedit|create_file|edit_file|apply_patch|str_replace_editor|str_replace_based_edit_tool|write_file|insert_edit_into_file|replace_in_file|fsWrite|fsAppend)$/i;
const READ_TOOLS = /^(read|read_file|view_file|cat_file|open_file|fsRead|readFile|list_dir)$/i;
const PATTERN_READ_TOOLS = /^(glob|grep|search|codebase_search|file_search|grep_search|ripgrep|find|find_by_name)$/i;
const COMMAND_TOOLS = /^(bash|shell|run_command|run_terminal_cmd|execute_command|terminal|exec|executePwsh|run_in_terminal)$/i;
const NETWORK_TOOLS = /^(webfetch|websearch|web_search|web_fetch|fetch|browser|navigate|http_request|read_url|open_url)$/i;
const NETWORK_MCP = /(fetch|navigate|web|http|browser|url)/i;

function defaultClassifyTool(toolName, input) {
  const name = String(toolName || '');
  if (WRITE_TOOLS.test(name)) return 'write';
  if (READ_TOOLS.test(name)) return 'read';
  if (PATTERN_READ_TOOLS.test(name)) return 'pattern_read';
  if (COMMAND_TOOLS.test(name)) return 'command';
  if (NETWORK_TOOLS.test(name)) return 'network';
  if (/^mcp__/i.test(name) && NETWORK_MCP.test(name)) return 'network';
  // Any tool carrying an explicit outbound url/uri input is network contact.
  if (input && (input.url || input.uri) && /^https?:/i.test(String(input.url || input.uri))) return 'network';
  return 'tool';
}

// --- shared payload field accessors ----------------------------------------
// Defaults read the Claude-Code names first, then common alternatives. A new
// agent overrides only the ones that genuinely differ.

const defaultFields = {
  sessionId: (p) => p.session_id || p.sessionId || p.conversation_id || 'unknown',
  toolName: (p) => p.tool_name || p.toolName || p.tool || '',
  toolInput: (p) => p.tool_input || p.toolInput || p.input || p.arguments || {},
  toolResponse: (p) => p.tool_response || p.tool_result || p.toolResponse || p.result || {},
  callId: (p) => p.tool_use_id || p.call_id || p.callId || p.id || null,
  // Sub-agent attribution: Claude Code's PostToolUse stdin carries agent_id +
  // agent_type ONLY when the hook fires inside a sub-agent (a Task/sidechain).
  // On the main thread these are absent, so the touch is the parent's. This is
  // what lets the glove tag *which* sub-agent actually made each touch.
  subAgentId: (p) => p.agent_id || p.agentId || p.sub_agent_id || null,
  subAgentType: (p) => p.agent_type || p.agentType || p.sub_agent_type || null,
  prompt: (p) => p.prompt || p.user_prompt || p.message || p.text || '',
  // Whether a prompt is a message from the user, as opposed to one the host
  // wrote itself. Only a user's message refills the gate's block budget (NF54).
  promptFromHuman: () => true,
  // The turn's final text as the Stop payload itself carries it: Claude Code's
  // `last_assistant_message`, or `claim` / `response` where a host passes the
  // text. '' when the host says the turn ended with no text; null when the
  // payload carries none of them, so the text cannot be confirmed (N10).
  finalText: (p) => {
    const given = [p.claim, p.response, p.last_assistant_message].filter((v) => typeof v === 'string');
    if (!given.length) return null;
    return given.find((v) => v.trim()) || '';
  },
  transcriptPath: (p) => p.transcript_path || p.transcriptPath || p.transcript || null,
  filePath: (input) => input.file_path || input.path || input.filePath || input.target_file || null,
  command: (input) => input.command || input.cmd || input.script || '',
  pattern: (input) => input.pattern || input.query || input.regex || input.glob || null,
  url: (input) => input.url || input.uri || input.query || null,
  // failure detection: explicit flags first, then exit codes, then a failure hook
  exitCode: (response) => {
    if (typeof response.exit_code === 'number') return response.exit_code;
    if (typeof response.exitCode === 'number') return response.exitCode;
    if (typeof response.code === 'number') return response.code;
    if (typeof response.success === 'boolean') return response.success ? 0 : 1;
    return null;
  },
  stdout: (response) => String(response.stdout || response.output || response.stdoutText || ''),
  stderr: (response) => (response.stderr ? String(response.stderr) : ''),
  // Read only with ORUNMILA_EXACT_CAPTURE=1 (core.js). What a failure payload
  // itself says about a failed command, for a host whose failure hook carries
  // no tool_response: { code, output }, code null when not stated (NF22).
  // null here means the host's shape is not known, so capture keeps its old rule.
  failureExit: () => null,
  // How much of a file a read returned, from the tool's own result (LD94):
  // { start_line, lines, total_lines } (each null when not given). null when the
  // host's result shape is not known.
  readExtent: () => null,
};

// The folder-listing tools among READ_TOOLS: a listing names entries, it shows
// no file's content (LD94). Used only with ORUNMILA_EXACT_CAPTURE=1.
const LISTING_TOOLS = /^(list_dir)$/i;

function wholeNumber(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

// LD94: the range a read asked for and the range its result says it returned.
// A read is 'range' when it returned fewer lines than the file holds or its
// content was cut by a token cap; with no counts in the result, when it asked
// for a bounded range. null when nothing about the extent is known. Shared by
// capture (core.js, with ORUNMILA_EXACT_CAPTURE=1) and the mark adapters (LD121).
function readRange(input, extent) {
  const e = extent || {};
  const range = {
    asked_offset: wholeNumber(input && input.offset),
    asked_limit: wholeNumber(input && input.limit),
    start_line: e.start_line === undefined ? null : e.start_line,
    lines: e.lines === undefined ? null : e.lines,
    total_lines: e.total_lines === undefined ? null : e.total_lines,
  };
  const cut = e.truncated_by_token_cap === true;
  if (cut) range.truncated_by_token_cap = true;
  const counted = range.lines !== null && range.total_lines !== null;
  const asked = range.asked_offset !== null || range.asked_limit !== null;
  if (!counted && !asked && !cut && range.start_line === null) return null;
  const partial = counted ? (range.lines < range.total_lines || cut) : (asked || cut);
  return { range, kind: partial ? 'range' : 'full' };
}

function withDefaults(adapter) {
  return Object.assign({}, adapter, {
    fields: Object.assign({}, defaultFields, adapter.fields || {}),
    classifyTool: adapter.classifyTool || defaultClassifyTool,
  });
}

// --- the registry ----------------------------------------------------------

const REGISTRY = {
  // Claude Code — the original target. Hook event names and config dir are its own.
  'claude-code': withDefaults({
    id: 'claude-code',
    label: 'Claude Code',
    config: { dir: '.claude', file: 'settings.json' },
    events: {
      prompt: 'UserPromptSubmit',
      preTool: 'PreToolUse',
      postTool: ['PostToolUse', 'PostToolUseFailure'],
      stop: 'Stop',
    },
    // preTool matcher: which tools should be snapshotted before they run.
    preToolMatcher: 'Write|Edit|MultiEdit',
    // Its Stop payload carries the turn's final text, so the transcript is never
    // read for the claim: when Stop fires, the transcript can still end on an
    // earlier block of the turn (N10). Other agents' payloads are not measured.
    stopCarriesFinalText: true,
    fields: {
      // Claude Code also fires UserPromptSubmit for prompts it writes itself: a
      // background task's notification and a sub-agent's hand-back, which open
      // with `<task-notification>` and `<agent-message from=…>`. Its payload has
      // no origin field (2.1.314); in one session the opening tag matched the
      // transcript's origin.kind on 7 prompts of 7 (NF54).
      promptFromHuman: (p) => !/^\s*<(?:task-notification|agent-message)[\s>]/.test(String(p.prompt || '')),
      // PostToolUseFailure has no tool_response: a Bash failure's code is the
      // first line of `error` ("Exit code N"; transcripts show "Error: Exit code
      // N"), its output the rest. Any other first line states no code (a
      // timeout, a refusal): the whole text is the output, the code null.
      failureExit: (p) => {
        if (typeof p.error !== 'string') return { code: null, output: '' };
        const nl = p.error.indexOf('\n');
        const first = nl === -1 ? p.error : p.error.slice(0, nl);
        const m = /^(?:Error: )?Exit code (\d{1,9})\s*$/.exec(first);
        if (!m) return { code: null, output: p.error };
        return { code: Number(m[1]), output: nl === -1 ? '' : p.error.slice(nl + 1) };
      },
      // Read's result: { type: 'text', file: { filePath, content, numLines,
      // startLine, totalLines, truncatedByTokenCap? } } in transcripts (1,254
      // of 1,254 in this worktree's); a flat object is read the same way.
      readExtent: (response) => {
        const r = response && typeof response === 'object' ? response : {};
        const f = r.file && typeof r.file === 'object' ? r.file : r;
        const ext = { start_line: wholeNumber(f.startLine), lines: wholeNumber(f.numLines), total_lines: wholeNumber(f.totalLines) };
        if (f.truncatedByTokenCap === true) ext.truncated_by_token_cap = true;
        return ext;
      },
    },
  }),

  // Cursor — hooks in .cursor/hooks.json as { version: 1, hooks: { <event>: [{ command }] } } (bin/orunmila.js
  // installCursor). CU1, measured 2026-11-28 on Cursor's command-line agent 2026.11.22-e9042b2, every hook's stdin
  // kept (test/cursor.js holds the shapes): preToolUse/postToolUse name the tool (Read, Write, Grep, Shell) with
  // `tool_input` an object and `tool_output` JSON text (Shell's: { output, exitCode }); afterFileEdit and
  // afterShellExecution repeat those calls with less (no tool name; no exit code), so they are not used. The final
  // text comes only in afterAgentResponse (`text`), so that closes the turn; `stop`, at the same moment, has none.
  // Print mode (`-p`) fires no prompt, stop or response hook: sessionEnd closes a turn nothing closed, from the
  // transcript. The "before" hooks print nothing: measured, an empty answer blocked nothing.
  cursor: withDefaults({
    id: 'cursor',
    label: 'Cursor',
    config: { dir: '.cursor', file: 'hooks.json' },
    events: {
      prompt: 'beforeSubmitPrompt',
      preTool: 'preToolUse',
      postTool: ['postToolUse', 'postToolUseFailure'],
      stop: 'afterAgentResponse',
      sessionEnd: 'sessionEnd',
    },
    stopCarriesFinalText: true,
    transcript: {
      lastAssistantText: (p) => require('./transcript').lastAssistantText(p),
      // Cursor wraps the ask: "<timestamp>...</timestamp>\n<user_query>\n...\n</user_query>".
      lastUserText: (p) => {
        const t = require('./transcript').lastUserText(p);
        const m = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(t);
        return m ? m[1] : t;
      },
    },
    fields: {
      toolResponse: (p) => {
        const r = p.tool_output !== undefined ? p.tool_output : (p.tool_response || p.result || {});
        if (typeof r !== 'string') return r || {};
        try {
          const v = JSON.parse(r);
          return v && typeof v === 'object' ? v : { output: r };
        } catch {
          return { output: r };
        }
      },
      // afterAgentResponse's `text` is every text block of the turn joined with no space ("...the tests.Updated ..."),
      // which the claim reader cannot split. Measured: the transcript's last assistant message is that text's tail, so
      // the claim is that message, as Claude Code's is; when the transcript's last message is not exactly the tail (not
      // caught up, N10), the hook's own text stands.
      finalText: (p) => {
        if (typeof p.text !== 'string') return null;
        let last;
        try {
          last = require('./transcript').lastAssistantText(p.transcript_path || null);
        } catch {
          last = '';
        }
        return last && last !== p.text && p.text.endsWith(last) ? last : p.text;
      },
    },
  }),

  // Aider — drives edits via git commits + a chat history file. It has no native
  // hook system, so it relies on the filesystem sentinel for writes and the
  // generic transcript reader for the chat; the adapter still defines an id and
  // config dir so `install --agent aider` documents the sentinel-based setup.
  aider: withDefaults({
    id: 'aider',
    label: 'Aider',
    config: { dir: '.aider', file: 'hooks.json' },
    events: {
      prompt: 'user_prompt',
      preTool: 'pre_tool',
      postTool: 'post_tool',
      stop: 'stop',
    },
    preToolMatcher: '*',
  }),

  // Codex CLI — OpenAI's coding agent. Edits via apply_patch, shell via a single
  // exec tool. camelCase + snake_case both handled by defaults.
  codex: withDefaults({
    id: 'codex',
    label: 'Codex CLI',
    config: { dir: '.codex', file: 'hooks.json' },
    events: {
      prompt: 'on_user_message',
      preTool: 'before_tool',
      postTool: 'after_tool',
      stop: 'on_turn_complete',
    },
    preToolMatcher: 'apply_patch|write_file',
  }),

  // Continue (VS Code/JetBrains) — config in .continue; tools are edit/read/run.
  continue: withDefaults({
    id: 'continue',
    label: 'Continue',
    config: { dir: '.continue', file: 'hooks.json' },
    events: {
      prompt: 'onUserInput',
      preTool: 'beforeToolCall',
      postTool: 'afterToolCall',
      stop: 'onResponseComplete',
    },
    preToolMatcher: '*',
  }),

  // Antigravity — Google's agent-first IDE. Hook payload nests tool info under
  // `toolCall` and uses `PreInvocation` for the prompt phase. Config lands in
  // `.agents/hooks.json` (workspace) or `~/.gemini/config/hooks.json` (global).
  antigravity: withDefaults({
    id: 'antigravity',
    label: 'Antigravity',
    config: { dir: '.agents', file: 'hooks.json' },
    globalConfig: { dir: '.gemini/config', file: 'hooks.json' },
    events: {
      prompt: 'PreInvocation',
      preTool: 'PreToolUse',
      postTool: 'PostToolUse',
      stop: 'Stop',
    },
    preToolMatcher: 'edit_file|write_file',
    fields: {
      toolName: (p) => (p.toolCall && p.toolCall.name) || p.tool_name || p.toolName || p.tool || '',
      toolInput: (p) => (p.toolCall && p.toolCall.args) || p.tool_input || p.toolInput || p.input || p.arguments || {},
      toolResponse: (p) => (p.toolCall && p.toolCall.result) || p.tool_response || p.tool_result || p.toolResponse || p.result || {},
      transcriptPath: (p) => p.transcriptPath || p.transcript_path || p.transcript || null,
    },
  }),

  // Gemini CLI — Google's standalone CLI agent (@google/gemini-cli). Uses
  // SessionStart/SessionEnd/BeforeTool/AfterTool event names and provides
  // session_id + transcript_path on every payload. Tool payload is similar to
  // Antigravity (nested toolCall or flat tool_name).
  'gemini-cli': withDefaults({
    id: 'gemini-cli',
    label: 'Gemini CLI',
    config: { dir: '.gemini', file: 'settings.json' },
    globalConfig: { dir: '.gemini/config', file: 'settings.json' },
    events: {
      prompt: 'SessionStart',
      preTool: 'BeforeTool',
      postTool: 'AfterTool',
      stop: 'SessionEnd',
    },
    preToolMatcher: 'edit_file|write_file',
    fields: {
      toolName: (p) => (p.toolCall && p.toolCall.name) || p.tool_name || p.toolName || p.tool || '',
      toolInput: (p) => (p.toolCall && p.toolCall.args) || p.tool_input || p.toolInput || p.input || p.arguments || {},
      toolResponse: (p) => (p.toolCall && p.toolCall.result) || p.tool_response || p.tool_result || p.toolResponse || p.result || {},
      transcriptPath: (p) => p.transcript_path || p.transcriptPath || p.transcript || null,
    },
  }),

  // Generic — a fallback for any agent that can be configured to run a command
  // per lifecycle event with a JSON payload on stdin. Uses the most permissive
  // field defaults. This is the "no extra work" path the project promises: an
  // unknown agent that emits the canonical phases captures for free.
  generic: withDefaults({
    id: 'generic',
    label: 'Generic (stdin-JSON agent)',
    config: { dir: '.orunmila', file: 'agent-hooks.json' },
    events: {
      prompt: 'prompt',
      preTool: 'pre_tool',
      postTool: 'post_tool',
      stop: 'stop',
    },
    preToolMatcher: '*',
  }),
};

function getAdapter(agentId) {
  const key = String(agentId || 'claude-code').toLowerCase();
  return REGISTRY[key] || null;
}

function listAgents() {
  return Object.values(REGISTRY).map((a) => ({ id: a.id, label: a.label }));
}

/** Resolve where `install` should write this agent's hook config. */
function configPath(adapter, { global, home, cwd }) {
  if (global && adapter.globalConfig) {
    return path.join(home, adapter.globalConfig.dir, adapter.globalConfig.file);
  }
  const base = global ? home : cwd;
  return path.join(base, adapter.config.dir, adapter.config.file);
}

module.exports = {
  REGISTRY,
  getAdapter,
  listAgents,
  configPath,
  defaultFields,
  defaultClassifyTool,
  withDefaults,
  LISTING_TOOLS,
  wholeNumber,
  readRange,
};
