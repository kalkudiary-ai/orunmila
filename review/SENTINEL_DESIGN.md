# Design: Filesystem Sentinel (P0-1)

This is the "skin that feels the breeze" — the watcher that sees writes the
agent never announced. It is what makes "catches ALL writes" true instead of
claimed. Implements PRD §6.4. Zero npm dependencies (uses only `fs`, `path`,
`crypto`).

## 1. Why a custom walker, not `fs.watch(recursive:true)`

Node's recursive watch is reliable only on macOS/Windows; on Linux it is
flagged/experimental and historically inconsistent. The PRD explicitly says
not to depend on it. So: walk the tree once, attach a non-recursive watcher
per directory, and add a watcher whenever a new subdirectory appears. More
code, but portable and predictable — which a trust tool must be.

## 2. Module layout

```
src/capture/fs-sentinel/
  index.js        # process entry: stainmap watch-fs
  walker.js       # recursive dir discovery + per-dir watcher attach
  hasher.js       # content hash + last-known-content store
  ignore.js       # the visible, user-overridable ignore list (§6.4 requirement)
```

`bin/stainmap.js` gains `watch-fs` (standalone) and folds the same start into
`watch` so one command runs both report-tailing and the sentinel.

## 3. Event shape (reuses the existing log — this is the whole point)

The sentinel writes the **same** `file_write` event as the hook layer, with
one discriminator already reserved in the spec but absent in code:

```js
{
  ts, session_id, turn_id,           // see §6 for how a watcher learns these
  agent: "fs-sentinel",
  source: "fs-sentinel",             // NEW FIELD — add to eventlog TYPES doc
  type: "file_write",
  path, diff,                        // same unifiedDiff() the hook uses
  hash_before, hash_after,
}
```

Add `source` to the documented event shape in `eventlog.js` (hooks should
start stamping `source:"hook"` so the cross-check in §5 is symmetric).

## 4. Change detection (avoid touch-without-modify noise — §6.4)

On each raw fs event for a path:
1. Debounce: coalesce events for the same path within ~150ms (editors/build
   tools fire several raw events per logical save).
2. Read current bytes, `sha256` them.
3. Compare to last-known hash for that path (kept in an in-memory `Map`,
   seeded during the initial walk so pre-existing files have a baseline).
4. If hash unchanged → drop (it was a touch, not a write).
5. If changed → `unifiedDiff(lastContent, current, path)`, append the event,
   update last-known hash+content.

Memory note: storing full last-content for every file is fine at hobby scale
but unbounded on a huge tree. Cap by size (skip > N MB, store hash only) and
diff-from-empty when no prior content is held — documented, not silent.

## 5. The reconciliation cross-check (where `untracked_write` is born)

This is the new reconciler rule (add to `matcher.js`), and it is the inverse
of the tool's normal direction — here the **hook stream is the "claim"** and
the **sentinel is the "reality"**:

```
for each path P with a sentinel-sourced file_write in turn window W:
  if NO hook-sourced event (file_write/file_read/command_run) touches P in W:
     => outcome "untracked_write" for P
```

`untracked_write` ranks ABOVE `phantom_verification` in `html.js SEVERITY_RANK`
and prints in its own block at the TOP of the terminal report (PRD §6.4: "not
buried with ordinary undisclosed changes"). Reuse the existing
`eventsMentioning`-style path compare, but on **basename equality** (see
EXTRACTOR_DESIGN) so `dist/app.js` vs `src/app.js` don't collide.

### Time-window correlation, honestly

The sentinel runs as its own process and does not see Claude Code's
`session_id`/`turn_id`. Two viable correlations, pick per honesty:

- **By time window (recommended v1):** sentinel stamps `turn_id:null`. At
  reconcile time, bucket sentinel writes into the turn whose
  `[first_event_ts, turn_end_ts]` interval contains the sentinel `ts`. Simple,
  good enough, and the failure mode (a write landing in an adjacent turn) is
  visible, not silent.
- **By shared marker (later):** `watch` writes its active session_id to a
  well-known file the sentinel reads. More precise, more coupling. Defer.

Document which is in use — the entire feature's selling point is "no hidden
blind spots," so the correlation heuristic must be the *most* visible config,
not the least.

## 6. The ignore list — the most transparent part of the config (§6.4)

`ignore.js` exports a default list AND loads user overrides from
`.stainmap/ignore` (or a `sentinel.ignore` key in a project config). PRD is
emphatic: this one deliberate blind spot must be **visible and
user-overridable**, never silently hardcoded.

Defaults: `.git/`, `node_modules/`, `.stainmap/` (don't watch yourself —
critical, or you loop on your own event log), and common build dirs
(`dist/`, `build/`, `.next/`, `coverage/`, `target/`). BUT: build output is
exactly where an "I built it" claim should be checkable, so make build-dir
ignoring a separate, clearly-labeled toggle (`ignoreBuildOutput: true`) the
user can flip off, rather than lumping it with `.git`.

`stainmap status` should print the effective ignore list so it's never a
mystery what the skin can't feel.

## 7. Failure & lifecycle

- Watcher attach errors (permissions, too many open files / `ENOSPC` inotify
  limit on Linux) must be logged to stderr loudly, not swallowed — a silently
  dead watcher is the worst outcome for a tool whose promise is completeness.
- On `ENOSPC`, print the actual remediation (raise
  `fs.inotify.max_user_watches`) rather than dying quietly.
- Clean shutdown on SIGINT; flush nothing (log is append-per-event already).

## 8. Acceptance tests

```
T1  echo "x" > tracked.txt via Bash (no Write tool)
    => sentinel logs file_write source:"fs-sentinel"
    => reconcile emits untracked_write, shown at top of report.

T2  touch existing-file (mtime change, content identical)
    => NO event (hash unchanged).

T3  Write tool edits app.js AND sentinel sees the same change
    => exactly one reconciled write for app.js, NOT an untracked_write
       (hook event covers it in-window).

T4  new subdir created at runtime, then a file written inside it
    => sentinel attached a watcher to the new dir and captured the write.

T5  a write inside node_modules/ (default-ignored)
    => no event; and `stainmap status` lists node_modules as ignored.
```

## 9. What this does NOT solve (state it plainly)

- A write that happens, is read back, and is reverted **between** two hash
  samples within the debounce window can be missed (TOCTOU). Rare; note it.
- The sentinel sees *that* bytes changed, never *who/why*. It cannot attribute
  a write to the agent vs. the user typing in their editor vs. a file-watcher
  rebuild. The honest framing: it widens coverage, it doesn't assign intent —
  consistent with the tool's "evidence, never verdict on intent" principle.
- Binary files: diff is meaningless; log hash-only with `binary:true`.
