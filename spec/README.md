# Orunmila record formats, v1 (draft)

**Status: draft.** Nothing writes or reads these formats yet. They are the contract Orunmila's parts
will share (the build brief, "The contract: the record formats"). Until v1 ships, any field can
still change. After that, fields may be added but never renamed or removed without a version bump.

| File | Format |
|---|---|
| `mark.schema.json` | The mark: one raw observation, one line of a session's raw log |
| `session-header.schema.json` | The session header: the raw log's first line, where the hash chain starts |
| `hash-chain.md` | The hash chain: the exact bytes hashed, how lines link, how a log is checked (`src/verify/chain.js`) |

The odù record and the verdict record come later (Phases 2 and 6), after the contract amendment
for the Glove's marks (open question 5) is approved.

Each field in a schema carries the brief's own wording in `description` and its source in
`$comment`. That source is a line of the build brief, or "agent's choice" where the brief names
no field.

## Checking a record

The schemas are JSON Schema draft-07. Orunmila checks them with its own small checker,
`src/verify/schema.js` (no dependencies). It refuses any schema keyword it does not implement,
so a misspelt keyword cannot check nothing.

From the repository root (`spec/` is not in the npm package yet):

```js
const { compile } = require('./src/verify/schema');
const check = compile(require('./spec/mark.schema.json'));
check(mark); // [] when valid, else [{ path, keyword, message }]
```

Unknown fields are allowed, because v1 may add fields. A reader ignores what it does not know.

A schema cannot hold every rule. These are checked elsewhere: `seq` strictly increasing, the hash
chain and the exact bytes it hashes, redaction before hashing, and path normalisation.

## Open points, decided by O on 2026-11-16 (brief v4)

- **P1. `mono_ns` above 2^53.** JSON numbers are IEEE doubles, so integers are exact only up to
  2^53. In nanoseconds that is about 104 days of uptime. **Decided:** `mono_ns` is written as a
  decimal string of the integer (brief v4 line 238), compared as a big integer
  (`src/opon/intake/mono.js`).
- **P2. Writes outside the project.** **Decided:** the absolute real path, with
  `target.outside: true` (brief v4 line 345; slice A7's proposal).
- **P3. Targets the brief does not shape.** **Decided:** a `renamed` mark carries `detail.from`,
  the old path (brief v4 line 265). `process` and `claim` targets keep only `kind` until the first
  source that writes them (Track B) needs more.
