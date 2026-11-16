# Orunmila record formats, v1 (draft)

**Status: draft.** Nothing writes or reads these formats yet. They are the contract Orunmila's parts
will share (the build brief, "The contract: the record formats"). Until v1 ships, any field can
still change. After that, fields may be added but never renamed or removed without a version bump.

| File | Format |
|---|---|
| `mark.schema.json` | The mark: one raw observation, one line of a session's raw log |
| `session-header.schema.json` | The session header: the raw log's first line, where the hash chain starts |

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

## Open points (for O)

- **P1. `mono_ns` above 2^53.** JSON numbers are IEEE doubles, so integers are exact only up to
  2^53. In nanoseconds that is about 104 days. A monotonic clock that counts from boot can pass it
  on a machine that has run longer than that, and canonical serialisation (RFC 8785) would then hash
  a rounded value. Possible fixes: a decimal string, or microseconds. This changes the brief's
  format, so it is O's decision.
- **P2. Writes outside the project.** The brief makes `target.path` repo-relative (path
  normalisation), but the Glove also sees writes outside the project, such as a scratch folder. The
  schema does not yet say how those are spelt; slice A7 proposes it.
- **P3. Targets the brief does not shape.** `process` and `claim` targets have only `kind` so far.
  A `renamed` mark has no slot for the old path.
