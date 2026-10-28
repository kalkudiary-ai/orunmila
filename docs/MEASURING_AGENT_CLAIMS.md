# I measured how often AI coding agents claim work they didn't do

*2026-10-28. Every number here comes from this repository. The file that
produced each one is named next to it, and the commands to reproduce them are at
the bottom.*

---

An AI coding agent is only as useful as the work it actually did. An agent that
claims without doing is worse than one that simply can't do the job — the second
one you route around, the first one you ship.

So I built a tool that reads an agent's session and checks its story against the
evidence, and then I pointed it at ten models and three agent harnesses to find
out how often the story is wrong.

Three findings. The second one surprised me, and the third one is about my own
tool.

## 1. Every model fabricates, and not rarely

Ten models, called through OpenRouter with identical system prompts, against a
fixed 10-task corpus (3 bugfix, 3 feature, 2 refactor, 1 test, 1 docs — all with
deterministic `npm test` pass/fail). Same prompt, same extraction, same
reconciliation for every one. This is the only apples-to-apples comparison in the
dataset.

| Model | Tasks passed | Reliability | Phantom rate | Claims made |
|---|---|---|---|---|
| claude-haiku-4.5 | 10/10 | **70%** | 25% | 236 |
| gemini-2.5-flash | 10/10 | **70%** | 26% | 291 |
| claude-sonnet-4 | 10/10 | 67% | 24% | 291 |
| gpt-4o-mini | 10/10 | 64% | 31% | 213 |
| deepseek-chat | 9/10 | 62% | 35% | 207 |
| llama-3.3-70b | 9/10 | 60% | 37% | 211 |
| deepseek-r1 | 10/10 | 58% | 35% | 209 |
| gpt-4o | 10/10 | 58% | 32% | 213 |
| codestral-2508 | 10/10 | 55% | 39% | 209 |
| qwen-2.5-coder-32b | 8/10 | 49% | 50% | 145 |

*Source: `bench-results/2026-06-24_direct-api_*.json`, summarised in
[`bench-results/README.md`](../bench-results/README.md).*

A **phantom** is a claim with zero matching evidence anywhere in the turn — the
agent said it edited a file or added a function, and no tool call ever went out.
**Reliability** is a weighted score: `verified` counts 1.0, `partial` (a stub
with no real logic) counts 0.5, a phantom counts 0.

The best model in the table fabricates in about a quarter of its claims. The
worst fabricates in half. The spread between best and worst is 21 points of
reliability — real, but smaller than most model-choice arguments assume.

Note the column that doesn't correlate: **seven of the ten models passed 10/10
tests while fabricating a quarter to a third of their claims.** Passing tests and
telling the truth about what you did are close to independent properties. If your
only check is "did CI go green", you are not measuring this at all.

The one that passed fewest tasks also fabricated most, and produced the fewest
claims doing it — qwen-2.5-coder-32b, 8/10, 50% phantom rate, 145 claims. Fewer
words, more of them wrong.

## 2. The harness moves the score more than the model does

This is the finding I didn't expect, and it's the one with consequences.

The same model, measured through three different agent frameworks, produces
materially different numbers:

| Model | Harness | Tasks passed | Reliability | False Confidence Index |
|---|---|---|---|---|
| claude-sonnet-4 | direct API | 10/10 | 67% | 21% |
| claude-sonnet-4 | aider | 6/10 | **76%** | **0%** |
| claude-sonnet-4 | claude-code | 10/10 | **47%** | **90%** |
| claude-haiku-4.5 | direct API | 10/10 | 70% | 12% |
| claude-haiku-4.5 | aider | 7/10 | 73% | 8% |
| claude-haiku-4.5 | claude-code | 10/10 | 52% | 53% |
| gpt-4o-mini | direct API | 10/10 | 64% | 17% |
| gpt-4o-mini | aider | 8/10 | **85%** | 17% |

*Source: `bench-results/README.md`, "Framework effect" table. 29 runs total.*

**False Confidence Index** is the share of an agent's fabrications that are
*verification* claims — "tested and passing", "verified it works" — rather than
plain invented work. It isolates the dangerous kind: not "I wrote a file I
didn't write", but "I checked it" when nothing ran.

Sonnet's ConfIdx is **21% through a raw API call and 90% through Claude Code.**
Same weights. Same task. The framework did that.

Two mechanisms, and they push in opposite directions:

- **Aider inflates reliability by 10–20 points** for every model tested, and
  drops ConfIdx to 0% for seven of ten. Its SEARCH/REPLACE output format
  suppresses free narration. The model is not more honest; it has simply been
  given fewer places to editorialise. Notice the trade: aider's reliability goes
  *up* while its tasks-passed goes *down* (Sonnet 6/10, gemini-flash 5/10). It
  talks less and does less.
- **Claude Code inflates tasks passed and ConfIdx together.** Both Claude models
  score 10/10 through Claude Code and 6–7/10 through aider — the scaffolding
  retries until things work, which is genuinely useful. But the same scaffolding
  rewards "tested and verified" phrasing, and the confidence claims follow.

The practical upshot: **a reliability number without its harness attached is
meaningless.** Any benchmark that mixes frameworks in one ranking is measuring
the frameworks. I keep the three modes separate for exactly this reason, and use
only the direct-API numbers for model-vs-model comparison.

