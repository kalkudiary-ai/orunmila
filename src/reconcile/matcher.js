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

// Infrastructure paths: agent-owned scratch surfaces (memory files, plan
// files, OS scratch dirs, lockfiles, persisted bench results). A diff to
// one of these is never a "stub" deliverable and never an "undisclosed"
// scope creep — they're operational artifacts, not work output. The four
// dogfood reports were dominated by false positives over these paths.
const INFRA_PATH_RES = [
  /(?:^|\/)\.claude\/(?:plans|memory|projects|.*memory)\//i,
  /(?:^|\/)memory\/[^/]+\.md$/i,
  /^\/(?:private\/)?tmp\//i,
  /(?:^|\/)bench-results\/.*\.json$/i,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$/i,
  /(?:^|\/)\.orunmila\//i,
  /(?:^|\/)coverage\//i,
];

function isInfrastructurePath(p) {
  if (!p) return false;
  const s = String(p);
  return INFRA_PATH_RES.some((re) => re.test(s));
}

// Phrase → concrete-path canonical map. The original ask often names a
// component in plain English ("CI", "linter", "issue templates") and the
// landed files don't textually overlap with the phrase. Without an alias
// map every one of these landed files gets graded undisclosed turn after
// turn. The list is small and intentional — we want strong signals, not a
// dictionary.
const PHRASE_ALIASES = [
  { phrase: ['ci', 'github actions', 'actions'], pattern: /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i },
  { phrase: ['linter', 'eslint'], pattern: /(?:^|\/)(?:eslint\.config\.(?:js|cjs|mjs|ts)|\.eslintrc(?:\.[a-z]+)?)$/i },
  { phrase: ['formatter', 'prettier'], pattern: /(?:^|\/)(?:\.prettierrc(?:\.[a-z]+)?|prettier\.config\.(?:js|cjs|mjs))$/i },
  { phrase: ['prettier ignore'], pattern: /(?:^|\/)\.prettierignore$/i },
  { phrase: ['issue templates', 'issue template', 'bug report', 'feature request'], pattern: /(?:^|\/)\.github\/ISSUE_TEMPLATE\//i },
  { phrase: ['pr template', 'pull request template'], pattern: /(?:^|\/)\.github\/PULL_REQUEST_TEMPLATE\.md$/i },
  { phrase: ['changelog'], pattern: /(?:^|\/)CHANGELOG(?:\.md)?$/i },
  { phrase: ['contributing'], pattern: /(?:^|\/)CONTRIBUTING(?:\.md)?$/i },
  { phrase: ['code of conduct', 'coc'], pattern: /(?:^|\/)CODE_OF_CONDUCT(?:\.md)?$/i },
  { phrase: ['security policy', 'security'], pattern: /(?:^|\/)SECURITY(?:\.md)?$/i },
  { phrase: ['funding'], pattern: /(?:^|\/)\.github\/FUNDING\.ya?ml$/i },
  { phrase: ['dependabot'], pattern: /(?:^|\/)\.github\/dependabot\.ya?ml$/i },
  { phrase: ['readme'], pattern: /(?:^|\/)README(?:\.md)?$/i },
  { phrase: ['gitignore'], pattern: /(?:^|\/)\.gitignore$/i },
  { phrase: ['coverage config', 'c8'], pattern: /(?:^|\/)\.c8rc(?:\.json)?$/i },
  { phrase: ['license'], pattern: /(?:^|\/)LICENSE(?:\.[a-z]+)?$/i },
];

function aliasMatchesPath(phraseValue, path) {
  if (!phraseValue || !path) return false;
  const v = String(phraseValue).toLowerCase();
  for (const a of PHRASE_ALIASES) {
    if (a.phrase.some((p) => v.includes(p))) {
      if (a.pattern.test(path)) return true;
    }
  }
  return false;
}

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
  // Structural lines (signatures, opening/closing braces) carry no logic. A diff
  // whose only non-structural line is a trivial body (return null / pass / {}) is
  // a stub, even when wrapped in `function f() { ... }` with a closing `}`.
  const isStructural = (l) =>
    /[){[]\s*$/.test(l) || // opens a block / arg list / array
    /^\s*[)}\]]+;?\s*$/.test(l) || // closes one: }  )  ];  })
    /^\s*(function|const|let|var|def|class|export|public|private|async)\b/.test(l);
  return substantive.every((l) => TRIVIAL_BODY.test(l) || isStructural(l));
}

// A diff is grading-eligible for "partial" only if it looks like a new or
// near-empty file. An edit landing inside an existing file with real
// surrounding logic is not a stub, even when the hunk itself is small.
// The dogfood data showed small edits to long-lived files getting graded
// partial just because their substance ratio dipped under 0.5.
function isLikelyNewOrEmptyFile(e) {
  // The hook events carry `is_new` when the writer knows; if not, fall back
  // to the diff shape: a unified diff against an empty `before` has no `-`
  // lines and the substance lives in the added body.
  if (e && e.is_new === true) return true;
  if (e && e.before === '') return true;
  if (!e || !e.diff) return false;
  const removed = e.diff
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  // No removed lines AND under 10 added → likely a small new file or the
  // file was empty before. Anything with removed context lines is an edit.
  if (removed > 0) return false;
  const added = e.diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  return added <= 10;
}

