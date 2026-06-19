'use strict';

/**
 * matcher.js
 *
 * Produces the actual stain: for a single turn, reconciles
 *   - what was asked (subtasks, from the original prompt)
 *   - what was claimed (claims, from the agent's response)
 *   - what actually happened (events: file_write diffs, command_run, tool_call)
 *
 * Outcome categories (the "what"):
 *   verified              - claimed, and evidence backs it up
 *   partial                - touched, but diff is scaffolding-only (substance gap #4)
 *   phantom                - claimed, zero evidence anywhere this turn
 *   phantom_verification   - claimed "tested/works/verified" with no passing command_run
 *                            backing it (gap #1/#9 combined)
 *   unverifiable           - claim too hedged/vague to check at all (gap #2)
 *   undisclosed             - diff/command exists that no claim and no subtask covers (scope creep)
 *   silently_dropped       - subtask from the original ask has zero matching evidence
 *                            AND the claim text never even mentions it (gap #3)
 *   untracked_write        - the Filesystem Sentinel saw a real content change on
 *                            disk that NO hook-sourced event this turn accounts for
 *                            (PRD 6.4). This is the inverse direction: here the
 *                            hook stream is the "claim" and the sentinel is the
 *                            "reality." It ranks above everything else and prints
 *                            at the TOP of the report — a write the agent's own
 *                            tool API never disclosed is the highest-signal stain.
 */

const { extractSubtasks, basename } = require('./task-extractor');
const { extractClaims } = require('./claim-extractor');
const { substanceStats } = require('./difftool');
const provenance = require('./provenance');

const SUBSTANCE_RATIO_FLOOR = 0.5; // below this share of real-logic lines -> scaffolding-only
const TRIVIAL_BODY = /^\s*(?:return\s*(?:null|undefined|none|true|false|\{\}|\[\]|''|"")?\s*;?|pass|\{\}|;|todo|fixme)\s*$/i;

