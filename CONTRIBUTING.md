# Contributing to orunmila

Thanks for wanting to help. orunmila is small, dependency-free, and deliberately
honest about its limits — contributions that keep it that way are very welcome.

## Ground rules

- **Zero runtime dependencies.** The `dependencies` field in `package.json` stays
  empty. Dev-only tooling (the test runner is hand-rolled, `c8` for coverage,
  `eslint`/`prettier`) is fine; a runtime dependency is almost never the right
  answer here and a PR that adds one needs a strong, specific reason.
- **Node 18+ only, no transpile step.** Plain CommonJS, no build. If it doesn't
  run on a clean `node 18`, it doesn't ship.
- **Local-first and private by default.** The tool makes no network calls of its
  own and needs no account or API key for the default mode. Don't add telemetry,
  "phone-home" version checks, or anything that sends a user's session data off
  their machine.
- **Honest over impressive.** Every heuristic in this codebase is labelled as a
  heuristic where the user can see it (the turn-scoped lineage, the sentinel
  time-window). Keep that contract: surface a failure mode, don't hide it.

## The two quality gates

These are the bars CI enforces (`.github/workflows/ci.yml`). Run them locally
before opening a PR:

```bash
npm test              # all suites, every one in its own process
npm run coverage      # c8 with the thresholds in .c8rc.json (fails under them)
npm run accuracy:gate # detection accuracy must stay >= 95% with the sentinel on
npm run lint          # eslint flat config
```

**A note on "95%".** The accuracy gate measures **detection accuracy** — how
often the reconciler reaches the right verdict on a labelled fixture — *not* test
coverage. Please don't game either number. Padding line coverage with tests that
assert nothing, or tuning the accuracy fixtures to flatter the tool, defeats the
entire point of a tool whose job is to catch exactly that kind of thing. If a
real improvement lowers a metric, say so in the PR and we'll talk about it.

## Adding an agent (the most wanted contribution)

orunmila is agent-agnostic by design. Supporting a new agent (Gemini CLI, Zed,
whatever) is usually a **registry entry, not a code fork**:

1. Add an entry to the `REGISTRY` in `src/capture/agents.js` — its id, where its
   hook config lives, the event names it uses per lifecycle phase, and any tool
   names the defaults don't already cover.
2. `node bin/orunmila.js install --agent <id>` and run a real session.
3. If claim extraction comes back empty, `orunmila debug-transcript <path>` shows
   why; most agents need no transcript module of their own.

See the "Architecture: how agent-agnostic works" section of the README.

## Sharpening the heuristics

The single most valuable code contribution is improving claim/subtask extraction
(`src/reconcile/claim-extractor.js`, `task-extractor.js`) **without** adding paid
API calls. The known-open precision gaps are tracked in `review/ISSUES.md`; the
accuracy fixtures live in `test/cases/`. Add a fixture that reproduces a
mis-detection, then fix it — that's the ideal PR shape.

## Pull request checklist

- [ ] `npm test`, `npm run coverage`, `npm run accuracy:gate`, and `npm run lint`
      all pass locally.
- [ ] New behaviour has a test (and a labelled fixture if it changes a verdict).
- [ ] No new runtime dependency; no network call by the tool itself.
- [ ] Any new heuristic is labelled as one where the user can see it.
- [ ] `CHANGELOG.md` has an `Unreleased` entry describing the change.

## Reporting bugs

Open an issue with the smallest reproduction you can. For a detection bug, the
most useful thing is the offending claim/prompt text and what you expected the
verdict to be — that maps straight onto a fixture in `test/cases/`.

By contributing, you agree your contributions are licensed under the project's
MIT License.
