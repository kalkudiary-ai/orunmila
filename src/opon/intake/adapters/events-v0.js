'use strict';

/**
 * src/opon/intake/adapters/events-v0.js — translates today's event log (format
 * v0: ~/.orunmila/events.jsonl, written by src/capture/core.js and the
 * Sentinel) into marks (brief v3 lines 240-268, 336; Phase 1 slice A8).
 *
 * A pure translator: it reads nothing and decides nothing. It returns
 *   { marks: [{ mark, keep }], rejects: [{ event, reason }] }
 * where `keep` asks intake to keep a file beside the log and put its ref in
 * the named detail slot ({ slot, text } or { slot, fromFile }). Intake assigns
 * seq and the chain, stamps mono_ns (today's records have no monotonic clock),
 * redacts, checks the schema and quarantines what fails; a reject is
 * quarantined with its reason. Nothing is dropped.
 *
 * Translations, each forced by what today's records hold:
 * - An integer `exit_code` is carried for any agent, except a failed row's
 *   `1`: today's capture invents it with ORUNMILA_EXACT_CAPTURE off (NF22), and
 *   it cannot be told from a real 1, so it is dropped (LD121). A pass recorded
 *   as `null` has no code.
 * - A hook write is `modified`: today's record cannot tell a created file from
 *   a modified one, and its before-state is unknown (fingerprint_before and
 *   line counts null).
 * - Today's `read_kind: "full"` is not shown to be the whole file, so it is
 *   `null` (open question 3), unless the row carries exact capture's
 *   `read_range` (LD94): its own fields are carried, and `range` or `full`
 *   re-derived from them by X1's rule (LD121). `pattern` stays, targeting the
 *   project root. A `listing` stays a listing, of its folder.
 * - Today's write and read records name no tool: `detail.tool` is null. A
 *   command is the Bash tool for Claude Code.
 * - A failed tool call other than a command ends `ended`.
 * - git, pull-request and CI records join their command's `exited` mark as
 *   `detail.vcs`, by call id, with today's field names.
 * - A plain fingerprint of a file on the redaction list (`.env`, `.env.*`) is
 *   never carried (line 249): it is null.
 * - Sentinel records carry no session; the caller gives one (attribution by
 *   time window is intake's job), or they are rejected.
 */

const { onRedactionList } = require('../redact');
const { readRange, wholeNumber } = require('../../../capture/agents');

const VCS_TYPES = new Set(['git_state', 'pr_state', 'ci_state']);
const SENTINEL_VERB = { create: 'created', modify: 'modified', delete: 'deleted' };
const fp = (hex) => (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null);