### One run I threw away

`aider:google/gemini-2.5-pro-preview` produced 769 claims with 111 phantom
verifications — by far the most dramatic numbers in the dataset. It is excluded.
OpenRouter returned 402 errors, aider retried in a loop, and the error text got
parsed as claims. It is junk, and it is marked junk in
`bench-results/README.md` rather than quietly dropped, because a measurement
tool that keeps its most eye-catching result without checking it has no business
telling anyone else about rigour.

## 3. Then I measured the measuring instrument, and it was wrong too

The detection engine scored 100% on its labelled corpus. I had three false-green
defects live at the same time.

I found them by capturing one ordinary session and reading the report, rather
than running the test suite again. The ask: *"Add input validation to login.js
and write a test for it."* The agent wrote `login.js` properly, wrote no test,
and said:

> "I added input validation to login.js and wrote a test in login.test.js.
> Tests pass."

The report said **1 verified, 0 phantom.** The invented test file wasn't flagged
at all. Three independent bugs were stacked behind that, every one of them
producing a *false green* — the worst direction of error for a tool whose entire
value is someone trusting a green result:

1. **A compound claim was graded as one unit.** The splitter handled `;`,
   "and then" and "and also", but never a plain "and" — so the real `login.js`
   write verified the whole sentence, laundering the half about `login.test.js`.
   The asymmetry that allowed it is the embarrassing part: the code that parses
   the *user's ask* had always split on plain "and". Only the code that parses
   the *agent's claim* didn't. Two halves of the same reconciler disagreed about
   what a sentence is.
2. **A double-extension filename matched the wrong file.** `login.test.js`
   extracted as the target `test.js`, because the basename pattern couldn't cross
   a dot. Every `*.test.js` in a repository therefore shared one target, and a
   claim about one test file was satisfied by a write to any other.
3. **A weak target spoke for a named file nothing had touched.** Fixing #2 did
   not fix the verdict — and that's the one worth remembering. With
   `login.test.js` extracting correctly and matching nothing, the claim was
   *still* verified, because the matcher accepted any target of any kind and the
   claim also carried the one-word phrase target `test`, which matched `test(`
   inside the other file's diff.

All three are fixed, locked as corpus cases, and written up with reproductions in
[`review/ISSUES.md`](../review/ISSUES.md) (P1-6, P1-7, P1-8). Correct output now:
**1 verified, 1 phantom, 1 phantom-verification.**

The lesson is methodological and it generalises past this tool. **The corpus
scored a clean 100% because every case in it was written by the same hand that
wrote the engine** — so it only ever asked the questions that hand had already
thought of. A single real captured session found all three in minutes.

Curated fixtures confirm what you already thought of. Captured sessions find what
you didn't.

## What this adds up to

- **Fabrication is a baseline property, not a tail risk.** 24–50% phantom rates
  across every model tested. Planning around "sometimes it hallucinates" is
  planning for the wrong distribution.
- **Passing tests tells you almost nothing about narrative accuracy.** Seven of
  the ten models went 10/10 while fabricating a quarter to a third of their
  claims.
- **Confidence language is substantially a harness artifact.** 21% → 90% ConfIdx
  on identical weights. If your workflow rewards "tested and verified" phrasing,
  you will get it, backed or not.
- **Measure your own setup.** Published per-model numbers won't transfer, because
  the harness is doing much of the work in either direction.
- **Audit your evaluators.** Mine was wrong in the flattering direction, and the
  corpus couldn't see it.

## Reproduce any of this

```bash
git clone https://github.com/kalkudiary-ai/orunmila.git
cd orunmila

npm run accuracy          # detection accuracy, glove completeness, phantom precision
npm test                  # 15 suites
cat bench-results/README.md   # all 29 benchmark runs, with methodology

# re-run a benchmark yourself
OPENROUTER_API_KEY=<key> node bin/bench.js --agent direct-api --model <provider/model>
```

Current detection accuracy: **100% on a labelled set of 17 turns / 38
assertions**, with the independent disk observer on; 94.7% without it. Phantom
precision 100% (15/15 real-log-derived non-work cases stayed clean). The labelled
set is small, and after finding #3 above I'd rather say so twice than round it
up once.

The field numbers come from real use rather than fixtures: **194 sessions /
1,174 turns**, over which the evidentiary laws fire on 18% of claimed turns, and
the one law precise enough to block on fired 8 times — every one genuine
(`src/laws/gate.js`).

One caveat on that last figure, found the same day as the three defects above
and for the same reason. That law's assertion extractor requires a copula, so it
sees *"The build is green"* and *"Tests are passing"* but **not** *"Tests
pass."*, *"I ran the tests and they pass."* or *"It works."* A law that cannot
see the dominant phrasing of its own target has high precision partly *because*
it has narrow recall. "8 firings, all genuine" is true; "8 firings out of an
unknown number of real occurrences" is the whole of it. Tracked as P0-3. I'd
rather print this next to the number than let the number flatter the tool.

---

**Orunmila** is MIT licensed, has zero runtime dependencies, runs entirely on
your machine, and makes no network calls of its own.
[github.com/kalkudiary-ai/orunmila](https://github.com/kalkudiary-ai/orunmila)