// A diff whose only substantive added line is a trivial stub body
// (return null, pass, {}) shouldn't score the same as a real implementation.
function isTrivialStub(diff) {
  if (!diff) return false;
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  const substantive = added.filter((b) => b.trim() !== '' && !/^\s*(\/\/|#|\*|\/\*|"""|'''|<!--)/.test(b));
  if (!substantive.length) return false;
  return substantive.every((l) => TRIVIAL_BODY.test(l) || /[){]\s*$/.test(l) || /^\s*(function|const|let|var|def|class)\b/.test(l));
}

function outcomeForClaim(claim, prov) {
  if (prov.provenance === 'unverifiable') return 'unverifiable';
  if (prov.provenance === 'not_sent' || prov.provenance === 'disregarded_failure') {
    return claim.verificationClaim ? 'phantom_verification' : 'phantom';
  }

  const writeEvents = prov.evidence.filter((e) => e.type === 'file_write');
  if (writeEvents.length) {
    const totals = writeEvents.reduce(
      (acc, e) => {
        const s = substanceStats(e.diff);
        acc.addedSubstance += s.addedSubstance;
        acc.added += s.added;
        return acc;
      },
      { addedSubstance: 0, added: 0 }
    );
    const ratio = totals.addedSubstance / Math.max(totals.added, 1);
    const tinyPureStub = totals.added <= 3 && totals.addedSubstance === 0;
    const mostlyScaffolding = totals.added > 3 && ratio < SUBSTANCE_RATIO_FLOOR;
    const allTrivial = writeEvents.length && writeEvents.every((e) => isTrivialStub(e.diff));
    if (totals.added > 0 && (tinyPureStub || mostlyScaffolding || allTrivial)) return 'partial';
  }

  return 'verified';
}

// untracked_write: a sentinel-sourced file_write for a path that NO hook-sourced
// event in the same turn window touched. Comparison is basename equality (so
// dist/app.js and src/app.js don't falsely cancel each other), and we count a
// hook file_read or command_run on the same basename as "accounted for" too —
// the agent at least interacted with that path through its tool API. A sentinel
// write the hook stream is completely silent about is the real stain.
function findUntrackedWrites(turnEvents) {
  const sentinelWrites = turnEvents.filter(
    (e) => e.type === 'file_write' && e.source === 'fs-sentinel' && e.path
  );
  if (!sentinelWrites.length) return [];

  const hookBasenames = new Set();
  for (const e of turnEvents) {
    if (e.source === 'fs-sentinel') continue; // only hook-sourced events count as disclosure
    const p = e.path || e.rel_path;
    if (p) hookBasenames.add(basename(String(p)).toLowerCase());
  }

  return sentinelWrites.filter((e) => {
    const base = basename(String(e.rel_path || e.path)).toLowerCase();
    return !hookBasenames.has(base);
  });
}

function reconcileTurn({ promptText, claimText, turnEvents }) {
  const subtasks = extractSubtasks(promptText);
  const claims = extractClaims(claimText);

  // The sentinel cross-check (PRD 6.4). Done first so its paths can be excluded
  // from the ordinary undisclosed bucket — an untracked_write is strictly more
  // serious and must not be double-counted as plain scope-creep below.
  const untracked = findUntrackedWrites(turnEvents);
  const untrackedPaths = new Set(untracked.map((e) => String(e.path)));

  const claimResults = claims.map((claim) => {
    const prov = provenance.classify(claim, turnEvents);
    return {
      claim,
      provenance: prov.provenance,
      causeHints: prov.causeHints,
      evidence: prov.evidence,
      outcome: outcomeForClaim(claim, prov),
    };
  });

  const claimTextLower = (claimText || '').toLowerCase();
  const subtaskResults = subtasks.map((task) => {
    const targets = task.targets || [];
    // No extractable target at all -> we honestly cannot tell what to look for.
    // Per PRD §3 ("be honest about inference limits"), this must NOT masquerade
    // as silently_dropped. It's a limit of the tool, not a finding about the agent.
    if (!targets.length) {
      return { task, outcome: 'unverifiable_ask', evidence: [] };
    }
    const matches = provenance.eventsMentioning(turnEvents, task);
    const mentionedInClaim = targets.some((t) => t.value && claimTextLower.includes(t.value));
    let outcome;
    if (matches.length) outcome = 'addressed';
    else if (mentionedInClaim) outcome = 'acknowledged_incomplete';
    else outcome = 'silently_dropped';
    return { task, outcome, evidence: matches };
  });

  // Undisclosed = a file write whose basename matches no path/phrase target
  // from any claim or subtask. Built from TYPED targets, so an empty keyword
  // set no longer floods every write as undisclosed.
  const allTargets = [
    ...claims.flatMap((c) => c.targets || []),
    ...subtasks.flatMap((t) => t.targets || []),
  ];
  const hasAnyTarget = allTargets.length > 0;

  // Ordinary undisclosed is about the agent's OWN disclosed writes that no
  // claim/subtask covers (scope creep the agent did announce via its tools).
  // Exclude sentinel-sourced writes here: a sentinel write is either already an
  // untracked_write (handled above) or it mirrors a hook write that is judged on
  // its own. Counting it here too would double-report the same change.
  const writeEvents = turnEvents.filter(
    (e) => e.type === 'file_write' && e.source !== 'fs-sentinel'
  );
  const undisclosed = writeEvents.filter((e) => {
    if (!e.path) return false;
    if (untrackedPaths.has(String(e.path))) return false; // ranked elsewhere, don't double-count
    if (!hasAnyTarget) return false; // can't assert scope-creep with nothing to compare against
    return !allTargets.some((t) => provenance.targetMatchesEvent(t, e));
  });

  return {
    subtasks: subtaskResults,
    claims: claimResults,
    undisclosed,
    untracked,
    summary: summarize(claimResults, subtaskResults, undisclosed, untracked),
  };
}

function summarize(claimResults, subtaskResults, undisclosed, untracked) {
  const count = (arr, key, val) => arr.filter((x) => x[key] === val).length;
  return {
    verified: count(claimResults, 'outcome', 'verified'),
    partial: count(claimResults, 'outcome', 'partial'),
    phantom: count(claimResults, 'outcome', 'phantom'),
    phantom_verification: count(claimResults, 'outcome', 'phantom_verification'),
    unverifiable: count(claimResults, 'outcome', 'unverifiable'),
    silently_dropped: count(subtaskResults, 'outcome', 'silently_dropped'),
    unverifiable_ask: count(subtaskResults, 'outcome', 'unverifiable_ask'),
    undisclosed_changes: undisclosed.length,
    untracked_writes: (untracked || []).length,
  };
}

module.exports = { reconcileTurn };
