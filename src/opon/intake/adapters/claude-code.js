'use strict';

/**
 * src/opon/intake/adapters/claude-code.js — Claude Code's hook payloads to
 * marks (brief v3 lines 240-268, 336-337; Phase 1 slice A8, second half).
 *
 *   translatePayload(payload, { turn, observedAt, monoNs?, file? })
 *     -> { marks: [{ mark, keep }], rejects: [{ payload, reason }] }
 *
 * A pure translator: the caller (intake) gives the turn, the time it received
 * the payload, and, for a write or a read, the file facts it measured (`file`:
 * existedBefore, existsAfter, size, fingerprintBefore, fingerprint, diff,
 * linesAdded, linesRemoved, noDiff). It reuses src/capture/agents.js's field
 * accessors and tool classes, unchanged.
 *
 * Translations:
 * - Before a tool runs (PreToolUse): `started`, with the call id and tool name.
 * - A command's result: `exited`, pass on PostToolUse and fail on
 *   PostToolUseFailure, with no exit_code (Claude Code reports pass or fail
 *   only, line 240). Launched in the background, or interrupted: `unknown`,
 *   never pass (NF66).
 * - A write: created, modified or deleted from the measured facts; with no
 *   facts, modified with the before-state null.
 * - A Read with offset or limit is `range`; without, the adapter cannot show the
 *   tool returned the whole file, so `null` (open question 3). A search is
 *   `pattern`, targeting the folder searched (the project root when none).
 * - A failed tool call other than a command: `ended`.
 * - Stop: the `claimed` mark from the payload's own final text (N10), then
 *   the turn's `ended` mark. No final text: '' with claim_unconfirmed.
 * - A prompt Claude Code wrote itself is noted `from_human: false` (NF54).
 * - SessionEnd: the session's `ended` mark, target the session, no turn, with
 *   Claude Code's reason when it gives one (LD55).
 */

const { getAdapter } = require('../../../capture/agents');
const { monoString } = require('../mono');

const CC = getAdapter('claude-code');
const EXCERPT = 2000;

function hostOf(url) {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
}

function targetFor(kind, toolName, input) {
  const f = CC.fields;
  if (kind === 'write' || kind === 'read') return { kind: 'file', path: f.filePath(input) };
  if (kind === 'pattern_read') return { kind: 'dir', path: input.path || '.' };
  if (kind === 'command') return { kind: 'command', text: f.command(input) };
  if (kind === 'network') {
    const raw = f.url(input);
    const host = input.url || input.uri ? hostOf(raw) : null;
    return host ? { kind: 'network', host, url: String(raw) } : { kind: 'network', host: null, query: String(raw || '') };
  }
  return { kind: 'tool', name: toolName };
}

function writeDetail(file, status) {
  const d = { exit_status: status };
  let says = 'modified';
  if (file && file.existedBefore === false && file.existsAfter === true) says = 'created';
  else if (file && file.existedBefore === true && file.existsAfter === false) says = 'deleted';
  const known = file && typeof file.existedBefore === 'boolean';
  if (says !== 'created') d.fingerprint_before = known && file.fingerprintBefore ? file.fingerprintBefore : null;
  if (file && Number.isInteger(file.size)) d.size = file.size;
  if (file && file.fingerprint !== undefined) d.fingerprint = file.fingerprint;
  const counts = known && d.fingerprint_before !== null;
  d.lines_added = (counts || says === 'created') && file && Number.isInteger(file.linesAdded) ? file.linesAdded : null;
  d.lines_removed = (counts || says === 'created') && file && Number.isInteger(file.linesRemoved) ? file.linesRemoved : null;
  if (file && file.noDiff) d.no_diff = file.noDiff;
  return { says, d };
}