function outcomeForClaim(claim, prov) {
  if (prov.provenance === 'unverifiable') return 'unverifiable';
  if (prov.provenance === 'not_sent' || prov.provenance === 'disregarded_failure') {
    return claim.verificationClaim ? 'phantom_verification' : 'phantom';
  }

  const writeEvents = prov.evidence.filter((e) => e.type === 'file_write');
  if (writeEvents.length) {
    // Infrastructure paths (memory/plan/tmp/lockfile/coverage): a diff there
    // is operational, never a "stub". Treat as verified.
    const allInfra = writeEvents.every((e) => isInfrastructurePath(e.path));
    if (allInfra) return 'verified';

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

    // Only call partial when the file itself plausibly *is* a stub — a new
    // or near-empty file. An edit inside an existing logic-bearing file is
    // a real edit, not scaffolding.
    const allLookLikeNewOrEmpty = writeEvents.every(isLikelyNewOrEmptyFile);
    if (totals.added > 0 && (tinyPureStub || mostlyScaffolding || allTrivial) && allLookLikeNewOrEmpty) {
      return 'partial';
    }
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

function reconcileTurn({ promptText, claimText, turnEvents, sessionTargets }) {
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
  //
  // sessionTargets (added after the dogfood reports): a turn-7 write
  // implementing a turn-1 ask shouldn't be flagged just because the local
  // claim text doesn't repeat the filename. The reconciler's caller passes
  // the union of every previous turn's targets here so the matcher can
  // honor the original ask across the session.
  const localTargets = [
    ...claims.flatMap((c) => c.targets || []),
    ...subtasks.flatMap((t) => t.targets || []),
  ];
  const allTargets = sessionTargets && sessionTargets.length
    ? localTargets.concat(sessionTargets)
    : localTargets;
  const hasAnyTarget = allTargets.length > 0;

  // Ordinary undisclosed is about the agent's OWN disclosed writes that no
  // claim/subtask covers (scope creep the agent did announce via its tools).
  // Exclude sentinel-sourced writes here: a sentinel write is either already an
  // untracked_write (handled above) or it mirrors a hook write that is judged on
  // its own. Counting it here too would double-report the same change.
  const writeEvents = turnEvents.filter(
    (e) => e.type === 'file_write' && e.source !== 'fs-sentinel'
  );
  const undisclosedRaw = writeEvents.filter((e) => {
    if (!e.path) return false;
    if (untrackedPaths.has(String(e.path))) return false; // ranked elsewhere, don't double-count
    if (isInfrastructurePath(e.path)) return false; // memory/plan/tmp/lockfile/coverage: operational
    if (!hasAnyTarget) return false; // can't assert scope-creep with nothing to compare against
    if (allTargets.some((t) => provenance.targetMatchesEvent(t, e))) return false;
    // Phrase alias check: phrase targets like "CI" / "linter" / "issue
    // templates" don't textually overlap with the file they produced; this
    // is the canonical map covering the dominant alias gaps from the
    // dogfood data.
    const phraseTargets = allTargets.filter((t) => t.kind === 'phrase');
    if (phraseTargets.some((t) => aliasMatchesPath(t.value, e.path))) return false;
    return true;
  });

  // Dedupe: the same path getting written N times in one turn should be one
  // finding with a count, not N findings. Same for subsequent reporting
  // layers — see review/DOGFOOD_*.md (the 327-issue report had test/hooks.js
  // listed 13 times).
  const undisclosed = dedupeByPath(undisclosedRaw);

  return {
    subtasks: subtaskResults,
    claims: claimResults,
    undisclosed,
    untracked,
    summary: summarize(claimResults, subtaskResults, undisclosed, untracked),
  };
}

function dedupeByPath(events) {
  const seen = new Map();
  for (const e of events) {
    const key = String(e.path || e.rel_path || '');
    if (!key) continue;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, Object.assign({}, e, { occurrences: 1 }));
    } else {
      prior.occurrences += 1;
    }
  }
  return Array.from(seen.values());
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

const OPPOSING_VERBS = {
  added: ['removed', 'deleted'],
  created: ['removed', 'deleted'],
  implemented: ['removed', 'deleted', 'reverted'],
  wrote: ['removed', 'deleted'],
  installed: ['removed', 'deleted', 'uninstalled'],
  configured: ['removed', 'deleted', 'disabled'],
  introduced: ['removed', 'deleted', 'reverted'],
  set: ['removed', 'deleted', 'disabled', 'reverted'],
  fixed: ['broke', 'reverted'],
  updated: ['reverted'],
  replaced: ['reverted'],
  removed: ['added', 'created', 'implemented', 'restored'],
  deleted: ['added', 'created', 'restored'],
};

function detectContradictions(turnResults) {
  const allClaims = [];
  for (const turn of turnResults) {
    for (const cr of (turn.claims || [])) {
      allClaims.push({ turn: turn.turn_id, claim: cr.claim, outcome: cr.outcome });
    }
  }

  const contradictions = [];
  for (let i = 0; i < allClaims.length; i++) {
    for (let j = i + 1; j < allClaims.length; j++) {
      const a = allClaims[i], b = allClaims[j];
      if (a.turn === b.turn) continue;

      const aTargets = (a.claim.targets || []);
      const bTargets = (b.claim.targets || []);
      const shared = aTargets.filter((ta) =>
        bTargets.some((tb) => ta.value === tb.value && ta.kind === tb.kind)
      );
      if (!shared.length) continue;

      for (const va of (a.claim.verbs || [])) {
        const opposites = OPPOSING_VERBS[va];
        if (!opposites) continue;
        for (const vb of (b.claim.verbs || [])) {
          if (opposites.includes(vb)) {
            contradictions.push({
              target: shared[0].value,
              earlier: { turn: a.turn, text: a.claim.text, verb: va },
              later: { turn: b.turn, text: b.claim.text, verb: vb },
            });
          }
        }
      }
    }
  }
  return contradictions;
}

module.exports = {
  reconcileTurn,
  detectContradictions,
  isInfrastructurePath,
  aliasMatchesPath,
  PHRASE_ALIASES,
};
