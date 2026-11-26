# Orunmila record formats, v1 (draft)

**Status: draft.** These are the formats Orunmila's intake writes and `orunmila verify`, replay
and the judge read (the build brief, "The contract: the record formats"). Until v1 ships, any field
can still change. After that, fields may be added but never renamed or removed without a version bump.

| File | Format |
|---|---|
| `mark.schema.json` | The mark: one raw observation, one line of a session's raw log |
| `session-header.schema.json` | The session header: the raw log's first line, where the hash chain starts |
| `hash-chain.md` | The hash chain: the exact bytes hashed, how lines link, how a log is checked (`src/verify/chain.js`), and a log continued in parts after a crash |
| `continuation.schema.json` | The continuation record: the first line of a log's second or later part, naming where the crash cut the previous part |
| `retention-header.schema.json` | The retention log's header: its first line, where its hash chain starts |
| `retention-removal.schema.json` | The removal record: one session removed whole, recorded before its folder is touched |
| `odu.schema.json` | The odù record: one real event, reconciled from the marks behind it (Phase 3; the fields stations 4-6 fill are optional until they are built) |
| `odu-header.schema.json` | The odù log's header: its first line, naming the raw log it came from |
| `baseline.schema.json` | One line of `baseline.jsonl`, the baseline snapshot at session start; the header's `baseline.fingerprint` covers the file (Phase 3) |
| `session-footer.schema.json` | `footer.json`, written at the closeout's end: the last line of the raw and odù logs by seq and hash, `orunmila verify` checking each (Phase 4, provisional) |
| `verdict-header.schema.json` | The verdict log's header: its first line, naming the odù log line it judged up to and the judge (Phase 6) |
| `verdict.schema.json` | The verdict record: one verdict on one sealed odù, Clean, Look at this or Violation, with the rule and the marks behind it (Phase 6) |
| `session-verdict.schema.json` | The session verdict: the verdict log's last record, Incomplete, Clean, Look at this or Violation, with its reasons and the law gate's counts (Phase 6) |
| `updates-header.schema.json` | The update log's header: the first line of `updates.jsonl` in Orunmila's home (PM2a) |
| `update.schema.json` | One update of Orunmila by itself: from and to, npm's integrity hash, the self-check, whether it switched (PM2a, PM2c) |
| `claims-block.md` | The claims block: the fenced `orunmila-claims` block an agent may end a turn with (`changed:`, `proved:`, `not done:`), read by `src/reconcile/claims-block.js` (MR1, brief v4 line 443) |

The odù record follows the G2b amendment (open question 5, approved 2026-11-16).

Each field in a schema carries the brief's own wording in `description` and its source in
`$comment`. That source is a line of the build brief, or "agent's choice" where the brief names
no field.

## Checking a record

The schemas are JSON Schema draft-07. Orunmila checks them with its own small checker,
`src/verify/schema.js` (no dependencies). It refuses any schema keyword it does not implement,
so a misspelt keyword cannot check nothing.

From the repository root, or from the installed package (`spec/` ships with it):

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
