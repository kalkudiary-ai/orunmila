'use strict';

/**
 * evaluate.js — run the law set against one turn. Pure, and that is the point.
 *
 * evaluateTurn() takes text and events in, and returns findings out. It touches
 * no disk, no clock, no globals. That buys three things at once:
 *
 *   1. the run-time gate can call it inside a Stop hook, where it must be fast
 *      and must never throw;
 *   2. `orunmila laws --check` can call it over any historical session, so laws
 *      written today can be run against sessions from months ago;
 *   3. it is testable without a fixture directory.
 *
 * ── The receipt model ──────────────────────────────────────────────────────
 *
 * Every evidentiary law reduces to one question: DOES A RECEIPT EXIST for what
 * was asserted? Receipts come in two strengths, and the distinction is the
 * entire substance of the grep law:
 *
 *   FULL   the turn read the file, wrote it, or ran a command over it whose
 *          output covers it. The agent has seen the thing it is talking about.
 *
 *   WEAK   the turn only pattern-matched it — a Grep/Glob tool call, or a
 *          grep/rg/ag invocation through the shell. A pattern match proves a
 *          string occurs. It cannot tell you what the code does, what else is
 *          there, or what you failed to search for. It licenses "at least
 *          these"; it never licenses "this is how it works", and it never,
 *          under any circumstance, licenses "all of them".
 *
 * The shell path matters more than the tool path. Agents overwhelmingly reach
 * for grep through Bash, which the capture layer records as a command_run, not
 * a pattern_read — so a grep law that only inspected pattern_read events would
 * miss the ordinary case and quietly pass everything. Both paths are handled.
 *
 * ── On honesty ─────────────────────────────────────────────────────────────
 *
 * Every finding carries `heuristic: true`. The law layer reads prose, and prose
 * is not a fact. These findings sit BESIDE the glove's recordings and the
 * sentinel's observations — never inside them, and never presented with the
 * same authority. A finding says "recheck this", not "you lied".
 */

const { extractAssertions } = require('./assert-extractor');
const { maskQuoted } = require('./assert-extractor');
const { basename } = require('../reconcile/task-extractor');
const HOME_DIR = require('os').homedir().toLowerCase();

// Shell invocations that are pattern matches wearing a command's clothes.
const SHELL_PATTERN_RE = /(^|[|;&]\s*)(grep|egrep|fgrep|rg|ag|ack|ripgrep)\b/i;

/**
 * Split a shell line into INDEPENDENT commands, and grade each one separately.
 *
 * Receipt strength is a property of a PIPELINE, not of a whole line, and reading
 * the line as one unit had a precise and measurable consequence. The rule used to
 * be "is this a pattern AND does the line not also mention cat/head/tail/sed -n".
 * So `grep -rn "x" src/ | head` matched on its `head` and was filed as a FULL
 * READ of every file the grep named.
 *
 * Measured over this user's own corpus on 2026-08-16: 457 shell greps, of which
 * 292 (63.9%) were piped into head/tail/cat/sed/awk — `| head` alone accounted
 * for 219. Nearly two thirds of every pattern match ever run was recorded as
 * though the agent had read the files. That is the exact receipt
 * no-grep-as-basis must NOT find, and it is the largest reason the law fired
 * ZERO times across 137 claimed turns while the corpus filled with greps.
 *
 * The fix is not to drop the read exemption wholesale, because a compound line
 * can honestly do both: `sed -n '1,40p' a.ts; grep x b.ts` really did read a.ts
 * and really did only pattern-match b.ts. 49 of the 292 were that shape. So:
 *
 *   - split on `;`, `&&`, `||` — these separate INDEPENDENT commands;
 *   - do NOT split on a single `|` — those stages share one pipeline;
 *   - a pattern stage ANYWHERE in a pipeline filters what the agent saw, so the
 *     whole pipeline is weak. A pager downstream of a grep truncates a pattern
 *     match; it does not turn one into a read.
 */
