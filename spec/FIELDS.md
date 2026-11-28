# Orunmila record formats v1: every field

Every field of every record format in this folder, in plain words. This file is made from the JSON Schema files
beside it by `scripts/spec-fields.js`; the schemas are the source, and a test keeps this file equal to them. Read
`README.md` first, then `hash-chain.md` for the exact bytes each record's `hash` covers.

Each table row is one field: its path from the record's root (`target.kind` is the `kind` inside `target`; `[]` is
one item of a list), what values it takes, whether every record must carry it, what it means, and where the rule
comes from (a line of the build brief, or "agent's choice" where the brief names no field). A **shape** is a part
several fields share, written once under "Shared shapes". **Rules between fields** say what one field requires of
another (for example, which marks must name a turn).

Licensed under the Apache License 2.0, like the code. These formats stay open in every future version of Orunmila.

## Orunmila baseline snapshot entry (`baseline.schema.json`)

One line of `baseline.jsonl`, the baseline snapshot taken at session start: one entry seen under the project root. The file is one canonical JSON line (RFC 8785) per entry, sorted by path, and its plain SHA-256 is the session header's `baseline.fingerprint`.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `path` | string | yes | The entry's path relative to the project root, with `/`, lower-cased on a case-insensitive file system and redacted, as a mark's `target.path` is, so the two name one file the same way. | brief v4 lines 248, 345; agent's choice, LD169, LD170 |
| `size` | integer | no | A regular file's size in bytes. | agent's choice, LD169 |
| `fingerprint` | string | no | A regular file's fingerprint, hashed by streaming: plain SHA-256, or keyed HMAC-SHA-256 for a file on the redaction list. | brief v4 lines 250, 390 |
| `kind` | one of `"link"`, `"other"`, `"unreadable"` | no | Present for an entry that is not a regular file read whole: `link` for a symbolic link (never followed), `other` for anything else that is not a folder, `unreadable` for a file or folder the walk could not read (its `error` says why). Nothing seen is left out. | agent's choice, LD169; `unreadable` LD172 |
| `error` | string | no | On an `unreadable` entry: the operating system's error code (for example `EACCES`, or `ENOENT` for a file gone mid-walk). | agent's choice, LD172 |
| `redactions` | list of string | no | The kinds of secret redacted from `path`, when any was. | brief v4 line 248; agent's choice, LD170 |

## Orunmila log continuation record (`continuation.schema.json`)

The first line of a log's second (or later) part. A crash can cut a log's last line short; that log is never edited. The restart starts a new part beside it, and this record, the new part's first line, says where the previous part was cut. One hash chain runs through all the parts (spec/hash-chain.md, "A log in parts").

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v3 line 209 |
| `record` | `"continuation"` | yes | Always `continuation`. | agent's choice, LD57 |
| `session_id` | string | yes | The session whose log this part continues. | agent's choice, LD57 |
| `log` | one of `"raw"`, `"quarantine"` | yes | Which of the session's logs this part continues: `raw` (the marks) or `quarantine` (inputs that were not valid marks). | agent's choice, LD57 |
| `part` | integer | yes | This part's number: 2 for the file `raw.2.jsonl` or `quarantine.2.jsonl`, and so on. Part 1 is the log's own file. | agent's choice, LD57 |
| `seq` | integer | yes | One more than the `seq` of the last whole line before the cut. The lines after it count on from here. | agent's choice, LD57 |
| `cut` | object | yes | Where the previous part was cut, and what was left there. | agent's choice, LD57 |
| `cut.line` | integer | yes | The cut line's number in the previous part, counting from 1. | agent's choice, LD57 |
| `cut.bytes` | integer | yes | How many bytes of the cut line were written before the crash. | agent's choice, LD57 |
| `cut.fingerprint` | string | yes | The plain SHA-256 of those bytes, so the cut line left in the previous part can be checked and never changed. | agent's choice, LD57 |
| `prev_hash` | string | yes | The `hash` of the last whole line before the cut, exactly as written there. | agent's choice, LD57; the chain rule is brief v3 line 247 |
| `hash` | string | yes | This record's hash, by the same rule as every line (spec/hash-chain.md). | brief v3 line 247 |

## Orunmila mark (raw observation) (`mark.schema.json`)