function translatePayload(payload, ctx = {}) {
  const ev = payload && payload.hook_event_name;
  const reject = (reason) => ({ marks: [], rejects: [{ payload, reason }] });
  if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'].includes(ev)) return reject(`no translation for hook event ${ev}`);
  const f = CC.fields;
  if (ev === 'SessionEnd') {
    // The session's end belongs to no turn (LD55).
    const detail = typeof payload.reason === 'string' && payload.reason ? { reason: payload.reason } : {};
    const m = { schema_version: 1, session_id: f.sessionId(payload), source: 'hook', agent: CC.id, turn: null, sub_agent: null, observed_at: ctx.observedAt, cause_hint: null, target: { kind: 'session', id: f.sessionId(payload) }, says: 'ended', detail };
    const mono = monoString(ctx.monoNs);
    if (mono !== undefined) m.mono_ns = mono;
    return { marks: [{ mark: m, keep: [] }], rejects: [] };
  }
  if (!ctx.turn) return reject('no turn given for a Glove mark');
  const subId = f.subAgentId(payload);
  const mark = (over) => {
    const m = {
      schema_version: 1,
      session_id: f.sessionId(payload),
      source: 'hook',
      agent: CC.id,
      turn: ctx.turn,
      sub_agent: subId ? { id: subId, type: f.subAgentType(payload) } : null,
      observed_at: ctx.observedAt,
      cause_hint: null,
      ...over,
    };
    const mono = monoString(ctx.monoNs); // a decimal string (brief v4 line 238); else intake stamps it
    if (mono !== undefined) m.mono_ns = mono;
    return m;
  };
  const turnTarget = { kind: 'turn', id: ctx.turn };

  if (ev === 'UserPromptSubmit') {
    return { marks: [{ mark: mark({ target: turnTarget, says: 'prompted', detail: { prompt: f.prompt(payload), from_human: f.promptFromHuman(payload) } }), keep: [] }], rejects: [] };
  }
  if (ev === 'Stop') {
    const text = f.finalText(payload);
    const detail = { text: text === null ? '' : text };
    if (text === null) detail.claim_unconfirmed = true;
    return {
      marks: [
        { mark: mark({ source: 'agent_claim', target: { kind: 'claim' }, says: 'claimed', detail }), keep: [] },
        { mark: mark({ target: turnTarget, says: 'ended', detail: {} }), keep: [] },
      ],
      rejects: [],
    };
  }

  const toolName = f.toolName(payload);
  const input = f.toolInput(payload);
  const kind = CC.classifyTool(toolName, input);
  const target = targetFor(kind, toolName, input);
  const callId = f.callId(payload);
  const tool = { cause_hint: callId, target };

  if (ev === 'PreToolUse') return { marks: [{ mark: mark({ ...tool, says: 'started', detail: { tool: toolName } }), keep: [] }], rejects: [] };

  const failed = ev === 'PostToolUseFailure';
  const status = failed ? 'fail' : 'pass';
  const keep = [];
  let says;
  let detail;
  if (kind === 'command') {
    const response = f.toolResponse(payload);
    const out = f.stdout(response) + (f.stderr(response) ? '\n' + f.stderr(response) : '');
    says = 'exited';
    detail = { tool: toolName, exit_status: status, output_excerpt: out.slice(0, EXCERPT) };
    if (!failed && input.run_in_background) Object.assign(detail, { exit_status: 'unknown', background: true });
    else if (!failed && response.interrupted === true) Object.assign(detail, { exit_status: 'unknown', interrupted: true });
    if (out.length > EXCERPT) keep.push({ slot: 'output_ref', text: out });
  } else if (failed) {
    says = 'ended';
    detail = { tool: toolName, exit_status: 'fail' };
  } else if (kind === 'write') {
    const w = writeDetail(ctx.file, status);
    says = w.says;
    detail = { tool: toolName, ...w.d };
    if (ctx.file && ctx.file.diff) keep.push({ slot: 'diff_ref', text: ctx.file.diff });
  } else if (kind === 'read' || kind === 'pattern_read') {
    says = 'read';
    detail = { tool: toolName, exit_status: status };
    if (kind === 'pattern_read') Object.assign(detail, { read_kind: 'pattern', pattern: String(f.pattern(input) || '') });
    else {
      detail.read_kind = input.offset !== undefined || input.limit !== undefined ? 'range' : null;
      if (ctx.file && Number.isInteger(ctx.file.size)) detail.size = ctx.file.size;
      if (ctx.file && ctx.file.fingerprint !== undefined) detail.fingerprint = ctx.file.fingerprint;
    }
  } else if (kind === 'network') {
    says = 'contacted';
    detail = { tool: toolName, exit_status: status };
  } else {
    says = 'called';
    detail = { tool: toolName, exit_status: status, tool_input: input };
  }
  return { marks: [{ mark: mark({ ...tool, says, detail }), keep }], rejects: [] };
}

module.exports = { translatePayload };
