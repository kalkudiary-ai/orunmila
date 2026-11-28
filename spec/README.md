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
| `quarantine-header.schema.json` | The quarantine log's header: the first line of `quarantine.jsonl`, there in every session folder |
| `quarantine.schema.json` | One quarantined input: something that reached intake and was not a valid mark, kept whole with its reasons |
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

One session's records sit together in one folder, named by the session's id:

- `raw.jsonl`: the session header, then marks. Always there.
- `quarantine.jsonl`: its header, then each input that was not a valid mark, with its reasons. Always there, even
  when it holds only its header.
- `files/`: each file a mark keeps beside the log (`detail.diff_ref`, `detail.output_ref`), named by the 64 hex
  digits of its SHA-256, with no prefix and no extension. A `diff_ref` file is the change as a unified diff (a `---`
  line, a `+++` line, then `@@` hunks); an `output_ref` file is a command's whole output.
- When they were written: `baseline.jsonl`, `odu.jsonl`, `verdict.jsonl` and `footer.json`.

`raw.jsonl`, `quarantine.jsonl`, `odu.jsonl` and `verdict.jsonl` are hash-chained logs by `hash-chain.md`; the raw and
quarantine logs continue in `raw.2.jsonl`, `quarantine.2.jsonl` and so on after a crash. `baseline.jsonl` is not a
chain: it is one RFC 8785 line per entry, each line ended by a line feed (the last one too), sorted by `path` in
UTF-16 code-unit order, and the header's `baseline.fingerprint` is the plain SHA-256 of the file's bytes.

## Values a record holds but cannot explain alone

- **Fingerprints and references** are written `sha256:` followed by the 64 lowercase hex digits of the SHA-256 of the
  bytes. A file on the redaction list (such as `.env`) is fingerprinted `hmac-sha256:` with a secret key kept in
  Orunmila's own home, so two such fingerprints can be compared but a reader cannot recompute one, and the file's
  contents cannot be recovered from it.
- **`orunmila.code_fingerprint`** in the session header covers Orunmila's own code: for every regular file under its
  code folder (the `src` folder of the Orunmila copy that wrote the header), the line `<path relative to that folder,
  with />` + NUL + `<lowercase hex SHA-256 of the file>` + line feed; the lines sorted in UTF-16 code-unit order;
  `sha256:` and the SHA-256 of their joined bytes.
- **`mono_ns`** is the machine's monotonic clock in nanoseconds, so it compares only within one boot. It is not
  required to rise with `seq`: `seq` is the order intake received marks, `mono_ns` the time each was observed, and a
  slower source's mark can arrive after a later one.
- **A list in an odù or a verdict whose order its schema does not state** holds its items in no order this spec
  defines.
- **Redaction** runs before anything is hashed or written. A reader sees that text was redacted (`[REDACTED:<kind>]`
  in place of the secret, and the kinds in `detail.redactions` or a quarantined record's `redactions`), never what was
  removed. Which kinds Orunmila looks for is its own choice (`src/store/secrets.js`), not part of the format.

Each field in a schema carries its wording in `description` and its source in `$comment`: a line of the build brief,
or "agent's choice" where the brief names no field.

## Checking a record

The schemas are JSON Schema draft-07 and use only these keywords: `type`, `enum`, `const`, `required`, `properties`,
`additionalProperties`, `items`, `minimum`, `minLength`, `maxLength`, `pattern`, `minItems`, `allOf`, `anyOf`, `oneOf`,
`not`, `if`, `then`, `else`, `$ref` and `definitions` (and `description`, `$comment`, `title`, `$id` and `$schema`,
which check nothing); Orunmila's checker implements `oneOf`, but no schema here uses it. Any JSON Schema draft-07 checker
can read them. Orunmila checks them with its own small checker,
`src/verify/schema.js` (no dependencies), which refuses any keyword not on that list, so a misspelt keyword cannot
check nothing.

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
