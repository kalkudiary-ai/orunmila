<!-- Thanks for contributing to orunmila. Keep it small, dependency-free, and
     honest about its limits. -->

## What this changes

<!-- A short description of the change and why. Focus on the "why". -->

## How it was tested

<!-- New behaviour should have a test, and a labelled fixture if it changes a
     verdict. Note which fixtures in test/cases/ you added or touched. -->

## The gates (run locally before opening)

- [ ] `npm test` — all suites pass.
- [ ] `npm run coverage` — c8 thresholds in `.c8rc.json` pass.
- [ ] `npm run accuracy:gate` — detection accuracy stays `>= 95%`.
- [ ] `npm run lint` — eslint flat config passes.

> The accuracy gate measures **detection accuracy**, not test coverage.
> Please don't pad coverage with assertion-free tests, or tune the accuracy
> fixtures to flatter the tool. If a real improvement lowers a metric, say so
> here and we'll talk about it.

## Checklist

- [ ] New behaviour has a test (and a labelled fixture if it changes a verdict).
- [ ] No new runtime dependency; no network call by the tool itself.
- [ ] Any new heuristic is labelled as one where the user can see it.
- [ ] `CHANGELOG.md` has an `Unreleased` entry describing the change.
