# Design: Extractor & Matcher Rewrite (P1-1, P1-2, P1-3)

This is the accuracy cliff. Three confirmed failures share one root: the
matcher's only notion of "what a sentence is about" is a handful of code-token
regexes, and its only notion of "match" is `String.includes`. Fix the
target-extraction and the comparison, and all three failures resolve.

Confirmed failures this addresses:
- Correct plain-English work → false `silently_dropped` (P1-1)
- Wrong file edited → still `verified` (P1-2, false negative)
- `js` matches every `.js` file (P1-2, false positive)
- Empty keywords → every write `undisclosed` (P1-3)

The goal is NOT NLP. It's a sturdier heuristic with an honest fallback, plus a
clean seam where the optional LLM judge (PRD §4) slots in to handle what
heuristics can't.

## 1. Replace "keywords" with typed "targets"

`extractKeywords` returns a flat lowercased string list with no notion of what
each token *is*. Replace with typed targets so the matcher can compare like
with like:

```js
// each target: { kind, value, raw }
kind ∈ {
  "path",       // a file path or basename: login.js, src/auth.ts, README
  "symbol",     // an identifier: getUser, rate_limit, DashboardView
  "phrase",     // a content noun phrase: "user authentication", "rate limiting"
  "literal",    // quoted string from the prompt/claim
}
```

### Path extraction — fix the bare-extension bug
Current regex captures group 1 = the extension. Capture the **whole** match:
```
/(?:[\w./-]+)?[\w-]+\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|json|md|yml|yaml|css|html|sql)\b/gi
```
Keep the full token (`login.js`, `src/auth.ts`) as `kind:"path"`, value =
the basename (`login.js`). Also recognize extension-less well-known names:
`README`, `Dockerfile`, `Makefile`, `LICENSE`, `.gitignore`.

### Symbol extraction — unchanged regexes, retyped
camelCase / snake_case / PascalCase → `kind:"symbol"`. These are already the
most reliable signal; keep them.

### Phrase extraction — the missing capability (fixes P1-1)
Plain asks ("implement user authentication", "make the dashboard faster")
currently extract nothing. Add a light noun-phrase grab:
- Drop a stopword list (the, a, and, to, for, please, can you, also, some...).
- After an ACTION_VERB, take the following 1-3 content words as a `phrase`
  target: "implement **user authentication**", "add **rate limiting**".
- Phrases match against diff *content* and file *basenames* with token
  overlap, not substring (see §2).

This is deliberately fuzzy. Phrases are weaker evidence than paths/symbols and
are scored as such (§3).

## 2. Replace `includes()` with typed, token-aware matching

`provenance.js:49` does `haystack.includes(keyword)` — the source of both the
`js`-matches-everything bug and the wrong-file-still-credited bug. Replace
with a per-kind comparator:

```
match(target, event):
  path    -> basename(target) === basename(event.path)         // exact basename
             (NOT substring; dist/app.js !== src/app.js unless basenames equal,
              and you may require dir-suffix match when both have dirs)
  symbol  -> word-boundary regex hit in event.diff added lines or event.command
  phrase  -> >=50% of phrase content-tokens appear (word-boundary) in
             event.diff added lines OR event.path basename
  literal -> exact substring (literals are meant to be verbatim)
```