function classifyShellLine(command) {
  const full = [];
  const weak = [];
  for (const segment of String(command || '').split(/;|&&|\|\|/)) {
    const seg = segment.trim();
    if (!seg) continue;
    (SHELL_PATTERN_RE.test(seg) ? weak : full).push(seg);
  }
  return { full, weak };
}

/**
 * Does this command's exit code actually mean what it appears to mean?
 *
 * In a POSIX shell a pipeline reports the exit status of its LAST stage only.
 * `npm test | tail -5` exits 0 when the suite is on fire, because `tail`
 * succeeded. Every "green" receipt in this module rests on an exit code, so an
 * unguarded pipeline launders a red run into a silent pass — and a verification
 * law that accepts one is worse than no law, because it certifies the failure.
 *
 * This was not a theoretical hole. It was found by running orunmila's own
 * close-out gate over the session that built this file: three test runs failed
 * and §2b reported "none", because every one had been piped through grep or
 * tail and the pipeline's own exit code was grep's.
 *
 * `set -o pipefail` (or an explicit PIPESTATUS check) restores the meaning, so
 * a command that opts into it is trusted. `||` and `|&` are not pipes for this
 * purpose. Quoted spans are stripped first so a literal "|" in an argument does
 * not count.
 */
function hasUnguardedPipe(command) {
  const cmd = String(command || '');
  if (/pipefail|PIPESTATUS/.test(cmd)) return false;
  const bare = cmd
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\|\|/g, '')  // logical OR is not a pipeline
    .replace(/\|&/g, '');  // bash's |& is a redirect form, not a plain pipe
  return bare.includes('|');
}

/**
 * How strong a receipt is this file_read? Prefers the explicit `read_kind`
 * field when the capture layer recorded one, and falls back to the hash proxy
 * for events captured before that field existed — which is most of any user's
 * history, so the fallback is the common path, not a corner case.
 *
 * The proxy: a full read of a real file carries a content hash; a pattern read
 * stores the PATTERN in `path` and has no hash to carry. A read that failed
 * outright is neither — it is evidence of nothing.
 */
function readStrength(e) {
  if (e.read_kind === 'pattern') return 'weak';
  if (e.read_kind === 'full') return 'full';
  if (e.failed === true) return 'none';
  return e.hash ? 'full' : 'weak';
}

/**
 * Fold a turn's events into the receipts the rules join against.
 */
