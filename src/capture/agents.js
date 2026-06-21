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
const READ_TOOLS = /^(read|read_file|view_file|cat_file|open_file|fsRead|readFile)$/i;
const PATTERN_READ_TOOLS = /^(glob|grep|search|codebase_search|file_search|grep_search|ripgrep|find)$/i;
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
};

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
  }),

  // Cursor — hooks land in .cursor; tool names differ (edit_file, read_file,
  // run_terminal_cmd). Field defaults already cover its camelCase shapes.
  cursor: withDefaults({
    id: 'cursor',
    label: 'Cursor',
    config: { dir: '.cursor', file: 'hooks.json' },
    events: {
      prompt: 'beforeSubmitPrompt',
      preTool: 'beforeShellExecution',
      postTool: ['afterFileEdit', 'afterShellExecution'],
      stop: 'stop',
    },
    preToolMatcher: 'edit_file|create_file|apply_patch',
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
};