Every source's output is turned into marks of this one shape by its adapter, and intake appends them to the session's raw log (JSON Lines, one mark per line, never edited). Sources never write to the log themselves.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. Once v1 ships, fields may be added but never renamed or removed without a version bump. | brief v3 line 209 |
| `session_id` | string | yes | The session the mark belongs to. A sub-agent's work belongs to its session. | brief v3 lines 218, 256 (the example's field; its format is not set by the brief) |
| `seq` | integer | yes | One counter per session, assigned by the Opon's intake, strictly increasing. This is the true order of arrival. | brief v3 line 237. Marks start at 1; 0 is the session header (agent's choice, LD10). |
| `source` | one of `"agent_claim"`, `"hook"`, `"sentinel"`, `"git"`, `"process"`, `"law_gate"` | yes | One of `agent_claim`, `hook`, `sentinel`, `git`, `process`, `law_gate`. New sources are added to this list by contract change. | brief v3 line 243 |
| `agent` | string or null | yes | The agent whose session this is, for example `claude-code`; null when the source cannot know it. | brief v3 line 221 (the example's field; null allowed is the agent's choice, LD11) |
| `turn` | any | yes | Every Glove mark, and every law-gate mark, names the agent's turn. Sources that know nothing of turns (sentinel, git, process) write `null`. The session's end belongs to no turn, so its mark writes `null` too. | brief v3 line 255; the session end's null is the agent's choice, LD55 (format change approved by O 2026-11-17). Its type is set by the turn rules, allOf/0 to /2, which cover every source (LD87). |
| `sub_agent` | object or null | yes | `{ "id": ..., "type": ... }` when the action happened inside a sub-agent, otherwise `null`. | brief v3 line 256 |
| `sub_agent.id` | string | yes | The sub-agent's id. | brief v3 line 256 |
| `sub_agent.type` | string | yes | The sub-agent's type. | brief v3 line 256 |
| `observed_at` | string | yes | `observed_at` is wall-clock time for humans only. | brief v3 line 238. UTC ISO 8601 with a Z, as the example (line 224); the exact pattern is the agent's choice, LD12. |
| `mono_ns` | string | yes | The system-wide monotonic clock (never goes backwards), stamped as close to the moment of observation as the source allows; if a source cannot stamp it, intake stamps arrival time and records that in `detail.stamped_by`. Use it for all timing maths. | brief v3 line 238; brief v4 line 238: written as a decimal string of the integer, because a JSON number is exact only up to 2^53 (about 104 days of nanoseconds since boot); compared as a big integer (open point P1, decided 2026-11-16). |
| `target` | shape `target` | yes | What the mark is about. `target.kind`: `file`, `dir`, `command`, `process`, `claim`, `turn`, `tool`, `network`, or `session`. | brief v3 lines 244, 259; `session` is the agent's choice, LD55 |
| `says` | one of `"created"`, `"modified"`, `"deleted"`, `"renamed"`, `"started"`, `"exited"`, `"ended"`, `"prompted"`, `"read"`, `"contacted"`, `"called"`, `"claimed"`, `"checked"`, `"fingerprinted"`, `"gap"`, `"tampered"`, `"overlapped"`, `"tick"` | yes | A fixed verb list: created, modified, deleted, renamed, started, exited, ended (a turn finished, a tool call failed, or the session ended), prompted (a user prompt arrived), read, contacted, called, claimed, checked (the law gate checked a turn), fingerprinted (the Opon recorded a file's fingerprint), gap (a source lost or dropped events), tampered (source process: Orunmila's own logs, frozen configuration, code or the agent's hook settings changed during the session, or a payload arrived from a process other than the one pinned to the session), overlapped (source process: the intake names in this session's log another session sharing its folder, when it first sees it and when that one ends). Also tick (heartbeat). | brief v3 line 245; brief v4 line 245 adds tampered (decision I-1, 2026-11-16); ended for the session is the agent's choice, LD55; overlapped is the agent's proposal, Q11 (2) (a), adopted LD184, LD202 |
| `detail` | shape `detail` | yes | Named detail slots (the spec gives each a schema). | brief v3 line 260 |
| `cause_hint` | string or null | yes | Filled by sources that know their cause, for example a hook mark carries the tool call id. Sentinel marks usually leave it null. | brief v3 line 246 |
| `prev_hash` | shape `hash` | yes | Each mark's hash covers its own content plus the previous mark's hash. The first mark's previous hash is the session header's. | brief v3 lines 247, 282 |
| `hash` | shape `hash` | yes | Content is serialised in one canonical form before hashing (RFC 8785 JSON Canonicalization, or an equally exact rule written into the spec), so anyone can recompute the same hash. | brief v3 line 247. The exact bytes hashed are slice A3a. |
| `target.kind` | `"claim"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"turn"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"command"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | one of `"file"`, `"dir"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"dir"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"network"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"tool"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"file"` | no | Restated by a rule below; described in its own row. |  |
| `target.kind` | `"process"` | no | Restated by a rule below; described in its own row. |  |
| `detail.from` | any | in this rule | Restated by a rule below; described in its own row. |  |
| `detail.to` | any | no | Restated by a rule below; described in its own row. |  |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `hash` | string |  | A chain hash: sha256 and 64 lowercase hex digits. | brief v3 line 247; the prefix is the example's (lines 230-231) |
| `fingerprint` | string or null |  | A file or output fingerprint: plain SHA-256, or keyed HMAC-SHA-256 for files on the redaction list. null when unknown. | brief v3 lines 228, 249. The hmac-sha256 prefix is the agent's choice, LD14. |
| `count` | integer or null |  | A line count; null unless both states are known. | brief v3 line 264 |
| `line_number` | integer or null |  | A line number or a number of lines, as the agent asked or the tool's result stated; null when not given. | agent's choice, LD94 |
| `instant` | object |  | On a gap for intake's downtime: one end of the window. since is when intake last wrote before it stopped (the latest record among the sessions it was serving); until is when it ran again. | agent's choice, B1c-2 (test 84); wording approved by O 2026-11-17 |
| `instant.mono_ns` | string | yes | The monotonic clock at that moment, as a decimal string. | brief v4 line 238 |
| `instant.observed_at` | string | yes | Wall-clock time at that moment, for humans, and the only clock that compares across a reboot. | brief v4 line 238 |
| `glove_tool_mark` | object |  |  | A Glove (source hook) mark about one tool call: started, an outcome verb, or ended on something other than a turn (brief v3 line 258). It names no required keys: the root requires source, says and target (LD81, LD87). |
| `glove_tool_mark.source` | `"hook"` | no |  |  |
| `glove_tool_mark.says` | one of `"started"`, `"created"`, `"modified"`, `"deleted"`, `"renamed"`, `"exited"`, `"read"`, `"contacted"`, `"called"` | no |  |  |
| `glove_tool_mark.says` | `"ended"` | no |  |  |
| `glove_tool_mark.target` | object | no |  |  |
| `glove_tool_mark.target.kind` | any | no |  |  |
| `session_target` | set by the rules below |  |  | A mark about the session itself: target { kind: session } (LD55). |
| `session_target.target` | object | no |  |  |
| `session_target.target.kind` | `"session"` | yes |  |  |
| `target` | object or null |  |  |  |
| `target.kind` | one of `"file"`, `"dir"`, `"command"`, `"process"`, `"claim"`, `"turn"`, `"tool"`, `"network"`, `"session"` | yes | `file`, `dir`, `command`, `process`, `claim`, `turn`, `tool`, `network`, or `session` (the session itself, for its end). | brief v3 line 244; `session` is the agent's choice, LD55 |
| `target.path` | string | no | The file or folder. Normalise paths: convert to repo-relative, resolve symlinks, and normalise case on case-insensitive filesystems. | brief v3 lines 226, 339; brief v4 line 345: a path outside the project root is absolute, with outside: true. Normalisation is slice A7. |
| `target.outside` | boolean | no | A path outside the project root keeps its absolute real path, with `target.outside: true`. | brief v4 line 345 (open point P2, decided 2026-11-16) |
| `target.text` | string | no | A command targets `{ "kind": "command", "text": ... }`. | brief v3 line 259 |
| `target.id` | string | no | A turn, target `{ "kind": "turn", "id": ... }`. The session itself, `{ "kind": "session", "id": ... }`, with its session id. | brief v3 line 257; the session target is the agent's choice, LD55 |
| `target.name` | string | no | Any other tool targets `{ "kind": "tool", "name": ... }`. A process target may name the process: `intake` for Orunmila's own intake. | brief v3 line 259; the process name is the agent's choice, LD56 |
| `target.host` | string or null | no | A network contact targets `{ "kind": "network", "host": ..., "url": ... }`; for a web search `host` is `null`, because the agent's tool picks the hosts and Orunmila does not see them. | brief v3 line 259 |
| `target.url` | string | no | The address contacted. | brief v3 line 259 |
| `target.query` | string | no | For a web search, the query goes in `query`. | brief v3 line 259 |
| `detail` | object |  |  |  |
| `detail.tool` | string or null | no | The tool's name, on both marks of a tool call; null when the source did not record it (today's write and read records name no tool). | brief v3 lines 241, 258; null allowed is the agent's choice, LD33 |
| `detail.exit_status` | one of `"pass"`, `"fail"`, `"unknown"` | no | `pass`, `fail` or `unknown`. Every outcome mark carries it. | brief v3 lines 240, 258 |
| `detail.exit_code` | integer | no | Only when it is truly known. Never invent a code. Only a command's outcome carries it. Claude Code gives a passing command no code, and states a failed one's only in its failure text ("Exit code N"); the code is carried when stated, and a failure that states none has no exit_code. | brief v3 lines 240, 258; the stated code is LD121 (O's go, 2026-11-22), from X1's measurement (238 of 285 failure texts open with it) |
| `detail.background` | `true` | no | On a command's exited mark: true when the agent launched the command to run in the background, so the hook saw it start, not finish, and its exit_status is `unknown`. Absent otherwise. | agent's choice, NF66 (written since Phase 1); declared in the spec by F21, O's yes 2026-11-28 |
| `detail.interrupted` | `true` | no | On a command's exited mark: true when the agent's tool says the command was interrupted before it finished, so its exit_status is `unknown`. Absent otherwise. | agent's choice, NF66 (written since Phase 1); declared in the spec by F21, O's yes 2026-11-28 |
| `detail.output_excerpt` | string | no | The first 2,000 characters of output. | brief v3 line 262 |
| `detail.output_ref` | shape `hash` | no | When the output is longer, the fingerprint of the full output, which is kept beside the log. | brief v3 lines 262, 266 |
| `detail.vcs` | list of object | no | Git state in a command's output, the agent's testimony: one entry for each record today's capture writes (a commit and branch, each pull request, each set of CI checks), with today's field names. | brief v3 line 267. Entry shapes are today's capture records, not restated here. |
| `detail.hosts` | list of string | no | On a command's exited mark: every host the command line names (a URL's host with its port, and the host of a `user@host` argument to ssh, scp, sftp, rsync or git), sorted, each once. The agent's testimony: a name is not a contact, and a command can reach a host it never names. Absent when it names none, or when command facts are off. | agent's proposal CF1 (LD385; O, 2026-11-28: the in-roads, all but the one that needs administrator rights); written only with ORUNMILA_COMMAND_FACTS=1 |
| `detail.elevated` | `true` | no | On a command's exited mark: true when a step of the command line starts with sudo, doas, su, pkexec, runas or gsudo, so it asked for administrator rights; what it did with them is outside what Orunmila sees. Absent otherwise, or when command facts are off. | agent's proposal CF1 (LD385); written only with ORUNMILA_COMMAND_FACTS=1 |
| `detail.read_kind` | one of `"full"`, `"range"`, `"pattern"`, `"listing"`, `null` | no | `full` only when the adapter can show the tool returned the whole file, `range` when it returned only part, `pattern` when the agent only searched, `listing` when the tool listed a folder's entries (their names, no file's content), `null` when the adapter cannot tell. | brief v3 line 261 (open question 3); listing is LD121 (O's go, 2026-11-22) |
| `detail.read_range` | object | no | On a read: the lines the agent asked for and the lines the tool's own result says it returned, each null when not given. Its read_kind is `range` when the tool returned fewer lines than the file holds, or cut its content at a token cap; `full` when its counts show the whole file came back. | agent's choice, LD94 and LD121 (format change, O's go 2026-11-22) |
| `detail.read_range.asked_offset` | shape `line_number` | yes |  |  |
| `detail.read_range.asked_limit` | shape `line_number` | yes |  |  |
| `detail.read_range.start_line` | shape `line_number` | yes |  |  |
| `detail.read_range.lines` | shape `line_number` | yes | How many lines the tool's result says it returned, as the tool counts them. Claude Code's Read counts the empty piece after a file's last newline as a line, here and in total_lines alike, so a whole read has lines equal to total_lines. | agent's choice, LD125 (measured: 1,342 of 1,342 Read results count the content's newlines + 1) |
| `detail.read_range.total_lines` | shape `line_number` | yes | How many lines the tool's result says the file holds, as the tool counts them: for Claude Code's Read, a file ending in a newline counts one more than its newlines (890 newlines: 891). Kept as the tool stated it, never recounted. | agent's choice, LD125 (Fable cold verify C2, 2026-11-22) |
| `detail.read_range.truncated_by_token_cap` | `true` | no | True when the tool's result says it cut the file's content at its token cap. Absent otherwise. | agent's choice, LD94 (Claude Code's Read result field truncatedByTokenCap) |
| `detail.pattern` | string | no | The pattern, for a search. | brief v3 line 261 |
| `detail.size` | integer or null | no | The file's size in bytes; null when unknown (a fingerprinted mark for an entry that is not a regular file, or one the Opon could not read). | brief v3 lines 228, 261, 264; null as brief v4 line 241 (unknown, nothing else) and Q8's approved shape (LD171, LD174: null only when unknown), which this schema had refused (F11, LD235) |
| `detail.fingerprint` | shape `fingerprint` | no | The file's fingerprint (for a read, of the whole file as it was when the hook ran; it does not prove what the agent saw). | brief v3 lines 261, 264 |
| `detail.fingerprint_before` | shape `fingerprint` | no | `null` when the before-state is unknown; a `created` mark leaves the field out. | brief v3 line 264 |
| `detail.lines_added` | shape `count` | no | Never counted against an assumed-empty file. | brief v3 line 264 |
| `detail.lines_removed` | shape `count` | no | Never counted against an assumed-empty file. | brief v3 line 264 |
| `detail.diff_ref` | shape `hash` | no | The fingerprint of the diff, which is kept beside the log. Plain SHA-256 of the redacted copy. | brief v3 lines 264, 266 |
| `detail.no_diff` | one of `"binary"`, `"too_large"` | no | When there is no diff, says why: `binary`, or `too_large` (over the size limit recorded in the session header). | brief v3 line 266 |
| `detail.tool_input` | any | no | What a called tool was given. | brief v3 line 263 |
| `detail.tool_result_excerpt` | string | no | Only when the user switches result capture on. | brief v3 line 263 |
| `detail.tool_result_size` | integer | no | Only when the user switches result capture on. | brief v3 line 263 |
| `detail.text` | string | no | The claim. | brief v3 line 265 |
| `detail.claim_unconfirmed` | `true` | no | On a claimed mark: true when the agent's host gave no final text for the turn, so the claim's text could not be confirmed as the turn's own and is empty (N10). Absent otherwise. | agent's choice, LD85: today's turn_claim field (docs/SCHEMA.md), which the A8 adapter already carries |
| `detail.prompt` | string | no | The user prompt's text. | brief v3 line 257 |
| `detail.result` | one of `"passed"`, `"warned"`, `"blocked"`, `"skipped"` | no | `passed`, `warned`, `blocked` or `skipped`. | brief v3 line 242 |
| `detail.findings` | list of object | no | Each law the check found broken, with the quoted text it judged; empty when it passed or skipped. | brief v3 line 242 ("with the law and the quoted text"), test 61 ("laws and quoted text"); the shape is the agent's choice, LD36 |
| `detail.findings[].law` | string | yes | The law's id. | brief v3 line 242 |
| `detail.findings[].severity` | one of `"block"`, `"warn"` | yes | block or warn, as the law set it. | agent's choice, LD36 |
| `detail.findings[].quote` | string or null | yes | The sentence the law judged; null when the finding has none. | brief v3 line 242 |
| `detail.law_errors` | list of string | no | On a law-gate check, what the law loader said about a law file it could not read or a law it could not use, in its own words: a law that quietly stopped applying is never silent. | agent's choice, LD146: NF6 (Phase 1 plan B5), a malformed law file recorded, not silent |
| `detail.reason` | string | no | Why a check was skipped, for example: could not confirm the current turn. On the session's end, the reason the agent gave; on the intake's closing note, why it stopped. | brief v3 lines 242, 575; agent's choice of name, LD36; the session end's and the closing note's use, LD55 and LD56 |
| `detail.root` | string | no | The folder the Sentinel watches, as an absolute real path, on each of its marks and its watch gaps, so a Glove mark and a Sentinel mark for one file always join. | brief v4 line 345 (NF11); the field name is the agent's choice, LD145 |
| `detail.lost` | string | no | A gap mark names what was lost. | brief v3 line 341; the field name is the agent's choice, LD15 |
| `detail.stamped_by` | `"intake"` | no | If a source cannot stamp mono_ns, intake stamps arrival time and records that here. | brief v3 line 238 |
| `detail.what` | one of `"hook_settings"`, `"frozen_config"`, `"log_location"`, `"orunmila_code"`, `"foreign_sender"`, `"intake_stop"` | no | On a tampered mark, what was tampered with: `hook_settings`, `frozen_config`, `log_location`, `orunmila_code`, `foreign_sender`, or `intake_stop` (the intake stopped by a signal that no one asked for through `orunmila intake stop`; target the process `intake`). | brief v4 line 245; intake_stop is TE2's kind (LD283, Phase 5 plan section 4), approved by O as part of Q41 (2026-11-24) |
| `detail.signal` | one of `"SIGTERM"`, `"SIGINT"`, `"SIGHUP"` | no | On a tampered mark for an intake stop no one asked for: the signal that stopped it. | agent's proposal (TE2, LD283), approved by O as part of Q41 (2026-11-24) |
| `detail.channel` | one of `"http"`, `"command"` | no | Glove marks: how the mark reached intake. `http` for HTTP hooks, whose sender intake pins to the session's process at first contact; `command` for a command hook, which the agent can forge: it runs as the agent's own account (a separate account for Orunmila is not part of the free version). | brief v4 line 247 (decision I-3, 2026-11-16) |
| `detail.from` | string | no | On a renamed mark, the old path, normalised like `target.path`. | brief v4 line 265 (open point P3, decided 2026-11-16) |
| `detail.from_human` | boolean | no | On a prompted mark: false for a prompt the agent's tool wrote itself (a task notification, a sub-agent hand-back), which does not refill the gate's block budget. | brief v4 line 276 (open question 2, decided 2026-11-16) |
| `detail.redactions` | list of string | no | Noting the redaction: the kinds of secret replaced with [REDACTED:<kind>], never the values. | brief v3 line 248; a list of kinds is the agent's choice, LD15 |
| `detail.since` | shape `instant` | no |  | agent's choice, B1c-2 (test 84); wording approved by O 2026-11-17 |
| `detail.until` | shape `instant` | no |  | agent's choice, B1c-2 (test 84); wording approved by O 2026-11-17 |
| `detail.sessions` | list of string | no | On a gap for intake's downtime: every session intake was serving when it stopped, each of which gets this same gap. | brief v4 line 851 (test 84: naming the sessions active at its last tick); the name is the agent's choice, wording approved by O 2026-11-17 |
| `detail.clock_reset` | `true` | no | On a gap for intake's downtime: true when the machine's monotonic clock restarted meanwhile (a reboot), so since and until compare only by wall time. Absent otherwise. | agent's choice, B1c-2 (test 84); wording approved by O 2026-11-17 |
| `detail.sender_pid` | integer | no | On a tampered mark for a foreign sender: the process that sent the payload. On the Glove mark that pinned the session (its first HTTP payload): the pinned process, so a restarted intake re-pins from the record. Only intake writes it. | brief v4 line 245 ("with the evidence"); the name is the agent's choice, B1b, wording approved by O 2026-11-17; the pinning mark's use, LD58 (approved by O 2026-11-17) |
| `detail.pinned_pid` | integer | no | On a tampered mark for a foreign sender: the process the session is pinned to, its first HTTP sender. | brief v4 line 247; the name is the agent's choice, B1b, wording approved by O 2026-11-17 |
| `detail.exists` | boolean | no | On a fingerprinted mark: whether a file was at the target's path when the Opon fingerprinted it. False is a known absence, never an unknown. | agent's choice, LD171 (Q8): brief v4 line 241, null means unknown and nothing else, so an absence needs a value of its own |
| `detail.rescan` | boolean | no | On a fingerprinted mark: true when the closeout's full rescan took it, between the sweep's started and exited marks. | brief v4 line 450; the field is the agent's proposal (LD207, Q19; provisional, Q17) |
| `detail.entry` | one of `"link"`, `"other"`, `"unreadable"` | no | On a rescan's fingerprinted mark whose fingerprint is unknown: what the closeout's walk found at the path, which it could not fingerprint: a symbolic link (never followed), another kind of entry that is not a regular file, or one it could not read. | agent's proposal for F9, approved by O as Q26 (2026-11-23), LD234 |
| `detail.session` | string | no | On an overlapped mark: the other session sharing this one's folder that the intake names (its `root` and `from` beside it: its project root and its header's mono_ns). | agent's choice, Q11 (2) (a), adopted LD184, LD202 |
| `detail.ended` | boolean | no | On an overlapped mark: whether the session it names has ended; when true, `to` is its end mark's mono_ns. | agent's choice, Q11 (2) (a), adopted LD184, LD202 |
| `detail.to` | string | no | On an overlapped mark naming a session's end: that end mark's mono_ns, a decimal string. | agent's choice, Q11 (2) (a), adopted LD184, LD202 |
| `detail.received` | string | no | On a tampered mark for a foreign sender: the payload as it arrived, kept as text for evidence and redacted like any mark. It is never the session's own mark. | brief v4 line 245; the name is the agent's choice, B1b, wording approved by O 2026-11-17 |
| `detail.change` | one of `"appended"`, `"cut"`, `"edited"`, `"deleted"` | no | On a tampered mark for one of Orunmila's own logs: how the log differed from what Orunmila wrote: appended (lines after its end), cut (its end gone), edited (any other difference, a delete then a rewrite included) or deleted (no file: deleted or moved away). | agent's proposal (TE1, LD279), approved by O as Q41 (2026-11-24, LD282) |
| `detail.removed` | string | no | On a tampered mark for one of Orunmila's own logs: the text the change took out, cut to its first 2,000 characters and redacted like any mark; empty when nothing was taken out. | agent's proposal (TE1, LD279), approved by O as Q41 (2026-11-24, LD282) |
| `detail.added` | string | no | On a tampered mark for one of Orunmila's own logs: the text the change put in, cut to its first 2,000 characters and redacted like any mark; empty when nothing was put in. | agent's proposal (TE1, LD279), approved by O as Q41 (2026-11-24, LD282) |
| `detail.restored` | boolean | no | On a tampered mark for one of Orunmila's own logs: true when Orunmila put the log back from its own copy; false when its copy had been changed too, so nothing was put back. | agent's proposal (TE1, LD279), approved by O as Q41 (2026-11-24, LD282) |
| `detail.busy` | boolean | no | On an overlapped mark: whether the session it names was working at this mark's mono_ns (from its prompt to its turn's end, or with work it left running). A session never given this note counts as working all along. | agent's proposal (AT1, LD327), approved by O as Q45 (2026-11-26, LD330) |

### Rules between fields

- brief v3 line 255: Glove and law-gate marks name the turn, except the session's end (LD55)
- agent's choice, LD55: only the agent's own hook ends a session, outside any turn
- brief v3 line 255: sentinel, git and process write null
- brief v3 line 253: agent_claim is the agent's closing claim
- brief v3 lines 257, 265: the claim stays a claimed mark, with its text
- brief v3 line 242: each check is a checked mark on the turn, with detail.result
- brief v3 lines 242, 245: checked means the law gate checked a turn
- brief v3 line 346: tick marks have source process
- agent's choice, LD13: only tick and gap may have a null target
- brief v3 line 341: a gap mark names what was lost
- brief v3 line 257: each user prompt is a prompted mark on the turn, with the text in detail.prompt
- brief v3 line 258: every tool call gives a started mark and one outcome mark, both with the tool call id in cause_hint and the tool's name in detail.tool
- brief v3 line 258: every outcome mark carries detail.exit_status
- brief v3 line 240: exited marks always carry detail.exit_status
- brief v3 line 259: a command targets { kind: command, text }
- brief v3 lines 245, 264: file changes, the Glove's edit outcomes and the sentinel's marks alike
- brief v3 line 264: a created mark leaves fingerprint_before out
- brief v3 lines 259, 261: a read targets the file, or the folder searched
- agent's choice, LD121 (O's go, 2026-11-22): a folder listing reads the folder
- brief v3 line 259: a network contact targets { kind: network, host, url }
- brief v3 lines 259, 263: any other tool targets { kind: tool, name }; called carries tool_input
- brief v4 line 245: a tampered mark has source process and says what was tampered with
- brief v4 line 265: a renamed mark also carries from, the old path
- brief v4 lines 245, 386: the Opon records a file's fingerprint at settle time; the mark's shape is the agent's proposal (LD171, Q8): a file that exists has its size and fingerprint, null only when unknown; a file that does not has none
- brief v4 lines 344, 402-405, guarantee 3; the agent's proposal, Q11 (2) (a), adopted LD184, LD202: the intake names in this session's own log another session sharing its folder (its id, root and start), and later its end, so replay reads overlap from this log alone; AT1 (LD330, O approved Q45): `busy`, when present, says whether the session named was working at this mark (from its prompt to its turn's end, or with work left running), so a peer idle then is not counted as overlapping
- `target`: when `kind` is one of `"file"`, `"dir"`: `path` is required
- `target`: when `kind` is `"command"`: `text` is required
- `target`: when `kind` is one of `"turn"`, `"session"`: `id` is required
- `target`: when `kind` is `"tool"`: `name` is required
- `target`: when `kind` is `"network"`: `host` is required
- `detail`: brief v3 line 266: diffs stay out of the raw log
- `detail`: brief v3 line 266: no_diff only when there is no diff
- `detail`: brief v3 line 264: line counts are null unless both states are known
- `detail`: brief v3 line 261: pattern for a search

## Orunmila odù log header (`odu-header.schema.json`)

The odù log's first line, where its hash chain starts. It names the session and the raw log it was reconciled from.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a schema_version. | brief v4 line 209 |
| `record` | `"odu_header"` | yes | Marks this line as the odù log's header. | agent's choice, LD167 |
| `seq` | `0` | yes | The header is the first record of the odù log; odùs follow from seq 1. | agent's choice, LD167 |
| `session_id` | string | yes | The session. | brief v4 line 293 |
| `raw_header` | shape `fingerprint` | yes | The hash of the raw log's session header, so the odù log is tied to the raw log it came from. | agent's choice, LD167 |
| `prev_hash` | null | yes | null: the chain starts here. | spec/hash-chain.md |
| `hash` | shape `fingerprint` | yes | This record's hash. | spec/hash-chain.md |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string |  |  |  |

## Orunmila odù record (`odu.schema.json`)

The single trustworthy record of one real event. The Ọpọ́n writes one odù record per real event to a second log, hash-chained and canonically serialised like the raw log. The judge reads only this log.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"odu"` | yes | Marks this line as an odù record, so a reader tells it from the log's header without guessing. | agent's choice, LD167 |
| `seq` | integer | yes | The record's place in the odù log: the log's header is 0, records follow from 1. | agent's choice, LD167 (spec/hash-chain.md) |
| `odu_id` | string | yes | The record's id, unique in its session. | brief v4 line 292 |
| `session_id` | string | yes | The session the event happened in. | brief v4 line 293 |
| `parent_id` | string or null | yes | One command that touches many files becomes one parent odù with child odùs: a child names its parent; null for none. | brief v4 lines 294, 325 |
| `children` | list of string | yes | A parent's child odùs, in the order they opened. | brief v4 lines 295, 325 |
| `amends` | string or null | yes | An earlier sealed odù this one amends, when late marks arrived after sealing (station 2, rule 8); null for none. | brief v4 lines 296, 325, 370 |
| `continues` | string or null | yes | The odù this one continues, when the target never went quiet and the earlier one was force-settled at the ceiling (station 2, rule 2); null for none. | brief v4 line 364 ("a continuation group opens and links back to it"); the field name is the agent's choice, LD153, LD167; approved by O as Q6 (LD174) |
| `ceiling` | boolean | yes | True when the target never went quiet and the record was force-settled at the ceiling (station 2, rule 2); its continuation names it in `continues`. | brief v4 line 364; the field name is the agent's (LD153); approved by O as Q6 (LD174) |
| `state` | one of `"open"`, `"settled"`, `"sealed"` | yes | open (still collecting), settled (quiet, decided), sealed (final, hashed, never changes). Only sealed records reach the judge. | brief v4 lines 297, 324 |
| `target` | object or null | yes | The thing the event is about: usually a file path; can also be a folder, a command, a process, a claim, a turn, a tool or a network host. null when the marks behind it name no target (a gap mark), as the mark itself. | brief v4 lines 298, 244; null as the mark's target is (LD167) |
| `target.kind` | string | yes |  |  |
| `action` | one of `"created"`, `"modified"`, `"deleted"`, `"renamed"`, `"started"`, `"exited"`, `"ended"`, `"prompted"`, `"read"`, `"contacted"`, `"called"`, `"claimed"`, `"checked"`, `"fingerprinted"`, `"gap"`, `"tampered"`, `"overlapped"` | yes | What happened to the target. `action` takes the mark verbs, every one but tick (a heartbeat is never an event). | brief v4 lines 299, 377; overlapped, the mark verb of Q11 (2) (a) (LD184, LD202), added by O's approval of Q39 (2026-11-24, LD265, LD281) |
| `window` | object | yes | The first and last seq of the marks behind the event. | brief v4 line 300 |
| `window.first_seq` | integer | yes |  |  |
| `window.last_seq` | integer | yes |  |  |
| `net_change` | object | no | Whether anything actually changed: the target's fingerprint before and after, and whether they differ. Odùs of marks that change nothing on disk leave it out: nothing on disk was meant to change, and null would mean unknown. | brief v4 lines 301-305, 381-390; station 4 (slice N2). `absent` for a known absence is the agent's (LD171), approved by O as Q8 (2026-11-22, LD174): null means unknown and nothing else (line 241), so a created file's before and a deleted file's after need a value of their own |
| `net_change.before` | string or null | yes | The target's state before the event: its fingerprint at its last sealed odù, else the baseline snapshot's; `absent` when no file was there; null when unknown (no baseline, a path the baseline does not cover, a link). | brief v4 lines 302, 386; LD171 |
| `net_change.after` | string or null | yes | The target's state after the event: the fingerprint the Opon recorded when the group settled (a `fingerprinted` mark); `absent` when no file was there; null when unknown (no fingerprint taken, or a mark came after it). | brief v4 lines 303, 386; LD171 |
| `net_change.changed` | boolean or null | yes | Same fingerprint = `changed: false` (the record is still sealed and kept, just hidden from the judge's default view); different = true; null when before or after is unknown. | brief v4 lines 304, 388; LD171 |
| `cause` | object or null | yes | The cause attribution found, by station 5's steps in order; null when nothing matches (`unexplained`). | brief v4 lines 306, 392-400, 413; station 5 (slice A1b). The kinds beside the brief's `agent_tool_call`, and `also`, are the agent's proposal (LD176, Q9) |
| `cause.kind` | one of `"agent_tool_call"`, `"time_match"`, `"agent_command"`, `"byproduct"`, `"turn"`, `"session"` | yes | agent_tool_call: a Glove mark of the tool call that changed the target (step 1), or, for marks that change nothing, the call's own outcome; time_match: the change fell inside that tool call's start and end (step 2); agent_command: the change happened while that agent command ran (step 3); byproduct: the path matched that entry of the byproducts list (step 4); turn: a turn's own marks; session: the session's end. | brief v4 lines 306 (`agent_tool_call`), 396-399, 413; the other names are the agent's (LD176, Q9) |
| `cause.ref` | string | yes | What caused it: a tool call id, a turn id, a session id, or the byproducts entry that matched. | brief v4 line 306 |
| `cause.also` | list of string | no | When more than one tool call or command qualified at the same step: the others, after `ref`. | agent's proposal (LD176, Q9): the brief's example names one cause |
| `attribution` | one of `"explained"`, `"byproduct"`, `"unexplained"` | yes | Exactly one of explained, byproduct, unexplained. | brief v4 lines 307, 326; station 5 (slice A1) |
| `not_credited` | list of object | no | On an unexplained change on disk only: the agent activity beside it that station 5's steps did not credit, from recorded facts, so the label never hides that the agent was there. It credits nothing: a failed or reading tool call does not change a file, and the change may be a person's, a formatter's or another program's. Left out when there is none. | agent's proposal (slice A1c, LD178, Q10), from O's question on LD177 (1): the brief names no such field; unknown fields are allowed (line 209) |
| `not_credited[].kind` | one of `"agent_tool_call"`, `"agent_command"` | yes | agent_tool_call: a Glove tool call with marks in this odù; agent_command: an agent command that exited within one quiet window before the change was first seen. |  |
| `not_credited[].ref` | string | yes | The tool call id or the command's id. |  |
| `not_credited[].says` | list of string | no | For a tool call: its verbs in this odù. |  |
| `not_credited[].seen` | one of `"after_end"`, `"before_start"`, `"partly_inside"`, `"inside"`, `"no_start"`, `"no_end"`, `"after_exit"`, `"while_running"`, `null` | yes | Where the Sentinel's sighting of the change falls against the Glove's record of the call: after_end, before_start, partly_inside, no_start (no start recorded), no_end (no outcome recorded), inside (only while sessions overlap, when a time match does not credit); for a command, after_exit, or while_running (only while sessions overlap); null when the change has no Sentinel sighting to place. |  |
| `not_credited[].gap_ms` | integer | no | For after_end, before_start and after_exit: the milliseconds, on the session's monotonic clock, between the change's nearest sighting and the call's end, its start, or the command's exit. |  |
| `witnesses` | list of one of `"agent_claim"`, `"hook"`, `"sentinel"`, `"git"`, `"process"`, `"law_gate"` | yes | The sources whose marks are behind the event. | brief v4 line 308 |
| `witness_status` | object | yes | One entry for each witness, glove and sentinel, always present, plus git when Orunmila ran git for that target, and law_gate when the law gate checked the turn (its slots hold each check's result). A status is set only from recorded facts; Orunmila never guesses why a witness recorded nothing. | brief v4 lines 309-312, 331 (the G2b amendment); law_gate approved by O as Q40 (2026-11-24, LD267, LD284), so the verdict log alone carries the law gate's results |
| `witness_status.glove` | shape `witness` | yes |  |  |
| `witness_status.sentinel` | shape `witness` | yes |  |  |
| `witness_status.git` | shape `witness` | no |  |  |
| `witness_status.law_gate` | shape `witness` | no |  |  |
| `confidence` | one of `"high"`, `"medium"`, `"low"` | yes | high, medium or low, by the rules in station 6: how sure we are of the cause. High: a direct cause (a Glove outcome mark naming its tool call on this target), or a change with no agent cause that the Sentinel or git saw. Medium: the cause comes only from a time match or a running command. Low: only a claim, with no witness observation. Never lowered because one witness recorded nothing. | brief v4 lines 313, 327, 409, 413, 419-427; station 6 (slice C1). The cases the table is silent on (a turn, the session's end, a call with only `started`, a gap or note, a change on disk only a Glove mark step 1 does not credit reports) are read in LD185 |
| `conflicts` | list of object | yes | A list of disagreements, each naming the sources and what each said. Never dropped: on every odù, empty when there is none. | brief v4 lines 314, 328, 405, 411, 429-439; station 6 (slices C3a-C3e). `sources` and `said` are the agent's names for line 328's "naming the sources and what each said" (LD188, Q13); concurrent_sessions's `sessions` (LD180, Q11 (1), approved LD184); outcome_missing's `ref` and `why` (LD189, Q14); silent_change's `turns` and `claim_seqs` (LD194, Q16) and `downtime` (LD245, Q29); unfingerprinted's `entry` and `marks` (LD234, Q26) |
| `conflicts[].kind` | string | yes | The conflict's kind. concurrent_sessions: a change during overlapping sessions that cannot be pinned to one session. unconfirmed_by_filesystem: an agent reported an edit inside the Sentinel's root that the Sentinel and git never saw. outcome_missing: a tool call's `started` mark with no outcome by the end of its turn, or an outcome its payload says was interrupted. phantom_claim: on a claim's own odù, a claim the evidence does not support. silent_change: an agent-caused change of a file that its turn's claims never mention. contradiction: the Glove's and the Sentinel's own marks of a file disagree on whether it is there at the end, one saying only that it is (created, modified, renamed) and the other only that it is gone (deleted). missed_live: a change the closeout's full rescan found that no odù of the session holds. unfingerprinted: the closeout's full rescan found an entry it could not fingerprint (a link, another kind of entry, or one it could not read) where the session last knew a regular file or nothing, so whether the file changed is unknown; files under such a folder are hidden from the walk. |  |
| `conflicts[].ref` | string | no | For outcome_missing: the tool call's id. | agent's proposal (LD189, Q14) |
| `conflicts[].why` | one of `"interrupted"`, `"denied"`, `"gap"`, `null`, `"no_command"`, `"failed"`, `"unknown"`, `"no_event"`, `"unchanged"`, `"not_credited"` | no | For outcome_missing: interrupted or denied only when the agent's own hook payload says so; gap only when a capture gap mark overlaps the call's wait, from its start until it stopped waiting; null otherwise, since the record does not guess why. For a command phantom_claim: no_command (no matching run in the claim's turn), failed (the last matching run that settled failed) or unknown (no matching run settled: a pipe, or an unknown status). For a file phantom_claim: no_event (no change on a matching path), unchanged (every change of the claim's turn on it has a net change of false) or not_credited (a change on it in the turn's time that was not credited to this session). | brief v4 lines 406, 432, 433, 439; the field is the agent's proposal (LD189, Q14; LD191 and LD192, Q15). No adapter records a denial today, so `denied` is not yet written |
| `conflicts[].path` | string | no | For a file phantom_claim: the path as the agent wrote it. | brief v4 line 432; agent's proposal (LD192, Q15) |
| `conflicts[].targets` | list of string | no | For a file phantom_claim: the targets of the changes it cites (unchanged, not_credited), sorted; empty for no_event. | agent's proposal (LD192, Q15) |
| `conflicts[].turns` | list of string | no | For silent_change: the turns whose claims judged the change (those its cause's tool calls name), sorted. | agent's proposal (LD194, Q16) |
| `conflicts[].marks` | list of integer | no | For missed_live and unfingerprinted: the seq of each of the rescan's fingerprinted marks behind it, in order. | brief v4 line 450 (its missed_live conflict names the rescan's fingerprinted marks); agent's proposal (LD207, Q19) |
| `conflicts[].claim_seqs` | list of integer | no | For silent_change: the seq of each claimed mark read for those turns (claims that could not be confirmed are not read), in order; none of them mentions the change's path. | brief v4 line 330 (every verdict audited down to its marks); agent's proposal (LD194, Q16) |
| `conflicts[].claim` | one of `"command"`, `"file"` | no | For phantom_claim: the claim's kind, command ("tests pass") or file ("I updated config.ts"). | brief v4 lines 431-433; agent's proposal (LD191, Q15) |
| `conflicts[].phrases` | list of string | no | For a command phantom_claim: the execution phrases the rule-based reader found in the claim. | brief v4 line 443; agent's proposal (LD191, Q15) |
| `conflicts[].hedged` | boolean | no | For phantom_claim: the reader's hedge tag on the claim. | agent's proposal (LD191, Q15) |
| `conflicts[].runs` | list of object | no | For a command phantom_claim: every run in the claim's turn that matches it, in the order they started, each with its status as Orunmila reads it; empty when none ran. | brief v4 line 433 and test 4b ("citing the command's exit code or its absence"); agent's proposal (LD191, Q15) |
| `conflicts[].runs[].ref` | string | yes | The command's tool call id. |  |
| `conflicts[].runs[].text` | string | yes | The command as recorded. |  |
| `conflicts[].runs[].status` | one of `"pass"`, `"fail"`, `"unknown"` | yes | pass, fail, or unknown: no outcome recorded, an unknown exit status, or a pass through a pipe with no pipe-failure detection set (line 433). |  |
| `conflicts[].runs[].exit_code` | integer | no | Only when the record states it. |  |
| `conflicts[].runs[].piped` | `true` | no | True when a pipe is why a pass is read as unknown. Absent otherwise. |  |
| `conflicts[].sources` | list of one of `"agent_claim"`, `"hook"`, `"sentinel"`, `"git"`, `"process"`, `"law_gate"` | yes | The mark sources behind the odù that bear on the conflict, sorted. |  |
| `conflicts[].said` | object | yes | For each source in `sources`: its verbs in this odù, in seq order; an empty list when it said nothing. |  |
| `conflicts[].sessions` | list of string | no | For concurrent_sessions: every session active in the folder when the change was first seen, this one included, sorted. |  |
| `conflicts[].entry` | one of `"link"`, `"other"`, `"unreadable"` | no | For unfingerprinted: what the closeout's walk found at the path: link, other or unreadable. | agent's proposal (LD234, Q26) |
| `conflicts[].downtime` | list of integer | no | Restated by a rule below; described in its own row. |  |
| `lease` | object | yes | Present from day one with `checked: false`. Ọ̀pẹ̀lẹ̀ fills it later. | brief v4 lines 315, 329 |
| `lease.checked` | `false` | yes |  |  |
| `lease.inside` | `null` | yes |  |  |
| `mark_seqs` | list of integer | yes | The receipt. Every odù points back to every mark behind it, so any verdict can be audited down to the raw evidence. An odù with no marks cannot exist. | brief v4 lines 316, 330; guarantee 2 (line 489) |
| `prev_hash` | shape `fingerprint` | yes | The previous line's hash. | brief v4 line 287; spec/hash-chain.md |
| `hash` | shape `fingerprint` | yes | This record's hash. | brief v4 line 287; spec/hash-chain.md |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string |  |  |  |
| `witness` | object |  |  |  |
| `witness.status` | one of `"saw"`, `"saw_nothing"`, `"out_of_scope"`, `"down"` | yes | saw (the witness has marks in this odù); saw_nothing (it recorded nothing, and no recorded fact gives out_of_scope or down; this does not say the witness was healthy); out_of_scope, with `scope` naming the recorded fact; down (a gap mark, a heartbeat gap or a health finding covers the window). | brief v4 line 331 |
| `witness.scope` | one of `"outside_root"`, `"excluded"`, `"not_a_disk_event"`, `"no_hook_for_tool"` | no | For out_of_scope: the recorded fact. | brief v4 line 331 |
| `witness.mark_seqs` | list of integer | no | That witness's own marks in this odù. | brief v4 line 331 |
| `witness.says` | list of string | no | For saw: its verbs. | brief v4 lines 310-311, 331 |
| `witness.slots` | list of object | no | For saw: each of its marks' key detail slots, in the order of `mark_seqs`: the mark's `seq`, and whichever of exit_status, read_kind, result, fingerprint_before and fingerprint the mark carries. | brief v4 line 331 ("its verbs and key detail slots"); a field of its own beside `says`, as the example (line 310) shows verbs only; approved by O as Q6 (LD174) |
| `witness.slots[].seq` | integer | yes |  |  |

### Rules between fields

- `conflicts[]`: brief v4 lines 431-433, 441; the fields are the agent's proposal (LD191, Q15)
- `conflicts[]`: brief v4 line 434; test 5; the fields are the agent's proposal (LD194, Q16); `downtime` (Q29, LD245): the intake's downtime gaps inside its turns, by mark seq
- `conflicts[]`: brief v4 line 450; the field is the agent's proposal (LD207, Q19; provisional, Q17)
- `conflicts[]`: agent's proposal for F9, approved by O as Q26 (2026-11-23), LD234
- when `attribution` is `"unexplained"`: `cause` is null; otherwise `cause` is object
- when `not_credited` is present: `attribution` is `"unexplained"`

## Orunmila quarantine log header (`quarantine-header.schema.json`)

The first line of a session's quarantine log (`quarantine.jsonl`), where its hash chain starts. The quarantine log keeps every input that reached intake for this session and was not a valid mark, with its reasons, so nothing sent is ever dropped. Every session folder has one, even when nothing was quarantined. Quarantined records follow (quarantine.schema.json).

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"quarantine_header"` | yes | Marks this line as the quarantine log's header, so a reader tells it from a quarantined record without guessing. | agent's choice |
| `session_id` | string | yes | The session whose inputs this log keeps: the same id as the raw log's session header. | agent's choice |
| `seq` | `0` | yes | The header is the log's first record; quarantined records follow from seq 1. | agent's choice; spec/hash-chain.md |
| `prev_hash` | null | yes | The hash chain starts from the header, so it has no previous hash. | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | The header's own hash; the first quarantined record's prev_hash. | brief v4 line 248; spec/hash-chain.md |

## Orunmila quarantined record (`quarantine.schema.json`)

One input that reached intake for this session and was not a valid mark, kept whole with the reasons it was refused, one line of the quarantine log after its header. Redaction runs before anything is kept, so a secret in a malformed input is removed here as in a mark.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"quarantined"` | yes | Marks this line as a quarantined input. | agent's choice |
| `session_id` | string | yes | The session whose log this is, as in its header. | agent's choice |
| `seq` | integer | yes | This record's place in the quarantine log's own chain, from 1; it counts separately from the raw log's seq. | agent's choice; spec/hash-chain.md |
| `received_at` | string | yes | Wall-clock time intake received the input, in UTC. | agent's choice; the form of a mark's observed_at |
| `reasons` | list of string | yes | Why the input is not a valid mark, one sentence each (for example a schema rule it breaks, or that it is not JSON). Never empty. | brief v4 line 341 (kept with its reasons); agent's choice |
| `received` | string | yes | The input as received, after redaction: its JSON text when it was JSON, otherwise its text as it came. | brief v4 line 340 (nothing dropped); agent's choice |
| `redactions` | list of string | no | The kinds of secret redaction removed from the input (for example `aws_access_key`), never their values; absent when none. | brief v4 line 248; agent's choice, as a mark's detail.redactions |
| `kept` | list of string | no | Files that came with the input and were kept beside the log anyway, each named `sha256:` and its 64 hex digits, as a mark's diff_ref; absent when none. | agent's choice, LD59 (evidence is never dropped) |
| `prev_hash` | string | yes | The previous line's hash in the quarantine log (the header's, for the first record). | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | This record's hash. | brief v4 line 248; spec/hash-chain.md |

## Orunmila retention log header (`retention-header.schema.json`)

The first line of the retention log, where its hash chain starts. Old sessions are removed only whole, and each removal is written to this hash-chained log, so a removal can never look like a session that never existed. Removal records follow (retention-removal.schema.json).

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"retention_header"` | yes | Marks this line as the retention log's header, so a reader tells it from a removal without guessing. | agent's choice, LD66 |
| `seq` | `0` | yes | The header is the log's first record; removals follow from seq 1. | agent's choice, LD66 |
| `created_at` | string | yes | Wall-clock time of the first removal, which created the log, by the caller's clock. | agent's choice, LD66; the form of the session header's observed_at |
| `prev_hash` | null | yes | The hash chain starts from the header, so it has no previous hash. | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | The header's own hash; the first removal's prev_hash. | brief v4 line 248; spec/hash-chain.md |

## Orunmila retention removal record (`retention-removal.schema.json`)

One line of the retention log after its header: one session removed whole (its raw and quarantine logs, every part, and the files kept beside them). It is written before the session's folder is touched, and it holds what is needed to show which session went and that it was intact: the hash of its header line and the last seq and hash of each of its logs.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"removed"` | yes | Always `removed`. | agent's choice, LD66 |
| `seq` | integer | yes | One more than the line before it; the header is seq 0. | agent's choice, LD66; spec/hash-chain.md |
| `session_id` | string | yes | The session removed. | agent's choice, LD66 |
| `removed_at` | string | yes | Wall-clock time of the removal, by the caller's clock. | agent's choice, LD66; the form of the session header's observed_at |
| `reason` | string | yes | Why the session was removed, in the caller's words (for example the retention setting it was older than). | agent's choice, LD66; any text, as retention.js writes it (LD77) |
| `header` | string | yes | The hash of the session's header line, the first line of its raw log. A folder later found under the same id is compared with it, so a new session there is not taken for this one. | agent's choice, LD66; never null in a written record (LD77) |
| `raw` | shape `log_end` | yes | Where the session's raw log ended when it was removed. | agent's choice, LD66 |
| `quarantine` | shape `log_end` | yes | Where the session's quarantine log ended when it was removed. | agent's choice, LD66 |
| `counts` | object | yes | What the session held, as its check counted it. | agent's choice, LD66; the counts of src/verify/session.js |
| `counts.marks` | integer | yes | Marks in the raw log, the header and continuation records not counted. | agent's choice, LD66 |
| `counts.quarantined` | integer | yes | Inputs in the quarantine log. | agent's choice, LD66 |
| `counts.kept_files` | integer | yes | References in its marks to files kept beside the log, each checked (a file two marks name counts twice). | agent's choice, LD66 |
| `prev_hash` | string | yes | The `hash` of the line before, exactly as written there. | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | This record's hash, by the same rule as every line (spec/hash-chain.md). | brief v4 line 248 |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `log_end` | object |  | The last record of one of the session's logs, across its parts. | agent's choice, LD66 |
| `log_end.seq` | integer | yes | That record's seq. | agent's choice, LD66 |
| `log_end.hash` | string | yes | That record's hash, exactly as written there. | agent's choice, LD66 |

## Orunmila session footer (`session-footer.schema.json`)

footer.json beside a session's logs, written at the closeout's end: the final line of each log by seq and hash, so the logs as they stood at the close can be checked. Provisional (Phase 4, slice K4, LD209; Q17, Q20).

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a schema_version. | brief v4 line 209 |
| `record` | `"session_footer"` | yes | Marks this file as a session footer. | agent's choice, LD209 |
| `session_id` | string | yes | The session. | brief v4 line 293 |
| `raw` | shape `line` | yes | The raw log's last line at the closeout's end (the sweep's exited mark). | brief v4 line 454; agent's proposal (LD209) |
| `odu` | shape `line` or null | yes | The odù log's last line at the closeout's end, or null when no live odù log was written. | brief v4 line 454; agent's proposal (LD209) |
| `verdict` | shape `line` or null | yes | The verdict log's last line at the closeout's end, or null when no verdict log was written (the judge is off, or it failed, which the error log says). | brief v4 lines 453-454; agent's proposal (LD209), the line's shape since Phase 6 (Q34, LD262) |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `line` | object |  |  |  |
| `line.seq` | integer | yes | The line's seq. | agent's choice, LD209: as spec/hash-chain.md defines it |
| `line.hash` | string | yes | The line's hash. | agent's choice, LD209: as spec/hash-chain.md defines it |

## Orunmila session header (`session-header.schema.json`)

Every session's raw log begins with a header record, and the hash chain starts from it. It records everything needed to reproduce the session's results. Replay reads these values from the header, never from current settings.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v3 line 209 |
| `record` | `"session_header"` | yes | Marks this line as the header, so a reader tells it from a mark without guessing. | agent's choice, LD16 |
| `session_id` | string | yes | The session this log records. | brief v3 line 282 |
| `seq` | `0` | yes | The header is the first record of the raw log; marks follow from seq 1. | brief v3 lines 237, 282; 0 for the header is the agent's choice, LD10 |
| `observed_at` | string | yes | Wall-clock time the session started, for humans only. | brief v3 line 238 |
| `mono_ns` | string | yes | The monotonic clock at session start, as a decimal string of the integer. | brief v3 line 238; brief v4 line 238 (open point P1, decided 2026-11-16) |
| `orunmila` | object | yes | Orunmila's version. | brief v3 line 282 |
| `orunmila.version` | string | yes | Orunmila's version. | brief v3 line 282 |
| `orunmila.code_fingerprint` | shape `fingerprint` | no | A fingerprint of Orunmila's own code at session start; a change mid-session is a tampering mark. | agent: ledger A3 and NF41, phase1-plan A10; not in brief line 282 |
| `agent` | object | yes | The agent. | brief v3 line 282 |
| `agent.name` | string | yes | The agent, for example `claude-code`. | brief v3 line 282 |
| `agent.version` | string or null | no | The agent's version, null when unknown. | brief v3 line 282 |
| `os` | object | yes | The operating system. | brief v3 line 282 |
| `os.platform` | string | yes | For example `darwin`, `linux`, `win32`. | brief v3 line 282 |
| `os.release` | string | no | The operating system release. | brief v3 line 282 |
| `accounts` | object | yes | User accounts: the agent's, and the one Orunmila's files belong to (in the free version, the same account). | brief v3 lines 282, 587 |
| `accounts.agent_user` | string | yes | The account the agent runs as. | brief v3 line 282 |
| `accounts.orunmila_user` | string | yes | The account that owns Orunmila's logs. | brief v3 lines 282, 342 |
| `project_root` | string | yes | The session header records the project root, so a Glove mark and a sentinel mark for one file always join. | brief v3 line 339. An absolute path (POSIX, or a Windows drive). |
| `config` | object | yes | Every configured value (quiet window, ceiling, lag grace, exclusions). | brief v3 line 282; other configured values are allowed beside these |
| `config.quiet_window_ms` | integer | yes | The quiet window. | brief v3 line 282 |
| `config.ceiling_ms` | integer | yes | The ceiling. | brief v3 line 282 |
| `config.lag_grace_ms` | integer | yes | The lag grace. | brief v3 line 282 |
| `config.exclusions` | list of string | yes | Exclusions. | brief v3 line 282 |
| `config.diff_size_limit_bytes` | integer | yes | The size limit over which a diff is not kept (`no_diff: too_large`), a configured value recorded in the session header. | brief v3 line 266 |
| `config.case_insensitive` | boolean | no | Whether the project root's file system ignores case, as the intake probed it at session start. Intake lower-cases every mark's path and the baseline's on such a root (line 345), so replay folds a claim's path the same way before matching it; absent in headers written before the field existed, where replay cannot tell and matches as it did then. | agent's proposal (LD227), approved by O as Q25 (2026-11-23, "ok, go"), LD233; brief v4 lines 283, 345, 859 rule 4 |
| `config.byproducts` | list of string | no | The byproducts list (`.orunmila/byproducts`) as it was at session start: one entry per line, trimmed, blank lines and `#` comments left out, matched as the ignore list's entries are. Its fingerprint is `frozen.byproducts`, of the same bytes. Absent when the header does not carry the list (the live path off, slice A1a); station 5 then has no list to match. | brief v4 lines 283, 349, 399; the list in the header is the agent's proposal (LD175, Q9), so replay reads it from the header and never from current settings |
| `config.rules` | string | no | The rules file (`.orunmila/rules`) as it was at session start, its text whole, so the judge and any re-judgement read the session's rules from the header and never from current settings. Its fingerprint is `frozen.rules`, of the same bytes. Absent when the file did not exist (the default rules judge the session) or the judge was off. | brief v4 lines 283, 664, 684; agent's proposal, Q34 (approved by O 2026-11-24, LD262): copied by the intake, parsed only by the judge |
| `config.watch_extra` | list of string | no | The folders outside the project that this session's Sentinel also watched (ORUNMILA_WATCH_EXTRA), each its real absolute path with `/` separators, as an outside mark's path is written, sorted. A file there with no Sentinel mark is `saw_nothing`, not `out_of_scope`. Absent when the Sentinel watched no extra folder (the default). | brief v4 lines 283, 347; agent's proposal, Q42 (approved by O 2026-11-25, LD299; LD289, LD328) |
| `frozen` | object | yes | The fingerprints of every frozen configuration file (rules, byproducts, ignore list, law packs, agent hook settings) as they were at session start. null when the file does not exist. | brief v3 lines 282, 343 |
| `frozen.rules` | shape `fingerprint` | yes | `.orunmila/rules`. | brief v3 line 342 |
| `frozen.byproducts` | shape `fingerprint` | yes | `.orunmila/byproducts`. | brief v3 line 342 |
| `frozen.ignore` | shape `fingerprint` | yes | `.orunmila/ignore`. | brief v3 line 342 |
| `frozen.law_packs` | object | yes | Every law pack in use (Orunmila's canon and any project law pack), by name. | brief v3 line 343 |
| `frozen.hook_settings` | object | yes | The agent's own hook configuration files, by path. A change mid-session is recorded as a tampering mark; it cannot be held back (NF42, approved by O 2026-11-15). | brief v3 line 343, as amended for hook settings by O's NF42 decision |
| `hooks_report` | object | yes | Which tool calls the agent's hooks can report before and after they run. Where an agent cannot report before a tool runs, the session header says so. | brief v3 lines 282, 337. Each list holds tool names, or "*" for every tool (agent's choice, LD16); an empty list means none. |
| `hooks_report.before` | list of string | yes | Tools reported before they run. | brief v3 line 337 |
| `hooks_report.after` | list of string | yes | Tools reported after they run. | brief v3 line 337 |
| `test_command` | object | yes | The project's own test command as it was at session start, and a fingerprint of the scripts block that decides what it runs. Configuration is frozen at session start: a change to the block mid-session is a tampering mark (`frozen_config`) and does not take effect until the next session. Every value is null when none was found. | agent: slice B8, proposed in writing to O (brief v4 line 859, rule 4) and approved 2026-11-18 ("If you're sure b8 is the best choice, lets go"), narrowed by LD70 from the whole file to its scripts block; grounded in brief v4 lines 283 and 349 |
| `test_command.text` | string or null | yes | The test command, redacted like every other text the log holds; null when none was found. | agent: LD70; redaction as brief v4 line 249 |
| `test_command.source` | object or null | yes | Where the command was read from; null with no command. | agent: LD70 |
| `test_command.source.path` | string | yes | The file, relative to the project root (today always `package.json`). | agent: LD70 |
| `test_command.source.key` | string | yes | The entry in that file (today always `scripts.test`). | agent: LD70 |
| `test_command.scripts_fingerprint` | string or null | yes | Plain SHA-256 of the RFC 8785 form of package.json's whole scripts block, its string values redacted first; null when the block is unknown. | agent: LD70; a test script can run other scripts, so the whole block is frozen |
| `baseline` | object | no | The baseline snapshot taken at session start: a fingerprint of every file in the workspace, kept beside the log as `baseline.jsonl` (one canonical JSON line per entry, sorted by path). The walk skips what `config.exclusions` names, so the exclusion itself is in this header. Its fingerprint is here, so the hash chain covers it too. Absent when no snapshot was taken. | brief v4 lines 385, 387; the field's name and shape are the agent's (LD170). Counts of entries and bytes are left out: the brief does not name them and the file gives them |
| `baseline.fingerprint` | string | yes | Plain SHA-256 of `baseline.jsonl`'s bytes. | brief v4 line 387 |
| `prev_hash` | null | yes | The hash chain starts from the header, so it has no previous hash. | brief v3 line 282 |
| `hash` | string | yes | The header's own hash; the first mark's prev_hash. | brief v3 lines 247, 282 |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string or null |  | Plain SHA-256, or keyed HMAC-SHA-256 for files on the redaction list; null when the file does not exist. | brief v3 lines 249, 343 |

## Orunmila session verdict (`session-verdict.schema.json`)

The whole session's one verdict, the last line a judgement writes to the verdict log: Incomplete if any evidence was lost, otherwise the most serious verdict among its events.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a schema_version. | brief v4 line 209 |
| `record` | `"session_verdict"` | yes | Marks this line as the session's verdict. | agent's choice, Q34 |
| `seq` | integer | yes | The record's place in the verdict log. | agent's choice, spec/hash-chain.md |
| `session_id` | string | yes | The session. | brief v4 line 293 |
| `verdict_id` | shape `verdict_id` | yes | The session verdict's id, numbered with the log's verdicts. | agent's choice, Q34 |
| `verdict` | one of `"incomplete"`, `"clean"`, `"look_at_this"`, `"violation"` | yes | incomplete, clean, look_at_this or violation. Incomplete outranks Clean, always. | brief v4 line 686 |
| `reasons` | list of object | yes | Each reason the session is Incomplete, empty when it is not: a gap (a source lost events: the gap odùs), the law gate silent, or the Glove silent (the Sentinel's odùs inside the project it said nothing about). | brief v4 lines 670, 674, 678, 679, 686 |
| `reasons[].reason` | one of `"gap"`, `"law_gate_silent"`, `"glove_silent"` | yes | gap, law_gate_silent or glove_silent. | brief v4 lines 674, 678, 679 |
| `reasons[].rule` | shape `rule` | yes | The rule behind the reason. | brief v4 line 659 |
| `reasons[].odu_ids` | list of string | yes | The odùs that show it, in order; empty for the law gate silent, which is shown by none. | agent's choice, Q34 |
| `counts` | object | yes | How many odùs got each verdict, and how many of them the default view hides. | agent's choice, Q34 (the report gives the counts, brief v4 line 690) |
| `counts.clean` | shape `count` | yes | Clean odùs. | brief v4 line 650 |
| `counts.look_at_this` | shape `count` | yes | Look at this odùs. | brief v4 line 651 |
| `counts.violation` | shape `count` | yes | Violation odùs. | brief v4 line 652 |
| `counts.hidden` | shape `count` | yes | Of them, those the default view hides. | brief v4 lines 661, 662 |
| `law_gate` | object | no | The law gate's checks over the session, from each odù's law_gate witness: how many turns it checked, how many passed, warned, were blocked and were skipped, the skip rate (skipped over checked, a whole percent), and whether that rate is over the 2% ceiling. Skips are a count, never Incomplete. Absent in a judgement from before the law gate's results were in the odù record. | brief v4 lines 686, 692; approved by O as Q40 (2026-11-24, LD267, LD284) |
| `law_gate.checked` | shape `count` | yes | Turns the law gate checked. | brief v4 line 692 |
| `law_gate.passed` | shape `count` | yes | Checks that passed. | brief v3 line 242 |
| `law_gate.warned` | shape `count` | yes | Checks that warned. | brief v3 line 242 |
| `law_gate.blocked` | shape `count` | yes | Checks that blocked the turn; each is its own finding (R21). | brief v4 line 692 |
| `law_gate.skipped` | shape `count` | yes | Checks skipped. | brief v4 line 692 |
| `law_gate.skip_rate` | shape `count` | yes | Skipped over checked, as a whole percent, 0 when none was checked. | brief v4 line 686 |
| `law_gate.over_ceiling` | boolean | yes | True when the skip rate is over 2%: its own Look at this (R22). | brief v4 line 686 |
| `judged` | object | yes | The odù log's last line this judgement read, by seq and hash. | agent's choice, Q34 |
| `judged.seq` | integer | yes | The line's seq. | agent's choice, spec/hash-chain.md |
| `judged.hash` | shape `fingerprint` | yes | The line's hash. | agent's choice, spec/hash-chain.md |
| `judge` | object | yes | The judge that gave this verdict: its name and version. | brief v4 line 682 |
| `judge.name` | string | yes | The judge's name. | brief v4 line 682 |
| `judge.version` | string | yes | The judge's version. | brief v4 line 682 |
| `rules` | shape `fingerprint` | yes | The fingerprint of the rule set that judged it. | brief v4 line 684 |
| `rules_source` | one of `"header"`, `"default"`, `"file"` | yes | Where the rules came from: `header` (the rules file as it was at session start, kept in the session header), `default` (the session header holds none, so Orunmila's default rules), `file` (a re-judgement with a rules file named by the user). | brief v4 lines 283, 664, 684; agent's choice, Q34 |
| `supersedes` | null or shape `verdict_id` | yes | null, or the earlier session verdict a later judgement replaces. | brief v4 line 684 |
| `prev_hash` | shape `fingerprint` | yes | The previous line's hash. | agent's choice, spec/hash-chain.md |
| `hash` | shape `fingerprint` | yes | This record's hash. | agent's choice, spec/hash-chain.md |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string |  |  |  |
| `verdict_id` | string |  |  |  |
| `rule` | string |  |  |  |
| `count` | integer |  |  |  |

## Orunmila update record (`update.schema.json`)

One update of Orunmila by itself: the version it ran and the one it was offered, npm's integrity hash of the package it checked, the result of the new version's self-check, and whether it switched. A failed self-check keeps the version it ran, and is recorded too. Follows the update log's header (updates-header.schema.json) in one hash chain.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"update"` | yes | Marks this line as an update record. | agent's choice, LD329 |
| `seq` | integer | yes | Its place in the update log, from 1. | brief v4 line 237; agent's choice, LD329 |
| `at` | string | yes | Wall-clock time of the switch, or of the refusal. | agent's proposal Q44 (a), approved by O (LD299): the time; the form of the session header's observed_at |
| `from` | string or null | yes | The version Orunmila ran before; null when no version was installed in its home yet (the first one). | agent's proposal Q44 (a), approved by O (LD299): the version from |
| `to` | string | yes | The version it was offered and checked. | agent's proposal Q44 (a), approved by O (LD299): the version to |
| `integrity` | string | yes | npm's integrity hash of the package checked, in the registry's own form (Subresource Integrity: the algorithm, a dash, the digest in base64). | agent's proposal Q44 (a), approved by O (LD299): npm's integrity hash |
| `self_check` | one of `"pass"`, `"fail"` | yes | The new version's self-check: pass, or fail (it is then not switched to). | agent's proposal Q44 (a), approved by O (LD299): the self-check's result |
| `switched` | boolean | yes | Whether Orunmila now runs the new version. | agent's choice, LD329 |
| `prev_hash` | string | yes | The previous record's hash. | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | This record's own hash. | brief v4 line 248; spec/hash-chain.md |

## Orunmila update log header (`updates-header.schema.json`)

The first line of the update log (`updates.jsonl` in Orunmila's home, beside the sessions), where its hash chain starts. Orunmila switches itself to a newer version only while no session is held, so no session's record sees its code change; each switch, and each update it refused, is a record in this hash-chained log, so an update can never look like code that was always there. Update records follow (update.schema.json).

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a `schema_version`. | brief v4 line 209 |
| `record` | `"updates_header"` | yes | Marks this line as the update log's header, so a reader tells it from an update without guessing. | agent's choice, LD329 |
| `seq` | `0` | yes | The header is the log's first record; updates follow from seq 1. | agent's choice, LD329 |
| `created_at` | string | yes | Wall-clock time of the first update, which created the log. | agent's choice, LD329; the form of the session header's observed_at |
| `prev_hash` | null | yes | The hash chain starts from the header, so it has no previous hash. | brief v4 line 248; spec/hash-chain.md |
| `hash` | string | yes | The header's own hash; the first update's prev_hash. | brief v4 line 248; spec/hash-chain.md |

## Orunmila verdict log header (`verdict-header.schema.json`)

The verdict log's first line, where its hash chain starts. It names the session, the odù log it judges and the judge that wrote it.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a schema_version. | brief v4 line 209 |
| `record` | `"verdict_header"` | yes | Marks this line as the verdict log's header. | agent's choice, as the odù log's header (LD167) |
| `seq` | `0` | yes | The header is the first record of the verdict log; verdicts follow from seq 1. | agent's choice, spec/hash-chain.md |
| `session_id` | string | yes | The session. | brief v4 line 293 |
| `odu_header` | shape `fingerprint` | yes | The hash of the odù log's header, so the verdict log is tied to the odù log it judged. | brief v4 line 684 (points back to the odù it judged); agent's choice of field, Q34 |
| `judge` | shape `judge` | yes | The judge that wrote the log: its name and version. A stricter judge can replace the default one through the same interface. | brief v4 line 682; agent's choice of field, Q34 |
| `prev_hash` | null | yes | null: the chain starts here. | agent's choice, spec/hash-chain.md |
| `hash` | shape `fingerprint` | yes | This record's hash. | agent's choice, spec/hash-chain.md |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string |  |  |  |
| `judge` | object |  |  |  |
| `judge.name` | string | yes | The judge's name: `babalawo` for Orunmila's default judge. | brief v4 line 682 |
| `judge.version` | string | yes | The judge's version. | brief v4 line 682 |

## Orunmila verdict record (`verdict.schema.json`)

One verdict on one sealed odù record: Clean, Look at this or Violation, with its receipt. A line of the verdict log, hash-chained like the other two logs. Same odù records plus same rules always give the same verdicts, so a verdict holds no clock.

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `schema_version` | `1` | yes | All carry a schema_version. | brief v4 line 209 |
| `record` | `"verdict"` | yes | Marks this line as a verdict on one odù. | agent's choice, as the odù log's records (LD167) |
| `seq` | integer | yes | The record's place in the verdict log: the header is 0, records follow from 1. | agent's choice, spec/hash-chain.md |
| `session_id` | string | yes | The session. | brief v4 line 293 |
| `verdict_id` | shape `verdict_id` | yes | The verdict's id, unique in its log; a later verdict names an earlier one by it in `supersedes`. | agent's choice, Q34 |
| `odu_id` | string | yes | The odù the verdict judges. | brief v4 lines 659, 684 |
| `odu_hash` | shape `fingerprint` | yes | That odù's hash in the odù log, so the verdict points at exactly one record. | brief v4 line 684 (points back to the odù it judged); agent's choice of field, Q34 |
| `verdict` | one of `"clean"`, `"look_at_this"`, `"violation"` | yes | Three verdicts, nothing else: clean, look_at_this, violation. | brief v4 lines 129, 646-652 |
| `rule` | shape `rule` | yes | The rule that decided the verdict, by its id in the rule set (R0: no rule found anything, so the odù is Clean). For a parent raised by a child, the child's rule. | brief v4 line 659 (the rule that fired) |
| `also` | list of shape `rule` | yes | Every other rule that fired on the odù, by id, sorted; empty when none did. | agent's choice, Q34: line 659 cites one rule, and an odù can break more than one |
| `mark_seqs` | list of integer | yes | The receipt: the odù's marks. A verdict without a receipt cannot exist. | brief v4 line 659 |
| `witness_status` | object | yes | The odù's witness_status, copied, so the verdict log alone shows what each witness recorded. | brief v4 line 684 |
| `hidden` | boolean | yes | True when the default view hides the odù: a Clean reverted change, or a Clean mark that changes nothing on disk. | brief v4 lines 332, 661, 662 |
| `opened` | list of string | yes | For a parent: the children whose own verdict is more serious than the parent's own and raised it; empty otherwise. | brief v4 line 660 (parents first) |
| `supersedes` | null or shape `verdict_id` | yes | null, or the earlier verdict on the same odù that a re-judgement replaces. Old verdicts are never edited. | brief v4 line 684 |
| `rules` | shape `fingerprint` | yes | The fingerprint of the rule set that judged it: SHA-256 of the rules file's bytes. | brief v4 line 684 |
| `prev_hash` | shape `fingerprint` | yes | The previous line's hash. | agent's choice, spec/hash-chain.md |
| `hash` | shape `fingerprint` | yes | This record's hash. | agent's choice, spec/hash-chain.md |

### Shared shapes

| Field | Type | Required | What it means | Source |
|---|---|---|---|---|
| `fingerprint` | string |  |  |  |
| `verdict_id` | string |  |  |  |
| `rule` | string |  |  |  |