function buildReceipts(turnEvents) {
  const full = [];   // { text, kind } — things the turn actually saw
  const weak = [];   // { text, kind } — things the turn only pattern-matched
  const passingCommands = [];
  const failedCommands = [];
  // Exited zero, but through an unguarded pipeline — the zero is the last
  // stage's, not the work's. Kept separate so a finding can say so out loud
  // rather than silently treating it as either pass or fail.
  const unreliableCommands = [];

  for (const e of turnEvents || []) {
    if (e.type === 'file_read') {
      const strength = readStrength(e);
      if (strength === 'none') continue;
      const bucket = strength === 'full' ? full : weak;
      bucket.push({ text: String(e.path || ''), kind: strength === 'full' ? 'read' : 'pattern_read' });
      continue;
    }

    if (e.type === 'file_write') {
      // Writing a file means having produced its content — the strongest
      // receipt there is for a claim about what it now contains.
      full.push({ text: String(e.path || ''), kind: 'write' });
      continue;
    }

    if (e.type === 'command_run') {
      const command = String(e.command || '');
      const out = String(e.stdout_excerpt || '');
      const ok = e.exit_code === 0 || (e.exit_code === undefined && e.failed !== true);
      // A green exit only counts as PROOF OF GREEN when the exit code means what
      // it says. A piped command still counts as a content receipt below (its
      // output really did name those files) — it just cannot certify that
      // anything passed. The two roles are separated deliberately.
      const laundered = hasUnguardedPipe(command);
      if (ok && !laundered) passingCommands.push({ command, out });
      else if (ok && laundered) unreliableCommands.push({ command });
      else failedCommands.push({ command, exit_code: e.exit_code });

      // A grep run through the shell is a WEAK receipt no matter how confident
      // the sentence that follows it, and no matter what is piped after it. Each
      // independent command on the line is filed on its own merits — see
      // classifyShellLine for why the whole line cannot be graded as one.
      const segments = classifyShellLine(command);
      for (const seg of segments.full) full.push({ text: seg, kind: 'command' });
      for (const seg of segments.weak) weak.push({ text: seg, kind: 'shell_pattern' });

      // Output is attributed separately, because it can name a target the
      // command line never does: `npm test` names the failing file only in
      // stdout. But if ANY stage on the line was a pattern, what came back is
      // filtered — so the output is only as strong as the weakest thing that
      // shaped it. `npm test > out.txt; grep FAIL out.txt` shows you grep's
      // view, not the suite's.
      if (out) {
        (segments.weak.length ? weak : full).push({
          text: out,
          kind: segments.weak.length ? 'shell_pattern' : 'command',
        });
      }
      continue;
    }

    // A tool call IS a receipt, and forgetting that was the single largest
    // source of false accusations when this layer was first measured against
    // real sessions: an agent that answers a question by querying the database
    // through an MCP tool has done the work, but every one of those turns read
    // as "zero receipts" and every claim in them as invented. Reading the
    // database is not reading a file, and the layer must not mistake the
    // difference for an absence of evidence.
    //
    // The tool's name and its input are what name the target — an execute_sql
    // call carries the table in its query, a log fetch carries the service.
    if (e.type === 'tool_call') {
      let inputText;
      try {
        inputText = typeof e.input === 'string' ? e.input : JSON.stringify(e.input || {});
      } catch {
        inputText = ''; // an un-serialisable input is still a receipt for the tool name
      }
      // The result is included only when the user opted into capturing it
      // (ORUNMILA_CAPTURE_TOOL_RESULTS=1). Without it the tool name and input
      // still form a receipt — weaker, but real: a query that names a table is
      // evidence the table was looked at, even if the rows are off-log.
      const resultText = e.result_excerpt ? '\n' + String(e.result_excerpt) : '';
      full.push({ text: `${e.tool_name || 'tool'} ${inputText}${resultText}`, kind: 'tool_call' });
      continue;
    }

    if (e.type === 'network_call') {
      full.push({ text: `${e.tool_name || 'network'} ${e.host || ''} ${e.target || ''}`, kind: 'network_call' });
      continue;
    }
  }

  return { full, weak, passingCommands, failedCommands, unreliableCommands };
}

/**
 * Does this receipt text cover this target? Paths are compared on basename so
 * `src/wallet/debit.ts` in a claim matches a read of the absolute path; symbols
 * and literals are substring-matched, lower-cased on both sides.
 */
// A receipt and a claim can name the same file in different scripts: the shell
// prints an absolute path, prose writes `~/tools/…`, and an arrow in a sentence
// may be the Unicode → rather than ->. The match is a raw substring test, so
// those spellings silently read as NO EVIDENCE AT ALL — a false accusation
// against a turn that did the work. Normalise both sides before comparing.
function normaliseForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .split(HOME_DIR).join('~')   // absolute home path and ~ become one spelling
    .replace(/[→⇒]/g, '->')
    .replace(/\\/g, '/');
}

function covers(receiptText, target) {
  const hay = normaliseForMatch(receiptText);
  if (!hay) return false;
  const needle = normaliseForMatch(target.value);
  if (!needle || needle.length < 3) return false; // too short to match meaningfully
  if (target.kind === 'path') {
    return hay.includes(needle) || basename(hay).includes(needle);
  }
  return hay.includes(needle);
}

/** 'full' | 'weak' | 'none' — the best receipt the turn holds for one target. */
function receiptStrength(target, receipts) {
  if (receipts.full.some((r) => covers(r.text, target))) return 'full';
  if (receipts.weak.some((r) => covers(r.text, target))) return 'weak';
  return 'none';
}

