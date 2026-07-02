'use strict';

/**
 * vcs-evidence.js — turn gh/git command OUTPUT into typed VCS/CI evidence.
 *
 * The dogfood lesson (see review/DOGFOOD_*.md and the two-session write-up):
 * a claim like "PR #25 merged, that fixed the failover" was reading as
 * `not_sent` because merge state lived only in lossy transcript prose, never
 * in the eventlog. So a review run after main had moved on saw the claim as
 * unbacked. The fix is to capture merge/check/HEAD state as first-class events
 * at the moment a gh/git command runs — the same PostToolUse hook that already
 * keeps the full command output verbatim in a sidecar.
 *
 * Contract, identical to the rest of capture: OBSERVE-ONLY, NEVER THROW. Every
 * parser is wrapped; on anything unrecognized we return [] rather than guess.
 * Each returned object is a partial event body (type + type-specific fields);
 * core.js wraps it with the shared base (session/turn/agent/source).
 *
 * We only ever EMIT on recognizable success output. A failed `gh pr view` (no
 * such PR) produces no PR_STATE — absence of evidence stays absence, never a
 * fabricated "merged".
 */

const { TYPES } = require('../store/eventlog');

// Normalize gh's SCREAMING state strings to the lowercase enum we store.
function normPrState(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'merged' || s === 'open' || s === 'closed') return s;
  return null;
}

// gh writes check conclusions as pass/fail/pending/skipping or, with --json,
// success/failure/neutral/etc. Fold to a small stable vocabulary.
function normConclusion(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['pass', 'success', 'completed', 'neutral', 'skipped', 'skipping'].includes(s)) return 'pass';
  if (['fail', 'failure', 'failing', 'error', 'cancelled', 'timed_out', 'action_required'].includes(s)) return 'fail';
  if (['pending', 'in_progress', 'queued', 'waiting'].includes(s)) return 'pending';
  return s || null;
}

// Best-effort JSON parse of a whole output blob or its first {...}/[...] span.
function tryJson(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to span extraction */
  }
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// --- gh pr view / gh pr list -> PR_STATE ------------------------------------

function parsePr(command, output) {
  const events = [];
  const json = tryJson(output);

  // gh pr view --json ... -> a single object; gh pr list --json ... -> array.
  const rows = Array.isArray(json) ? json : json ? [json] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const state = normPrState(row.state);
    const number = Number(row.number);
    if (!state || !Number.isFinite(number)) continue;
    const mergedSha = (row.mergeCommit && row.mergeCommit.oid) || row.mergedSha || null;
    events.push({ type: TYPES.PR_STATE, pr_number: number, pr_state: state, merged_sha: mergedSha });
  }
  if (events.length) return events;

  // Human `gh pr view` output is a TSV header block with `state:` and `number:`.
  const kv = {};
  for (const line of String(output || '').split('\n')) {
    const m = /^([a-zA-Z]+):\t(.*)$/.exec(line);
    if (m) kv[m[1].toLowerCase()] = m[2].trim();
  }
  const state = normPrState(kv.state);
  const number = Number(kv.number);
  if (state && Number.isFinite(number)) {
    events.push({ type: TYPES.PR_STATE, pr_number: number, pr_state: state, merged_sha: null });
  }
  return events;
}

// --- gh pr checks / gh run -> CI_STATE --------------------------------------

function parseChecks(command, output) {
  const json = tryJson(output);
  if (Array.isArray(json)) {
    const checks = json
      .map((c) => c && { name: c.name || c.workflowName || null, conclusion: normConclusion(c.state || c.conclusion || c.bucket) })
      .filter((c) => c && c.name);
    if (checks.length) return [{ type: TYPES.CI_STATE, ref: null, checks }];
  }
  // Human `gh pr checks`: tab-separated `name<TAB>pass|fail|pending<TAB>elapsed<TAB>url`.
  const checks = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.includes('\t')) continue;
    const cols = line.split('\t');
    const conclusion = normConclusion(cols[1]);
    if (cols[0] && conclusion) checks.push({ name: cols[0].trim(), conclusion });
  }
  return checks.length ? [{ type: TYPES.CI_STATE, ref: null, checks }] : [];
}

// --- git rev-parse / log / status / branch -> GIT_STATE ---------------------

function parseGit(command, output) {
  const text = String(output || '').trim();
  if (!text) return [];
  const shaLine = /\b([0-9a-f]{40})\b/.exec(text);
  let branch = null;
  const statusBranch = /^##\s+([^.\s]+)/m.exec(text);       // git status -b: "## main...origin/main"
  const showCurrent = /^([^\s]+)$/.exec(text);              // git branch --show-current / rev-parse --abbrev-ref
  if (statusBranch) branch = statusBranch[1];
  else if (/--abbrev-ref|--show-current|branch\b/.test(command) && showCurrent && !/^[0-9a-f]{40}$/.test(showCurrent[1])) {
    branch = showCurrent[1];
  }
  if (!shaLine && !branch) return [];
  return [{ type: TYPES.GIT_STATE, head_sha: shaLine ? shaLine[1] : null, branch }];
}

/**
 * deriveVcsEvents(command, output) -> partial event bodies (possibly empty).
 * Dispatch on the command shape. Wrapped so a parser bug can never break the
 * capture path.
 */
function deriveVcsEvents(command, output) {
  const cmd = String(command || '');
  try {
    if (/\bgh\s+pr\s+(view|list)\b/.test(cmd)) return parsePr(cmd, output);
    if (/\bgh\s+pr\s+checks\b/.test(cmd) || /\bgh\s+run\s+(list|view)\b/.test(cmd)) return parseChecks(cmd, output);
    if (/\bgit\s+(rev-parse|log|status|branch)\b/.test(cmd)) return parseGit(cmd, output);
  } catch {
    return [];
  }
  return [];
}

module.exports = { deriveVcsEvents, normPrState, normConclusion };
