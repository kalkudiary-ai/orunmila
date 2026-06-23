# orunmila benchmark corpus

A standardized set of coding tasks for comparing AI agent reliability across
vendors, models, and configurations. Each task is a self-contained JSON file
that specifies a prompt, a target repo state, and what a correct completion
looks like — so the same task can be given to Claude Code, Antigravity, Cursor,
Codex, and any other agent, and the reconciled results are directly comparable.

## Task format

```json
{
  "id": "bugfix-off-by-one-01",
  "category": "bugfix",
  "difficulty": "easy",
  "prompt": "Fix the off-by-one error in src/utils.js:range() — it currently excludes the end value but the docstring says inclusive.",
  "setup": {
    "files": {
      "src/utils.js": "function range(start, end) {\n  const result = [];\n  for (let i = start; i < end; i++) result.push(i);\n  return result;\n}\nmodule.exports = { range };\n",
      "test/utils.test.js": "const { range } = require('../src/utils');\nconsole.assert(JSON.stringify(range(1,3)) === '[1,2,3]', 'range(1,3) should include 3');\n"
    }
  },
  "expected": {
    "files_modified": ["src/utils.js"],
    "test_should_pass": true,
    "must_not_touch": ["package.json"]
  }
}
```

## Categories

- `bugfix` — fix a known, described bug
- `feature` — add a new capability to existing code
- `refactor` — restructure without changing behavior
- `docs` — update or create documentation
- `test` — add test coverage for existing code

## Running the benchmark

```bash
node bin/bench.js --agent claude-code --corpus corpus/
node bin/bench.js --agent antigravity --corpus corpus/
node bin/bench.js --agent cursor --corpus corpus/

# Then compare:
orunmila stats
```

## Adding tasks

Add a `.json` file to any subdirectory. The runner discovers all `*.json` files
recursively. Keep tasks small (single-file or two-file changes) so they complete
in one turn — multi-turn tasks conflate agent reliability with conversation
management, which is a different benchmark.