Key change: **paths compare by basename equality, symbols/phrases compare
against ADDED diff lines** (not the whole diff, which includes removed and
context lines — matching a removed line shouldn't credit an addition).

This single change makes Test C (wrong file) return *no match* → the claim
becomes `phantom`/`not_sent`, and makes `js`-style over-matching impossible
because there's no bare `js` target anymore.

## 3. Confidence, and an honest "can't tell" state (fixes P1-1, P1-3)

The current binary (matched / silently_dropped) is too sharp for fuzzy
targets. Introduce match confidence and a real abstention:

```
strong  : path-basename or symbol or literal hit
weak    : phrase-only hit
none    : no targets matched
no-target: the subtask/claim yielded NO extractable target at all
```

Reconciliation rules:
- subtask with `strong`/`weak` evidence → `addressed`
- subtask with `none` but mentioned in claim text → `acknowledged_incomplete`
- subtask with `none` and not mentioned → `silently_dropped`
- **subtask with `no-target` → `unverifiable_ask`, NOT `silently_dropped`**
  (this is the P1-1 fix: "we couldn't tell what to look for" must never
  masquerade as "the agent dropped it." Default to honesty about the tool's
  own limit, per PRD §3's "be honest about inference limits.")

For `undisclosed` (P1-3): only compute it from **paths that were actually
extractable as path/phrase targets**. If a turn has no usable targets at all,
mark writes `undisclosed_unknown` (a softer, clearly-different bucket) instead
of flooding everything as confirmed scope-creep. The malicious-file case in
Test B then stands out because the asked-for file basename (`dashboard`)
matches a phrase target and the unrelated file does not.

## 4. Substance ratio (P2-1, included because it's one file over)

`matcher.js`: replace `addedSubstance < 1` with a ratio plus a small absolute
floor:
```
ratio = addedSubstance / max(added, 1)
partial if (added <= 3 && addedSubstance === 0)            // tiny pure-stub
      or (added > 3 && ratio < 0.5)                         // mostly scaffolding
```
So `function doThing(){ return null; }` (1 substance line but trivial) still
needs a stub-body check; add a tiny "trivial body" list
(`return null|undefined|None|pass|{}|;`) that demotes a single-substance-line
function to `partial`. Keep it small and visible.

## 5. Where the LLM judge (PRD §4) plugs in — and why here, not M9

The heuristic above will still abstain (`weak`, `no-target`,
`unverifiable_ask`) on genuinely ambiguous claims like "added proper error
handling." That abstention set is *exactly* the deep-verify input:

```
if deepVerify enabled AND claim.confidence ∈ {weak, unverifiable}:
    judge(claim.text, relevant_diffs) -> {verdict, rationale}
    label result source:"llm-judge" (never silently merged with heuristic)
```

The engine's job becomes: decide cleanly when it's sure, **abstain loudly when
it's not**, and hand only the abstentions to the (optional, BYO-key) judge.
That ordering means the heuristic never has to pretend to 90% — it's allowed
to say "unverifiable," which is both more honest and what makes the LLM layer
a real upgrade rather than a patch over false confidence.

## 6. Acceptance tests (all currently FAIL)

```
E1  extractTargets("login.js") => [{kind:path, value:"login.js"}]   // not "js"
E2  extractTargets("implement user authentication")
       => includes {kind:phrase, value:"user authentication"}
E3  match(path "payment.js", write "src/unrelated.js") => no match
       => claim "fixed payment.js" with that write => phantom (not verified)
E4  reconcile(auth+rate-limiting plain-English, both files written, accurate claim)
       => silently_dropped === 0, both subtasks addressed
E5  reconcile(dashboard optimize + secret file)
       => undisclosed === ["secret-thing-nobody-asked-for.ts"] only
E6  1-line stub `return null` claimed as "implemented" => partial
E7  PRD §9 anaphora: "added X to a.js. tested it, it works." + failing `npm test`
       => phantom_verification (already passes; keep as regression)
E8  no-target ask "clean things up", nothing matched, not mentioned
       => unverifiable_ask, NOT silently_dropped
```

## 7. Migration / blast radius

- `task-extractor.js`: rewrite `extractKeywords` → `extractTargets`; keep a thin
  `extractKeywords` shim returning `value`s if anything else imports it.
- `claim-extractor.js`: swap its `extractKeywords` call; the anaphora
  inheritance logic (lines 86-96) carries over, now copying typed targets.
- `provenance.js`: `eventsMentioning` becomes target-aware `match`.
- `matcher.js`: new outcomes `unverifiable_ask`, `undisclosed_unknown`; ratio
  substance check.
- `render/*`: add color/label/severity for the two new outcomes.
- Lock all of §6 into `test/run.js` before touching anything else, so the
  rewrite is measured against fixtures, not vibes — which is, after all, the
  entire thesis of this project.
