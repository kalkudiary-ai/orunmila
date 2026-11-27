# Orunmila record formats, v1

**Status: v1**, published with Orunmila 1.0.0. These are the formats Orunmila's intake writes and that `orunmila
verify`, replay and the judge read. They are written so that a developer who has never seen Orunmila's code can
write or check these records from this folder alone, in any language.

## Reading order

1. This file: what each format is, the versioning rule, the licence.
2. `hash-chain.md`: exactly which bytes each record's `hash` covers, in what order, with which algorithm, how lines
   link into a chain, and how a log continues in parts after a crash.
3. `FIELDS.md`: every field of every format, in plain words, with what values it takes and whether it is required.
4. The `*.schema.json` files: the same formats as JSON Schema (draft-07), so a machine can check a record.

## Versioning

Every record carries `schema_version`; every format here is version 1. Fields may be added in a later version of a format; a field is never renamed, removed or given another meaning without a new `schema_version`. A reader
ignores fields it does not know, so a record written by a later version still reads.

## Licence

The text of this specification and its schema files are licensed under the Apache License 2.0, like the code (`LICENSE` at the repository root). These formats and the verifier stay open in every future version of Orunmila: never paid, gated or closed.

## The files

| File | Format |
|---|---|
| `FIELDS.md` | Every field of every format below, in plain words, made from the schema files (`scripts/spec-fields.js`) |
| `hash-chain.md` | The hash chain: the exact bytes hashed, how lines link, how a log is checked, and a log continued in parts after a crash |
| `session-header.schema.json` | The session header: the raw log's first line, where the hash chain starts |
| `mark.schema.json` | The mark: one raw observation, one line of a session's raw log |
| `continuation.schema.json` | The continuation record: the first line of a log's second or later part, naming where the crash cut the previous part |
| `baseline.schema.json` | One line of `baseline.jsonl`, the snapshot of the project at session start; the header's `baseline.fingerprint` covers the file |
| `odu-header.schema.json` | The odù log's header: its first line, naming the raw log it came from |
| `odu.schema.json` | The odù record: one real event, reconciled from the marks behind it, with both witnesses' accounts |
| `verdict-header.schema.json` | The verdict log's header: its first line, naming the odù log line it judged up to and the judge |
| `verdict.schema.json` | The verdict record: one verdict on one sealed odù, Clean, Look at this or Violation, with the rule and the marks behind it |
| `session-verdict.schema.json` | The session verdict: the verdict log's last record, Incomplete, Clean, Look at this or Violation, with its reasons and the law gate's counts |
| `session-footer.schema.json` | `footer.json`, written at the closeout's end: the last line of the raw, odù and verdict logs by seq and hash |
| `retention-header.schema.json` | The retention log's header: its first line, where its hash chain starts |
| `retention-removal.schema.json` | The removal record: one session removed whole, recorded before its folder is touched |
| `updates-header.schema.json` | The update log's header: the first line of `updates.jsonl` in Orunmila's home |
| `update.schema.json` | One update of Orunmila by itself: from and to, npm's integrity hash, the self-check, whether it switched |
| `claims-block.md` | The claims block: the fenced `orunmila-claims` block an agent may end a turn with (`changed:`, `proved:`, `not done:`) |

## A session folder

One session's records sit together in one folder: `raw.jsonl` (the session header, then marks), `quarantine.jsonl`
(inputs that were not valid marks, kept with their reasons), `files/` (each file a mark refers to by `sha256:` in
`detail.diff_ref` or `detail.output_ref`, named by those 64 hex digits), and, when they were written,
`baseline.jsonl`, `odu.jsonl`, `verdict.jsonl` and `footer.json`. Each `.jsonl` file is a hash-chained log by
`hash-chain.md`; a log a crash cut short continues in `raw.2.jsonl` and so on.

Each field in a schema carries its wording in `description` and its source in `$comment`: a line of the build brief,
or "agent's choice" where the brief names no field.

## Checking a record

The schemas are JSON Schema draft-07. Orunmila checks them with its own small checker, `src/verify/schema.js` (no
dependencies), which refuses any schema keyword it does not implement, so a misspelt keyword cannot check nothing.
Any JSON Schema draft-07 checker can read them too.

From the repository root, or from the installed package (`spec/` ships with it):

```js
const { compile } = require('./src/verify/schema');
const check = compile(require('./spec/mark.schema.json'));
check(mark); // [] when valid, else [{ path, keyword, message }]
```

`orunmila verify <session-folder>` checks a whole folder: every chain, every record against its schema, every odù's
marks, every verdict's odù, every kept file against its fingerprint, and the footer.

A schema cannot hold every rule. These are checked elsewhere: `seq` strictly increasing, the hash chain and the exact
bytes it hashes (`hash-chain.md`), redaction before hashing, and path normalisation.

## Decided points (O, 2026-11-16)

- **`mono_ns` above 2^53.** JSON numbers are IEEE doubles, so integers are exact only up to 2^53. In nanoseconds that
  is about 104 days of uptime. `mono_ns` is written as a decimal string of the integer, compared as a big integer.
- **Writes outside the project.** The absolute real path, with `target.outside: true`.
- **Targets the brief does not shape.** A `renamed` mark carries `detail.from`, the old path. `process` and `claim`
  targets keep only `kind` until a source that writes them needs more.
