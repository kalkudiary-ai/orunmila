# The hash chain, v1 (draft)

**Status: draft** (Phase 1 slice A3a). This is the exact rule, so anyone can recompute every hash
without Orunmila's code. It covers the raw log (the session header, then marks) and the retention
log (its header, then removals; LD66). The odù log and the verdict log will use the same rule when
they are built.

## A log is lines

- A log is a UTF-8 text file. Each record is one line, ended by a single line feed (`0x0A`).
  There are no blank lines and no carriage returns.
- **Each line is the record's canonical JSON text**: RFC 8785 (JSON Canonicalization Scheme), of
  the whole record, `hash` included. So a line can be changed in only one way that still parses as the
  same record: not at all. Any other spelling of the same data is itself a broken line.
- The raw log's first line is the session header (`seq` 0). Marks follow, `seq` 1, 2, 3 and so on,
  each one more than the last.

## What is hashed

For each record:

1. Take the record as a JSON object, **without its `hash` member**. Every other member stays,
   including `prev_hash`.
2. Serialise it with RFC 8785. The result is a sequence of UTF-8 bytes.
3. Hash those bytes with SHA-256.
4. Write the result as the text `sha256:` followed by the 64 lowercase hexadecimal digits of the
   digest. That text is the record's `hash`.

## How records are linked

- The first record (the session header) has `"prev_hash": null`.
- Every later record's `prev_hash` is the previous line's `hash`, exactly as written there.

## Checking a log

Read the lines in order. For line *n* (counting from 1):

1. It must parse as a JSON object, and its text must equal the RFC 8785 serialisation of that object.
   Otherwise: **line *n* is not canonical** (it was edited, or written by something else).
2. Its `hash` must equal the hash computed by the rule above. Otherwise: **line *n* was changed after
   it was written.**
3. Its `prev_hash` must be `null` for line 1, and the previous line's `hash` for every other line.
   Otherwise: **line *n* does not follow line *n − 1*** (a line was deleted, inserted or moved just
   before it).
4. Its `seq` must be 0 for line 1, and one more than the previous line's `seq` after that.
   Otherwise: **line *n* is out of sequence**.

The first line that fails is the one reported. Every line after it is unproven.

## A log in parts

A crash can cut a log's last line short. That log is never edited (agent's choice LD57, approved
by O 2026-11-17). The restart starts a new part beside it, and the chain goes on there.

- Part 1 is the log's own file (`raw.jsonl`, `quarantine.jsonl`). Part 2 is `raw.2.jsonl` (or
  `quarantine.2.jsonl`), then `.3`, and so on.
- A part may be followed by another only if its last line is **cut**: the file does not end with
  a line feed. Every line before the cut checks by the rules above. A part whose last line is whole
  ends the log; another part after it is a broken record.
- The next part's first line is a **continuation record** (`continuation.schema.json`). Its
  `prev_hash` is the hash of the last whole line before the cut, and its `seq` is one more than
  that line's. It names its `part` and its `log`. Its `cut` gives the cut line's number in the
  previous part, its length in bytes, and `sha256:` with the SHA-256 of those bytes.
- Every later line follows the rules above, so one chain runs through all the parts.

Checking a log in parts: check part 1 as above. While another part exists, the part just
checked must be cut, and the next part's first line must name that cut exactly (line number,
length, fingerprint) and follow the last whole line before it. Then check that part the same way.
A cut last line in the last part is not continued: the log is broken there.

The cut line's content is lost. A continuation shows where the crash cut the log, never what the
cut line said. The restart's gap mark covers the marks lost while intake was down.

## What the chain cannot show

- **Lines removed from the end.** A log cut short still checks as an unbroken chain. The session
  footer, which records the final hash of each log, is what shows this (brief, closeout step 8; built
  later).
- **A whole log rewritten from the start.** Anyone can compute a new valid chain. The chain makes
  tampering visible against a hash recorded elsewhere (the footer, and later off-machine
  registration); it is not a signature.

Members appear in RFC 8785 order, so `hash` sits wherever its name sorts, not last. Find it by name,
never by position.