function finding(law, assertion, detail) {
  return {
    law_id: law.id,
    title: law.title,
    severity: law.severity,
    kind: law.kind,
    rule: law.rule || null,
    message: law.message,
    remedy: law.remedy,
    cite: law.cite,
    source: law.source,
    layer: law.layer,
    // Never presented with the authority of a glove recording. The law layer
    // reads prose; prose is not a fact.
    heuristic: true,
    evidence: {
      text: assertion ? assertion.text : null,
      targets: assertion ? assertion.targets.map((t) => `${t.kind}:${t.raw || t.value}`) : [],
      ...detail,
    },
  };
}

// --- the evidentiary rules --------------------------------------------------
// Each takes (assertion, receipts, ctx) and returns a detail object to attach,
// or null for "this law does not fire here". They are deliberately small and
// each answers exactly one yes/no question about whether a receipt exists.

const RULES = {
  /**
   * Narrowed to targets written as a PATH — something with a separator in it,
   * like `src/render/trail-visual.js`.
   *
   * Measured over 194 sessions this law fired 12 times and about 2 were real.
   * Every false positive was the same shape: a DEPENDENCY or command name that
   * happened to sit in a grep pattern — "it requires internet to load Three.js
   * and 3d-force-graph from CDN", "debug-transcript exists because parsers come
   * back empty". Those are claims about the world, not about this codebase, and
   * no amount of reading a local file would settle them.
   *
   * The single genuine catch named a real path: "grep nodeThreeObject(
   * src/render/trail-visual.js returns 0 hits, only one THREE. reference
   * remains" — a claim about what IS and IS NOT in a specific file, resting
   * entirely on a pattern match. That is the law exactly.
   *
   * Requiring a separator is deliberately conservative: it misses a bare
   * basename ("debit.ts is fine"). For a law that STOPS a turn, a miss costs a
   * catch and a false fire costs trust, and trust is the scarcer resource.
   */
  pattern_read_only(assertion, receipts) {
    const pathTargets = assertion.targets.filter((t) => t.kind === 'path' && /[\\/]/.test(String(t.raw || '')));
    if (!pathTargets.length) return null;
    const strengths = pathTargets.map((t) => ({ t, s: receiptStrength(t, receipts) }));
    // Fires only when the turn DID look — via a pattern — and never looked
    // properly. If any target was genuinely read, the agent has done the work.
    if (strengths.some((x) => x.s === 'full')) return null;
    const weak = strengths.filter((x) => x.s === 'weak');
    if (!weak.length) return null;
    return {
      pattern_matched_targets: weak.map((x) => x.t.raw || x.t.value),
      weak_receipts: receipts.weak.map((r) => r.kind + ': ' + r.text.split('\n')[0].slice(0, 120)),
    };
  },

  no_receipt(assertion, receipts) {
    if (!assertion.targets.length) return null;
    const strengths = assertion.targets.map((t) => receiptStrength(t, receipts));
    // Every single target unseen. If even one was looked at, this is a partial
    // claim, not an invented one — and the other rules cover that case.
    if (!strengths.every((s) => s === 'none')) return null;
    return {
      unreceipted_targets: assertion.targets.map((t) => t.raw || t.value),
      receipts_in_turn: receipts.full.length + receipts.weak.length,
    };
  },

  absolute_without_enumeration(assertion, receipts) {
    if (!assertion.absolute) return null;
    if (!assertion.targets.length) return null;
    // An absolute needs a receipt that could have enumerated the set. A single
    // full read of one member cannot license "all of them" — but it is at least
    // evidence, so the rule fires only when nothing was properly read at all.
    const anyFull = assertion.targets.some((t) => receiptStrength(t, receipts) === 'full');
    if (anyFull) return null;
    return {
      absolute_claim: true,
      absolute_marker: assertion.absoluteMarker,
      enumerating_receipts: 0,
    };
  },

  hedged_assertion(assertion) {
    if (!assertion.hedged) return null;
    return { hedged: true };
  },

  verification_without_command(assertion, receipts) {
    if (!assertion.verification) return null;
    if (receipts.passingCommands.length) return null;
    return {
      passing_commands: 0,
      failed_commands: receipts.failedCommands.map((c) => `exit ${c.exit_code}: ${c.command}`),
      // Named explicitly so the remedy is obvious: the run may well have been
      // green, but this pipeline cannot say so.
      exit_code_laundered_by_pipe: receipts.unreliableCommands.map((c) => c.command),
    };
  },
};