function lineCounts(diff) {
  let added = 0;
  let removed = 0;
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** Exact capture's read_range (LD94) re-read field by field: { kind, range } by X1's rule, or null. */
function exactRead(e) {
  const r = e.read_range;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const extent = { start_line: wholeNumber(r.start_line), lines: wholeNumber(r.lines), total_lines: wholeNumber(r.total_lines) };
  if (r.truncated_by_token_cap === true) extent.truncated_by_token_cap = true;
  return readRange({ offset: r.asked_offset, limit: r.asked_limit }, extent);
}

function common(e) {
  const m = {
    schema_version: 1,
    session_id: e.session_id,
    source: 'hook',
    agent: e.agent || null,
    turn: e.turn_id,
    sub_agent: e.sub_agent_id ? { id: e.sub_agent_id, type: e.sub_agent_type } : null,
    observed_at: e.ts,
    cause_hint: e.call_id || null,
  };
  return m;
}

function outcome(e, kind) {
  return e.failed ? 'ended' : kind;
}

function translateGlove(e) {
  const m = common(e);
  const status = e.failed ? 'fail' : 'pass';
  const keep = [];
  const redactions = Array.isArray(e.redactions) && e.redactions.length ? { redactions: [...e.redactions].sort() } : {};
  switch (e.type) {
    case 'command_run': {
      m.target = { kind: 'command', text: e.command };
      m.says = 'exited';
      m.detail = { tool: e.agent === 'claude-code' ? 'Bash' : null, exit_status: status, output_excerpt: e.stdout_excerpt || '', ...redactions };
      if (Number.isInteger(e.exit_code) && !(e.failed && e.exit_code === 1)) m.detail.exit_code = e.exit_code;
      if (e.output_path) keep.push({ slot: 'output_ref', fromFile: e.output_path });
      break;
    }
    case 'file_write': {
      m.target = { kind: 'file', path: e.path };
      m.says = outcome(e, 'modified');
      m.detail = { tool: null, exit_status: status, ...redactions };
      if (!e.failed) {
        Object.assign(m.detail, { fingerprint_before: null, lines_added: null, lines_removed: null });
        if (e.diff) keep.push({ slot: 'diff_ref', text: e.diff });
      }
      break;
    }
    case 'file_read': {
      const pattern = e.read_kind === 'pattern';
      const listing = e.read_kind === 'listing';
      const exact = pattern || listing ? null : exactRead(e);
      m.target = pattern ? { kind: 'dir', path: '.' } : { kind: listing ? 'dir' : 'file', path: e.path };
      m.says = outcome(e, 'read');
      m.detail = { tool: null, exit_status: status, read_kind: pattern ? 'pattern' : listing ? 'listing' : exact ? exact.kind : null, ...redactions };
      if (exact) m.detail.read_range = exact.range;
      if (pattern) m.detail.pattern = e.path;
      else if (!listing) {
        if (Number.isInteger(e.bytes)) m.detail.size = e.bytes;
        m.detail.fingerprint = onRedactionList(e.path) ? null : fp(e.hash);
      }
      break;
    }
    case 'tool_call': {
      m.target = { kind: 'tool', name: e.tool_name };
      m.says = outcome(e, 'called');
      m.detail = { tool: e.tool_name, exit_status: status, tool_input: e.input === undefined ? null : e.input, ...redactions };
      if (typeof e.result_excerpt === 'string') m.detail.tool_result_excerpt = e.result_excerpt;
      if (Number.isInteger(e.result_bytes)) m.detail.tool_result_size = e.result_bytes;
      break;
    }
    case 'network_call': {
      m.target = e.host ? { kind: 'network', host: e.host, url: e.target } : { kind: 'network', host: null, query: e.target };
      m.says = outcome(e, 'contacted');
      m.detail = { tool: e.tool_name, exit_status: status, ...redactions };
      break;
    }
    case 'user_prompt':
      m.target = { kind: 'turn', id: e.turn_id };
      m.says = 'prompted';
      m.cause_hint = null;
      m.detail = { prompt: e.text, ...redactions };
      break;
    case 'turn_claim':
      m.source = 'agent_claim';
      m.target = { kind: 'claim' };
      m.says = 'claimed';
      m.cause_hint = null;
      m.detail = { text: e.text, ...redactions };
      if (e.claim_unconfirmed) m.detail.claim_unconfirmed = true;
      break;
    case 'turn_end':
      m.target = { kind: 'turn', id: e.turn_id };
      m.says = 'ended';
      m.cause_hint = null;
      m.detail = {};
      break;
    default:
      return null;
  }
  return { mark: m, keep };
}

function translateSentinel(e, sessionId) {
  const verb = SENTINEL_VERB[e.change_kind];
  if (!verb) return null;
  const listed = onRedactionList(e.rel_path || e.path);
  const detail = {};
  if (verb !== 'created') detail.fingerprint_before = listed ? null : fp(e.hash_before);
  detail.fingerprint = listed ? null : fp(e.hash_after);
  const keep = [];
  if (e.binary) detail.no_diff = 'binary';
  else {
    if (verb === 'modified') {
      const c = lineCounts(e.diff || '');
      detail.lines_added = c.added;
      detail.lines_removed = c.removed;
    } else {
      detail.lines_added = null;
      detail.lines_removed = null;
    }
    if (e.diff) keep.push({ slot: 'diff_ref', text: e.diff });
  }
  if (Array.isArray(e.redactions) && e.redactions.length) detail.redactions = [...e.redactions].sort();
  const mark = {
    schema_version: 1,
    session_id: sessionId,
    source: 'sentinel',
    agent: null,
    turn: null,
    sub_agent: null,
    observed_at: e.ts,
    target: { kind: 'file', path: e.rel_path || e.path },
    says: verb,
    detail,
    cause_hint: null,
  };
  return { mark, keep };
}

function translateEvents(events, { sessionId = null } = {}) {
  const marks = [];
  const rejects = [];
  const commands = new Map(); // session|call id -> mark
  const vcs = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') {
      rejects.push({ event: e, reason: 'not an event object' });
      continue;
    }
    if (VCS_TYPES.has(e.type)) {
      vcs.push(e);
      continue;
    }
    if (e.source === 'fs-sentinel') {
      if (!sessionId) {
        rejects.push({ event: e, reason: 'no session for a Sentinel record: the caller gives one' });
        continue;
      }
      const t = translateSentinel(e, sessionId);
      if (t) marks.push(t);
      else rejects.push({ event: e, reason: `no translation for change_kind ${e.change_kind}` });
      continue;
    }
    if (!e.turn_id) {
      rejects.push({ event: e, reason: 'a Glove record with no turn' });
      continue;
    }
    const t = translateGlove(e);
    if (!t) {
      rejects.push({ event: e, reason: `no translation for type ${e.type}` });
      continue;
    }
    marks.push(t);
    if (e.type === 'command_run' && e.call_id) commands.set(`${e.session_id}|${e.call_id}`, t.mark);
  }
  for (const e of vcs) {
    const cmd = commands.get(`${e.session_id}|${e.call_id}`);
    if (!cmd) {
      rejects.push({ event: e, reason: `a ${e.type} record with no command of its call id` });
      continue;
    }
    const entry = { type: e.type };
    for (const [k, v] of Object.entries(e)) {
      if (!['ts', 'session_id', 'turn_id', 'agent', 'source', 'failed', 'call_id', 'sub_agent_id', 'sub_agent_type', 'type'].includes(k)) entry[k] = v;
    }
    (cmd.detail.vcs = cmd.detail.vcs || []).push(entry);
  }
  return { marks, rejects };
}

module.exports = { translateEvents };