// --- lexical evaluation -----------------------------------------------------

function lexicalHits(law, { claimText, promptText, turnEvents }) {
  const hits = [];
  const scopes = law.scope === 'any' ? ['claim', 'command', 'prompt'] : [law.scope];

  const subjects = [];
  if (scopes.includes('claim') && claimText) subjects.push({ where: 'claim', text: claimText });
  if (scopes.includes('prompt') && promptText) subjects.push({ where: 'prompt', text: promptText });
  if (scopes.includes('command')) {
    for (const e of turnEvents || []) {
      if (e.type === 'command_run' && e.command) subjects.push({ where: 'command', text: String(e.command) });
    }
  }

  for (const subject of subjects) {
    // A command is matched raw: quoting inside a shell line is syntax, not the
    // agent quoting itself. Prose is masked so a word being DISCUSSED does not
    // trip the law that forbids USING it — without this, the turn that explains
    // a law violates it.
    const text = law.maskQuoted && subject.where !== 'command' ? maskQuoted(subject.text) : subject.text;
    if (law.unless.some((re) => re.test(text))) continue;
    for (let i = 0; i < law.patterns.length; i++) {
      const m = law.patterns[i].exec(text);
      if (!m) continue;
      hits.push({
        where: subject.where,
        pattern: law.rawPatterns[i] || String(law.patterns[i]),
        matched: m[0],
        excerpt: subject.text.slice(Math.max(0, m.index - 60), m.index + 120).trim(),
      });
      break; // one hit per law per subject is enough to make the point
    }
  }
  return hits;
}

/**
 * Evaluate every active law against one turn.
 *
 * @param {object}   input
 * @param {string}   input.claimText   the agent's own response text for the turn
 * @param {string}   input.promptText  the instruction that opened the turn
 * @param {object[]} input.turnEvents  every captured event in the turn
 * @param {object[]} input.laws        the resolved, active law set
 * @returns {{ findings: object[], blocking: object[], assertions: object[] }}
 */
function evaluateTurn({ claimText = '', promptText = '', turnEvents = [], laws = [] } = {}) {
  const receipts = buildReceipts(turnEvents);
  const assertions = extractAssertions(claimText);
  const findings = [];

  for (const law of laws) {
    if (!law.enabled) continue;

    if (law.kind === 'lexical') {
      for (const hit of lexicalHits(law, { claimText, promptText, turnEvents })) {
        findings.push(finding(law, null, { where: hit.where, pattern: hit.pattern, matched: hit.matched, excerpt: hit.excerpt }));
      }
      continue;
    }

    const rule = RULES[law.rule];
    if (!rule) continue; // schema validation already rejected unknown rules
    for (const assertion of assertions) {
      const detail = rule(assertion, receipts, { laws });
      if (detail) findings.push(finding(law, assertion, detail));
    }
  }

  return {
    findings,
    blocking: findings.filter((f) => f.severity === 'block'),
    assertions,
    receipts: {
      full: receipts.full.length,
      weak: receipts.weak.length,
      passing_commands: receipts.passingCommands.length,
      failed_commands: receipts.failedCommands.length,
      unreliable_commands: receipts.unreliableCommands.length,
    },
  };
}

module.exports = { evaluateTurn, buildReceipts, receiptStrength, readStrength, covers, hasUnguardedPipe, RULES, SHELL_PATTERN_RE };