# Changelog

All notable changes to orunmila are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From 1.0.0, a command, flag or output field is removed or changed in meaning only in a
new major version, and named in this file first.

## [Unreleased]

### Upgrading from 0.2.x

**What changes**

- **The hooks run through one starter.** `orunmila install` keeps a copy of the
  package in Orunmila's home and every hook it writes runs that copy through
  `~/.orunmila/bin/orunmila-start.js`, so clearing a package cache no longer
  switches capture off. Hooks an earlier version wrote are moved onto the
  starter when you run `orunmila install` again (below).
- **A second, optional record: the intake.** Each session can get its own
  hash-chained log in `~/.orunmila/sessions/<id>/`, outside the project, which
  `orunmila verify` checks with no network and no setup. Its formats are the
  open specification in `spec/` (v1, Apache 2.0). Nothing changes until you
  install it.
- **`orunmila install` turns on the daily update check** unless you have chosen
  already (`--without-updates`, or `ORUNMILA_UPDATES=0`, turns it off). It sends
  only the package's name.
- **`orunmila html` is replaced** by `orunmila report --verdicts --session ID
  --html FILE`. It keeps working in 1.x and is removed no sooner than 2.0.0; it
  says so when it runs.
- **`orunmila prune` stays for the old event log**; the intake's per-session logs
  are removed whole, and recorded, by `orunmila retention`.
- **Cursor is supported for the Stain Map** (test 49, on Cursor's command-line
  agent). Before, `install --agent cursor` wrote a hooks file Cursor does not read,
  so nothing was recorded; it now writes Cursor's own format and reads the hooks
  Cursor sends (tool calls with their exit codes, the final message, and a print
  mode session's end). Run `orunmila install --agent cursor` again in each Cursor
  project: it replaces the old entries and keeps your own hooks.

**What to do**

1. Upgrade the package the way you installed it (`npm install -g orunmila`, or
   as a dev dependency).
2. Run `orunmila install` again in each project whose sessions you record. It
   moves your existing hooks onto the starter in place and adds none; hooks that
   name a different copy of Orunmila are refused, named and left as they are.
3. Run `orunmila status`: it names any hook whose script is missing, and exits 1
   if one is.
4. If your event log was written before 0.2.2, `orunmila log redact` removes the
   secrets the old capture kept, or `orunmila log delete --yes` deletes the log.
5. Optional: `orunmila install --intake`, then `orunmila intake start`, for the
   per-session record and `orunmila verify`.

**What still works**

Every command of 0.2.x keeps its name, its flags and its output's shape:
`install`, `agents`, `lenses`, `status`, `trail` (and its alias `glove`),
`report`, `html`, `json`, `feedback`, `feedback-import`, `laws`, `stats`,
`prune`, `rescore`, `archives`, `demo`, `watch`, `watch-fs` and
`debug-transcript`. A test holds the JSON shapes of `trail --json`,
`trail --json --facts-only`, `json` and `laws --check --json` against the
published 0.2.4 on a real session. The event log `~/.orunmila/events.jsonl`, the
hook scripts by their paths in the package (`src/capture/claude-code/`),
`.orunmila/ignore`, `.orunmila/redact` and `ORUNMILA_LAWS=off` work as before.

### Added

- **A page for new users, and the support table stated plainly.**
  `docs/START.md` (in the package) is for someone who has never heard of
  Orunmila: what it is, a first session in ten minutes, how to read a real
  session report, its words, what it defends against and cannot see, what it
  stores, where and for how long, and which agents are supported. Claude Code
  is fully supported; Cursor is experimental until it passes the real-session
  tests; Gemini CLI, Codex, Continue, Antigravity and Generic are experimental
  (sample data only); Aider is experimental and sentinel only; no Windsurf
  adapter exists. An experimental adapter's session says so on the first line
  of `orunmila report`.
- **A short README, a guide, and a map of the system for contributors.** The
  README is now the way in: what Orunmila is, a "Start here" table, a
  four-command quickstart, the three lenses, what it catches and cannot see,
  and what's new. Everything else moved, word for word, to `docs/GUIDE.md`,
  which the package now carries. `CONTRIBUTING.md` gains a first hour and a
  map of the system, every folder in `src/` named. The README now names three
  lenses, as the help does (it said two), and `CONTRIBUTING.md` no longer says
  the tool makes no network call (the update check is its one).
- **The trail page's Graph tab is a flowchart on a canvas.** Each thing is a
  box and each link an arrow pointing the way it went, read, ran or used,
  changed, left to right. The canvas moves both ways: scroll (Shift and scroll
  to go sideways), drag the background, or use the arrow keys; Ctrl or ⌘ and
  scroll, a pinch, or + and − zoom about the pointer; 0 or the Fit button fits
  the width again, and a button opens it full screen. Nothing is held back:
  the Graph showed at most 60 things a level, and now shows every one. At the
  picture's edge the scroll goes back to the page.
- **The licence and trademark files a release carries.** `TRADEMARKS.md` says
  how the Orunmila name may be used (the Apache License grants no rights to
  it, and a changed version needs a new name). `THIRD_PARTY_LICENSES` says the
  package has no runtime dependency to credit. NOTICE points to the trademark
  policy, and every JavaScript file opens with its SPDX licence identifier and
  copyright line. `test/license-files.js` keeps each of these true, and also
  fails if LICENSE stops matching the Apache 2.0 text or a locked package is
  not permissively licensed.
- **The trail page's 3D Map.** The same map in 3D, drawn by Orunmila's own
  WebGL2 code in the package, with nothing loaded from the network: glowing
  spheres, links with sparkles, a replay that starts from a blank canvas and
  builds the map in the order the agent worked (each thing appears when first
  touched, each link grows once both its ends are there), following the agent
  from file to file, and a Calm (the default) or Vivid look. Without WebGL2 it says so and
  points to the Graph tab.
- **The witness gap.** `orunmila report --verdicts` gives, second after its
  top line, every file change in the session counted by what both witnesses
  recorded of it; the trail page shows it under its header, and says when a
  session has no odù log to read it from.
- **Rule R27, tests weakened** (the judge 1.2.0). A **Look at this** when the
  agent deletes a test file, adds skip or only markers to one, or removes more
  assertion lines than it adds, read from the diffs kept beside the log; the
  report says when that turn's claim says the tests pass.
- **`orunmila trailer`.** A session's verdict as git trailers on a commit
  message (`--append` for a `commit-msg` hook). A convenience, not evidence.
- **The claims block** (`ORUNMILA_CLAIMS_BLOCK=1`, off by default). Claude Code's
  agent is asked, with each prompt, to end its turn with an `orunmila-claims`
  block: each `proved:` command must have run in the turn and passed; each
  `changed:` file is checked in the session's record; `not done:` lines are
  shown in the session report. Format: `spec/claims-block.md`.
- **The judge as an install option, like the Closeout Gate.** `orunmila install
  --with-judge` and `--without-judge` set its switch in Orunmila's home, read at
  the intake's next start; `orunmila lenses` and `status` show it beside the
  other two lenses (`ORUNMILA_JUDGE_LIVE` still wins where set).
- **`orunmila verify --updates`** checks the update log's hash chain and each
  record against its schema.
- **`orunmila update`.** Brings the copy in Orunmila's home up to the npm
  registry's latest `orunmila`: the download is checked against the registry's
  integrity hash, the new version must pass its own self-check, and Orunmila
  switches to it only while no session is being recorded (it waits, checked,
  until then), keeping the version it ran as `runtime/previous`. Each switch and
  each failed self-check goes into `~/.orunmila/updates.jsonl`. This is the
  package's one network call; it sends only the package's name. `orunmila
  install` turns it on to run by itself, unless you have already chosen: at
  most once a day, started by the intake or, where none runs, by a hook, in the
  background, so nothing waits for it. `orunmila install --without-updates`
  (or `ORUNMILA_UPDATES=0`) turns it off, `--with-updates` on again.
  The intake runs the copy in Orunmila's home too (`orunmila intake start` and
  the launch agent start it through the starter), moves onto a new version once
  it holds no session, and names the version it runs in `orunmila intake status`.
- **The intake starts at login on Windows.** `orunmila intake agent install`
  writes `orunmila-intake.vbs` into your Startup folder (no administrator
  rights), which starts the intake hidden through `orunmila intake keep`; the
  keeper starts it again after a crash or a stop no one asked for, as the
  launch agent does on macOS. Not yet run on a real Windows login.
- **The intake on Windows.** It listens on a named pipe, under a fresh name at
  each start (the home's name plus 32 random hex), published in
  `~/.orunmila/intake/address`, which both hook senders and the CLI read; so no
  program can take the name before the intake starts. A program listening on
  the old, fixed name is recorded as a squat. The full test suite, the hooks
  run through cmd.exe and Git Bash, and every install route pass on Windows in
  CI (Node 18, 20 and 22); a few checks need POSIX file modes or a stop signal
  Windows does not deliver, and are skipped there by name, never passed.
- **A stop no handler sees is named at the next start.** A kill (`kill -9`, or
  Task Manager and `taskkill /F` on Windows) runs no handler, so the intake
  could only show the downtime. Each run now leaves a note while it runs, and
  the next start says in the gap it writes whether the intake was killed,
  crashed (with the error) or the machine rebooted while it ran. On Windows a
  console Ctrl+Break is now handled like the other stop signals.
- **A second session that sits idle no longer blocks credit**
  (on by default; `ORUNMILA_PEER_BUSY=0` turns it off). The intake notes in each session's
  record when another session in the same folder is working (the `overlapped`
  mark's new `busy` field). A change made during this session's command while
  every other session is idle is credited to that command at medium
  confidence, where before it was unexplained. Records without the note read
  as before.
- **The Graph tab reads left to right.** Three levels (what the agent read, ran
  and changed), each in its folders, flagged things first; links curve between
  the columns instead of through one centre point. A folder or file written
  two ways (`src/x.js` and `~/proj/src/x.js`) is one.
- **The intake, a preview, off until you install it.** `orunmila intake
  run|start|status|stop` runs one intake per machine on a Unix socket in
  Orunmila's data dir; it writes each session to its own hash-chained log in
  `sessions/<id>/`, outside the project (`orunmila verify` checks one).
  `orunmila install --intake` adds Claude Code HTTP hooks posting to
  `127.0.0.1` (port 47390, or `ORUNMILA_INTAKE_PORT`) for prompts, tool calls
  and stops, and a small sender, `intake-send.js`, for session start, failed
  tool calls and session end, for every tool, beside the capture hooks you
  already have, which keep working as before. Neither ever blocks your agent:
  **when no intake is running, nothing is sent and that session has no intake
  record at all**, so start the intake first; `orunmila intake agent install`
  keeps it running at login (a per-user launch agent, macOS;
  `orunmila intake agent uninstall` removes it). A sender that cannot hand its
  payload over within one second gives up, and that payload is lost. If
  another process holds the intake's socket when it starts, the intake records
  that and takes the socket back (on Windows a pipe cannot be taken back, so
  each start listens on a fresh name, above); a port held by another process is recorded
  and tried again every second until the intake has it. The intake runs the Filesystem Sentinel
  itself for each session's folder, `.orunmila/` included, and records a change
  during the session to the project's `.orunmila/` files, the law packs, the
  agent's hook settings or Orunmila's own code as tampering. These logs are
  read by `orunmila verify`, `report --verdicts`, `judge`, `trailer`,
  `trail --json --marks` (both witnesses on every row), `json` with
  `--side-by-side` or its two switches, and the trail page and dashboard (the
  witness line and the judge's verdict); the other reports come from the event
  log, and read the session log when the event log has nothing for the session
  (below).
- **Exact capture, off by default (`ORUNMILA_EXACT_CAPTURE=1`).** Claude Code
  sends a failed tool call with no `tool_response`; the exit code is the first
  line of its `error` text (`Exit code N`, or `Error: Exit code N`) and the
  command's output the rest. Capture read neither, so every failed command
  was recorded as `exit_code: 1` with empty output (NF22). With the switch on,
  the stated code is recorded, or `null` (still `failed: true`) when the text
  states none, and the output is kept like any command's, redacted whole
  before the excerpt is cut. A read records how much of the file it returned,
  from the tool's own result, in `read_range`, and `read_kind` is `range` when
  that was less than the whole file (LD94); a folder listing (`list_dir`) is
  `read_kind: "listing"`, not a file read. The gate grades a `range` read of
  a file it hashed as before, a full receipt; a `range` read with no hash, and
  a listing, are now weak receipts, and a failed `range` read is none (each was
  full while every read said `full`). With the switch off, capture writes
  exactly what it wrote before; docs/SCHEMA.md lists the fields.
- **Two previews for the Closeout Gate, off by default.** With
  `ORUNMILA_GATE_MARKS=1` each check the gate makes (passed, warned, blocked or
  skipped, with the laws and the quoted sentence) is also written to the
  intake's session log. With `ORUNMILA_GATE_FROM_MARKS=1` the gate judges a
  turn from that log: a read or edit that failed is no receipt, and a folder
  listing is a weak one; and a turn with a tool call started whose outcome is
  not in that log yet is never blocked, since capture may still be writing it:
  the gate records a skip. With both off the gate behaves exactly as before.
- **`orunmila leak-check`: find your `.env` values in what Orunmila stored.**
  Capture redacts known secret formats, not your `.env` values, so a value in
  a format it does not know is stored as written, by both witnesses;
  SECURITY.md now says so. The command reads the project's top-level `.env`
  files once, when you run it, and searches the data dir, the report files in
  the project folder and any `--path` for each value (as written, and as JSON,
  HTML and the report pages escape it). It prints names, files and lines, never
  values, and exits 1 if any value is found, 2 if nothing was checked or a path
  was not read. Nothing runs it automatically. A value that is only `true`,
  `false`, `null`, `undefined` or a word like them is not looked for
  (SECURITY.md lists them).
- **`orunmila retention --keep-days N [--yes]`** removes the intake's session logs
  older than N days, each folder whole and only if it verifies, the removal
  written first to a hash-chained `retention.jsonl`. Without `--yes` it only
  lists them; with no period it removes nothing; a session the running intake
  holds is kept. `prune` still trims the old event log and now says so.
- **SECURITY.md says how fast a report is answered:** an acknowledgement within
  7 days, whether the issue is confirmed within 30, and a released fix, or a
  published advisory with a workaround, within 90.
- **Session verdicts, off by default (`orunmila install --with-judge`, or
  `ORUNMILA_JUDGE_LIVE=1` where the intake starts; `--without-judge` turns it
  off).** The switch also turns on the record the judge reads, a baseline at each
  session's start and the session's odù log (`ORUNMILA_OPON_LIVE`, on with the
  judge unless set to `0`). At each
  session's closeout the intake judges every event of its record with fixed
  rules, no model: **Clean**, **Look at this** or **Violation**, each citing its
  rule and the marks behind it, and the session as a whole, **Incomplete**
  whenever evidence was lost. They go to a third hash-chained log,
  `verdict.jsonl`, which `orunmila verify` checks. The rules are
  `.orunmila/rules`, copied into the session's header at its start; the rules
  that guard the record cannot be switched off. `orunmila report --verdicts
  --session ID [--html FILE] [--json]` gives the session report (one offline
  page with `--html`); `orunmila judge --session ID [--rules FILE]` judges again,
  the new verdicts superseding the old, none edited. The law gate's results are
  part of the record: each turn it blocked is a finding, and the session's skip
  rate over 2% another. A session that goes quiet for 30 minutes without ending
  is closed out before the intake lets it go. `ORUNMILA_FEEDBACK_FROM_VERDICTS=1`
  gives the agent the same findings through `orunmila json`.
- **A tamper-evident log, on by default (`ORUNMILA_LOG_GUARD=0` turns it off).** Every log of
  a session (raw, quarantine, odù, verdict) is watched against Orunmila's own
  copy: a change it did not make (an append, a cut, an edit, a delete or move) is
  recorded with the text removed and added, the log is put back, and `verify`
  names each one.
- **A stop no one asked for is recorded.** `orunmila intake stop` now asks over
  the intake's own socket; a stop signal without that ask is recorded in every
  open session (judged Look at this: a logout sends the same signal) and the
  intake exits so its launch agent starts it again, naming the stop in its gap.
- **Large projects, off by default (`ORUNMILA_ASYNC_START=1`).** A new session's
  baseline and the closeout's rescan run off the intake's thread; on a project of
  100,000 files each took about 4 s on it, longer than the agent's hooks wait.
- **Extra folders for the Sentinel, off by default (`ORUNMILA_WATCH_EXTRA`).**
- **`orunmila status` names any hook whose script is missing** (a package
  cache that was cleared) and exits 1.
- **Edit verbs for the claim reader, off by default (`ORUNMILA_EDIT_VERBS=1`):**
  "I edited X", "modified", "rewrote" and "patched" are read as claims of
  changed work.
- **Git, pull-request and CI state in the intake's record, off by default
  (`ORUNMILA_VCS_MARKS=1`).** A `git` or `gh` command's output (its branch and
  commit, each pull request and its state, each set of checks) goes on that
  command's mark in the session's log, as the event log has always kept it.
- **What a command's own text says, off by default (`ORUNMILA_COMMAND_FACTS=1`).**
  Each command's mark in the intake's record names the hosts its command line
  names (`detail.hosts`) and whether a step of it asked for administrator rights
  (`detail.elevated`: `sudo`, `doas`, `su`, `pkexec`, `runas`, `gsudo`); the
  session report names those commands and hosts as plain lines, never a verdict.
  The agent's testimony: a host named is not a host reached. A test run's mark also
  carries its runner's own pass, fail and skip counts (`detail.test_counts`: node:test,
  jest, vitest, mocha, pytest, go, cargo), and the report names them, so "all tests
  pass" beside a skipped test shows. An install command's mark names what npm's
  lock file gained, changed and lost across it (`detail.packages`), each package
  with its version and whether it runs an install script; another manager's lock
  file is named as not read. Where the closeout runs, a tripwire fingerprints the
  files outside the watched folders that run code as you (shell start-up files,
  git and ssh config, `authorized_keys`, `~/.npmrc`, the agents' user hook
  settings, the start-up folders of each OS) at session start (the header's
  `tripwire`) and at the closeout, which names each that changed by path only.
- **A limit on a flooded Sentinel, off by default
  (`ORUNMILA_SENTINEL_MAX_PENDING=N`).** Past N changed paths waiting at once
  under one folder, the rest of the flood is dropped and one gap in each
  session's record says so; the closeout's rescan finds what changed.

### Changed

- **The hooks no longer name the copy that ran `install`.** `orunmila install`
  keeps a copy of the package in Orunmila's home
  (`~/.orunmila/runtime/<version>_<fingerprint>/`, the current one named in
  `~/.orunmila/runtime/current`), and every hook it writes runs that copy
  through one fixed starter, `~/.orunmila/bin/orunmila-start.js`. A hook
  installed through `npx` or `pnpm dlx` used to name a file in that tool's
  cache, and recorded nothing once the cache was cleared. `orunmila status`
  follows the starter to the script it runs and names one that is missing.
  Each hook takes about 20 ms longer (one more Node start). Installing again
  over hooks that already run the starter is an upgrade: the new copy becomes
  current and no hook is added. Hooks an earlier version wrote, which name the
  installed package's own files, are an upgrade too: after `npm install -g
  orunmila`, `orunmila install` moves each of them onto the starter in place
  (its event, matcher and arguments kept) and adds none. Hooks that name a
  different copy of Orunmila are still refused, named, and left untouched.
- **The trail page says what it checked.** With no checked turn, the header,
  the file list, the Report tab, the Dashboard and the claim-vs-record section
  say "Not checked"; before, the page read "looks clean". Turns checked with no
  checkable claim say so. Undisclosed changes make the header "Worth a look".
- **Calmer, one palette, no emoji.** One set of outcome colours across the
  page (the header and the tabs used two), no glow on every dot, and plain
  symbols in place of emoji, which drew differently by operating system.
- **Neutral words.** The Glossary and the copy-paste prompt ask for evidence or
  a fix instead of calling a claim a fabrication; the dropped-ask finding is
  marked as often wrong; the Glossary no longer describes scores the page
  does not show.
- **"Flagged" stays flagged.** It adds linked things only while they stay few;
  on a dense session it showed nearly everything.
- **The judge's report groups repeated findings** with their count (the JSON
  for the agent keeps every one).
- **Nothing Orunmila ships calls an AI service, and its one internet call is
  `orunmila update`'s** (above). The trail
  page's 3D graph, which loaded a library from a CDN, is gone (its 2D graph and
  the other tabs need no network); the model benchmark runner left the package
  (it stays in the repository as `scripts/bench.js`), and the dashboard's
  benchmark section with it. A test reads every shipped file and fails on an
  outgoing network call, a CDN or an AI service.
- **`orunmila html` says that `orunmila report --verdicts --html` replaces it.**
  It still works for this release.
- **The launch agent keeps every intake switch** that was set when it was
  installed (the judge's, the guard's, the extra folders, the off-thread start),
  not only the live flag.

### Fixed

- **`orunmila install --with-judge` alone judged nothing.** The judge reads a
  session's odù log, which the intake wrote only with `ORUNMILA_OPON_LIVE=1`,
  and no page said so: a session judged with the switch on had no verdict and
  `report --verdicts` refused it. The odù log now comes on with the judge
  (`ORUNMILA_OPON_LIVE=1` or `0` still decides where set, and with `0` the
  intake says at its start that the judge has nothing to judge).
- **One session, one set of words on the pages.** The dashboard called a
  session "70% Trustworthy" in green while the trail page said "Untracked
  writes: investigate" and the judge "Violation". The dashboard's card now uses
  the trail page's header words and colours, both pages give the judge's
  verdict from the verdict log with why it can differ from the header (or say
  "Not judged"), and the score's tooltip says what it scores (dropped parts of
  the request are not scored; it said they score 0). The dashboard no longer
  says Orunmila "checks every claim", and marks the dropped-part check as often
  wrong. The Dashboard tab calls an unflagged thing "nothing flagged", not
  "clean", and the Glossary defines the Glove, the Sentinel, both witnesses, an
  odù and the judge's verdicts.
- **A session only in the intake's record no longer reads as empty.** With the
  old event log holding nothing for a session, `trail`, `trail --json`, `html`
  and `json` exited 0 with no turn and no touch. They now read the session log
  (`json` gives the verdicts' feedback: schema 1.0, fewer fields on each claim,
  `docs/SCHEMA.md`) and say so; `status` counts the session logs; `report`,
  `stats`, `feedback` and `laws --check` name the command that reads them.
  A session the old log has is answered exactly as before.
- **The docs said things the tool no longer does.** Every document in the
  repository was read against the tool: the measurement write-up said "MIT
  licensed", that the CLI makes no outbound request and that the 3D tab loads a
  library from a CDN, and quoted a retired precision figure as current; the
  benchmark and corpus pages ran `bin/bench.js` (it is `scripts/bench.js`, and
  Cursor and Antigravity cannot be driven by it); SECURITY.md said "pre-1.0";
  the skills page priced three free skills; the guide said `install` refuses an
  earlier version's hooks (it moves them onto the starter) and left out
  `ORUNMILA_OPON_LIVE`; the spec still named a "separate-user setup in Phase 5",
  which output 1 does not have. Each now says what the tool does.
- **A session report no longer quotes a whole command.** A finding about the
  agent reading Orunmila's record quoted each command whole, so one heredoc
  could fill the report with tens of lines. It now quotes the first line, at
  most 120 characters, and marks the cut; the record keeps every command whole.
- **`orunmila watch` no longer stops about 1.5 seconds after it starts.** On
  its first check for new reports it took the disk watcher's records, which
  belong to no session, for a session, and crashed. Any record of a change
  on disk was enough, and `watch` starts that watcher itself. A report it
  finds half-written, as the Stop hook is still writing it, is named once and
  read again on the next check, instead of ending the command.
- **Five faults Windows showed, fixed.** A claim naming a file with a drive
  letter (`C:/proj/src/a.ts`) lost the drive, so a backed claim read as a
  phantom; a path written with `\` is still read as its file name. On Windows
  every hook payload sent over HTTP was recorded as tampering, since the
  sender was found with tools Windows does not have (`netstat` and `tasklist`
  now). Replay could credit a change on Windows to a session it had lost. After
  a restart, a change to Orunmila's own code outside the project was recorded
  twice. A program squatting on the intake's pipe was written as "taken back"
  before the start failed.
- **The session report's law-gate line on a record an older intake wrote.** It
  said "0 turns checked" when the record holds the gate's checks but not yet
  their results in each event; it now counts them from the record.
- **SECURITY.md no longer describes network use the package does not have.**
  It said the report's 3D Graph tab loaded a script from a CDN and named a
  `bin/bench.js`; neither exists. It now says the pages Orunmila renders load
  nothing from the network, and that the benchmark runner `scripts/bench.js`,
  which can call AI models, is not in the npm package.
- **The file bars in "Files worth a look" draw.** Their fill was an inline
  element, so its width did nothing and no bar ever showed.
- **A secret used as an object key no longer reaches the event log.** Capture
  redacted every string value in an event but copied object keys as written,
  so a tool input such as `{"<token>": "v"}` stored the token. A key is now
  redacted as a string is and the kind it held is listed in `redactions`. A
  redacted key whose name is already taken is named `[REDACTED#2]`, `#3` and
  so on, so no value is overwritten. A log written before this fix can still
  hold such a key: `orunmila log redact` removes it.

## [0.2.4] — 2026-11-23

### Fixed

- **`orunmila --version` prints the version.** It printed the 49-line usage
  text and exited 1. `--version`, `-v` and `version` now print the installed
  version on one line and exit 0. An unknown command still prints the usage and
  exits 1.

### Documented

- **Where Claude Code runs, and the hook paths `orunmila install` writes.**
  The README lists Claude Code in the terminal, VS Code, Antigravity and the
  app, each with how it was checked, and says that each hook is written as
  `node "<path to the installed package>/src/capture/claude-code/<hook>.js"`:
  the hooks work only where that path exists, so install the package globally
  or as a dev dependency rather than through `npx`, and run `orunmila install`
  again on each machine or cloud environment the project's sessions run on.

## [0.2.3] — 2026-11-20

### Fixed

- **A Stop with nothing before it is judged on its own turn (NF62).** Claude
  Code may run the gate before the capture hook, or both at once. On a Stop
  with no prompt or tool call before it, the gate read the turn counter before
  capture advanced it, so it judged the new claim against the previous turn's
  records (a green claim could be cleared by the previous turn's test run) and
  overwrote that turn's record. In one recorded session, 3 of 20 claimed turns
  were judged this way. The gate now finds its turn from the counter and the
  Stop's own final text, whichever hook runs first; when the gate runs first,
  two Stops in a row with the same text and nothing between them still cannot
  be told apart. The turn
  counter's file is also written whole, through a temporary file, so a hook
  reading it while another writes it no longer falls back to turn 1.
- **The Stain Map no longer reads "unverified" as "verified" (NF57).** Its own
  verification words ("verified", "confirmed", "works" and the rest) matched
  inside other words ("unverified", "workstream") and ignored a negation, so
  "Not verified this pass" was graded as a claim that something was verified.
  Each word now counts only as a whole word, and "not", "never", "haven't" and
  the like just before "verified", "confirmed" or "validated" cancel it. Over
  one machine's recorded sessions (1,097 claimed turns), 88 such sentences
  stopped being graded as claims, and no claim was added or changed outcome.
- **An apostrophe inside a word is no longer read as a quote mark (NF31).**
  The gate, the Stain Map and the reader that finds a sentence's targets
  paired the apostrophes of two contractions ("isn't … haven't") as a quoted
  span. That hid the words between them, so "That's done, and the suite passes
  now that it's merged." made no claim, and it turned them into a target the
  receipt law asked a receipt for. All three now share one rule: a single
  quote opens only after a non-letter and closes only before one. Some
  sentences the old rule hid are now judged, so advisories can appear where
  there were none. On the recorded sessions these changes were measured on,
  no turn gained a block, and one false block (the "while it works" sentence
  below) is gone.
- **More honest sentences stay silent, and two real claims are no longer
  missed.** "Nothing got tested." is read like "Nothing was tested.", and a
  "while" frame ("My review follows while it works.") describes a mechanism,
  as "how" and "whether" already did; the Stain Map applies that frame too.
  "Nothing broke, yet the code was tested." and "Nothing regressed, as the
  parser was tested end to end." are claims again. "I haven't tested it this
  session." and "The parser hasn't been tested." are no longer read as claims
  that tests ran (NF61), and "I haven't tested the UI, but all tests pass."
  still counts as one.
- **An honest "I didn't test it" is no longer read as a claim that tests
  passed (NF43).** "I tested none of it.", "Nothing was tested." and "Neither
  branch was tested." were blocked by `no-green-without-command`, and the Stain
  Map scored them as phantom verifications. Both now share one reader for "it
  ran and passed" claims, which knows when a none, nothing or neither cancels a
  "tested"; a real claim beside it ("I tested none of the old paths, but all
  tests pass") still counts. The Stain Map also now sees "The tests and the
  build pass." and "Nothing regressed, so the suite passes.", which it missed,
  and no longer reads "untested" as "tested". A negation the reader does not
  recognise can still read as a claim.
- **The Closeout Gate's block budget now lasts until the user's next message.**
  The budget (two blocks by default) was counted per turn, and each answer the
  agent gives after a block opens a new turn, so it refilled on every Stop: a
  claim the agent reworded after each block was blocked every time (4 Stops of
  4 in the new test). It is now counted per message the user sends. The
  agent's answers after a block share one budget, task notifications and
  sub-agent hand-backs that Claude Code writes into the conversation do not
  refill it, and the user's next message starts a fresh one. Before the
  session's first counted message, all blocks share one budget. The note the
  agent reads when the gate stands down is unchanged.
- **The gate and the claim record no longer take a stale message as the turn's
  claim (N10).** When Claude Code's Stop hook fires, the transcript can still
  end on an earlier message of the turn. Both read their claim from it, so the
  gate could block a turn on a sentence the agent had already replaced, and the
  Stain Map recorded that sentence as the turn's claim. For Claude Code both now
  take the claim from the Stop payload's `last_assistant_message`. If the
  payload has no string value in any of `last_assistant_message`, `claim` or
  `response`, the gate does not judge the turn and records the skip, and the
  claim is recorded empty and marked `claim_unconfirmed`. An empty final
  message is not judged and leaves no such record.
  Other agents still read the transcript: their Stop payloads have not been
  measured.
- **A claim restated unchanged after a block is judged again (P0-4).** The gate
  used to skip a claim identical to the previous turn's, because with the
  transcript read that usually meant stale text. With the claim taken from the
  Stop payload, a repeat is a real restatement, so it no longer gets past the
  gate; the block budget is what stops a loop.

### Added

- **A facts line for the Closeout Gate, off by default
  (`ORUNMILA_FACTS_LINE=1`).** It puts one line from the turn's records above
  the gate's findings, and prints it alone on a judged turn with none: the
  test runs the turn made, with the exit status each record holds, and the
  files changed as each witness saw them (the agent's hooks and the disk
  watcher), with test files named. A heredoc's body is not read as commands
  (a commit message saying "npm test" is not a test run), except where a shell
  or `ssh` is fed it. It reads no prose. The findings below it
  are unchanged, and with the switch off the gate prints exactly what it
  printed before.
- **Strict proof, off by default (`ORUNMILA_STRICT_PROOF=1`), not yet
  recommended.** The green law and the Stain Map then take only a test run that
  proves a pass: a runner step whose recorded status is a pass, with nothing
  after it deciding the line's status (`; echo $?`, `|| true`), and no pipe
  after it unless `set -o pipefail` came first on the line. `laws --check`
  reads the same switch. Measured on one machine's recorded sessions it added
  64 blocks, most of them false, so it stays off; README, "What counts as
  proof".
- **`orunmila laws --check` counts what the live gate did** in the session:
  turns checked, turns skipped (no confirmed final text; older records can
  also show a repeated claim) and turns blocked, read from the gate's own
  records (`live_gate` in `--json`). Skips were recorded before, but nothing
  showed them. It also counts the claimed turns the gate holds no record of
  their own for (`unrecorded`): the gate never ran on them, or a later Stop
  overwrote their record. A claim whose text the log redacted (a secret in it)
  no longer matches its record, so it counts here too.
- **A labelled sentence corpus for both claim readers**, in the repository
  (`test/cases/laws/green-corpus.json`, 71 sentences; not in the npm package).
  The test suite fails if the gate or the Stain Map reads any of them
  differently from its label; `node scripts/laws-corpus.js` lists every
  sentence a change gets wrong.

## [0.2.2] — 2026-11-10 (security patch)

### Security advisory

**Versions 0.1.0 to 0.2.1 store everything they capture in `~/.orunmila/` with
default file permissions, and without redacting secrets.** On most systems that
means any other account on the same computer can read your prompts, file diffs
and command output, including any API key, token or password that passed through
an agent session. Upgrade to 0.2.2, then run `orunmila log redact` (scrub what is
already stored) or `orunmila log delete --yes` (remove it). If you know an agent
saw a credential, rotate it: redaction recognises known formats only.

**What 0.2.2 does not do.** It protects your log from *other accounts* on your
computer. It does not protect it from the agent itself, which runs as your own
user and can still read and change these files. Separating the two is planned for
the next major release. On Windows, file modes do not apply: the owner-only
settings below have no effect there, so the log is only as private as the folder
it sits in.

### Fixed

- **Owner-only storage.** `~/.orunmila/` and every folder Orunmila creates in it
  are now `0700`. The event log, the last-turn report, `log-state.json`, the
  `laws.json` that `orunmila laws --init` writes, command-output sidecars and
  before-snapshots are `0600`. A project `.orunmila/laws.json` is repo config
  and keeps the default mode.
  Reports, law state, the turn counter and archives keep the default file mode
  (usually `0644`) and rely on their `0700` folders. For existing installs, the
  data dir, its top-level folders, the event log, `laws.json`, the last-turn
  report and `log-state.json` are tightened on the next hook run. A custom
  `ORUNMILA_HOME` that already existed is not chmodded (it may be a shared
  folder); those files inside it are.
- **Secrets are redacted at capture.** Known secret formats (AWS, GitHub,
  Anthropic, OpenAI, Stripe, Slack, Google and npm keys; PEM private keys; JWTs;
  bearer tokens; credentials in URLs; upper-case `*_TOKEN=` / `*_PASSWORD=`-style
  assignments) are replaced with `[REDACTED:<kind>]` before an event, a
  command-output sidecar or the before-snapshot of a file being edited is
  written. Both witnesses, the hooks and the Filesystem Sentinel, redact the
  whole text before they cut an excerpt or make a diff. Each event lists the
  kinds removed in a new `redactions` field, never the values. Unknown formats
  can still get through. What redaction misses is listed under "Known limits" in
  `SECURITY.md`.
- **The dashboard listens on `127.0.0.1` only.** `node bin/dashboard.js` used to
  listen on every network interface, which served your session list and reports
  to anyone on the same network. It also now escapes session ids in the page.
- **The blocking law sees the usual ways of claiming a pass (P0-3).**
  `no-green-without-command` used to miss "Tests pass.", "All tests pass.",
  "The test suite passes.", "I ran the tests and they pass." and "It works.".
  It now judges them. It can also block an honest negative such as "I tested
  none of it.".
- **A passing run is no longer read as a failure (P0-5).** Claude Code does not
  report exit codes, and the gate and the Stain Map treated a command with no
  recorded exit code as failed. A "tests pass" claim backed by a real passing
  run could be blocked by the gate, or scored as a phantom verification.

### Added

- **`orunmila log redact`** scrubs everything already stored (event log,
  sidecars, reports, last-turn report) in place. Run it with no agent session
  active.
- **`orunmila log delete [--yes]`** lists what it would delete, and deletes only
  with `--yes`. Your `laws.json` is kept.
- **A one-time warning** when a log from before 0.2.2 exists: from `orunmila
  status`, and in Claude Code once per session, as a message to you (never
  shown to the agent, never blocking). Other agents get it from `orunmila
  status` only. The warning stops once you redact or delete.

### Changed

- **Licence: Apache License 2.0.** 0.2.2 is the first release under Apache 2.0
  (`LICENSE`, `NOTICE`), which adds an explicit patent grant. Versions 0.1.0,
  0.2.0 and 0.2.1 were published under MIT and stay MIT.
- `SECURITY.md` no longer says orunmila makes no network calls of its own. Two
  developer tools ship in `bin/`: `bench.js` runs other agents and can call
  OpenRouter when you invoke it, and `dashboard.js` is a local web server.
- Any command that opens the data dir, read-only ones such as `orunmila status`
  included, now sets the permissions above as it starts, and makes your own
  `laws.json` `0600`. The first 0.2.2 run also writes `log-state.json`.

## [0.2.1] — 2026-10-28

### Fixed

- **The gate no longer judges the previous turn's claim text (P0-4).**
  `runGate` reads its claim from `lastAssistantText(transcript_path)`. When the
  Stop hook fired before the host had flushed that turn's final assistant
  message, it got the PREVIOUS turn's text and judged words the agent had not
  written in the turn being judged — measured in a real session as two
  consecutive turns with byte-identical captured claims, where the gate
  re-flagged a sentence that had already been retracted. It landed on the
  blocking path: an agent that withdrew an unbacked claim could be blocked again
  on the stale text, spending the per-turn block budget on a phantom and leaving
  the gate stood down for anything real that followed. The claim text is now
  fingerprinted onto the turn state and compared against the previous turn's; a
  byte-identical match declines to judge rather than judging stale data, and
  records `skipped_stale_claim` so it stays measurable instead of silent.

## [0.2.0] — 2026-10-28

### Added

- **The law layer and the Closeout Gate** — present in the code since August and
  documented nowhere until now, which made the project's strongest feature
  invisible to anyone reading the repo. It runs on Claude Code's Stop hook and
  can **refuse** a turn whose claims the turn's own evidence does not support —
  the only path in orunmila that can refuse anything, built deliberately outside
  `src/capture/`, which stays observe-only and exits zero forever. Six laws ship
  in `src/laws/packs/canon.json`; two block (`no-green-without-command`,
  `no-grep-as-basis`) and four advise. New commands: `orunmila laws`,
  `laws --check` (replay a law set over a captured session, read-only, before
  trusting it), `laws --init`. Kill switch: `ORUNMILA_LAWS=off`. Per-turn block
  budget (default 2) so a blocking Stop hook can never pin an agent in a
  blocked-respond-blocked loop; when the budget is spent, findings degrade to
  advice **and the exhaustion is recorded**, because a gate that gives up
  silently looks like a pass. Claude Code only.
- **The two lenses, named and separately installable.** orunmila does two
  different jobs and they were not separable in any surface a user touches.
  **The Stain Map** records and reports, never refuses, works on every supported
  agent. **The Closeout Gate** refuses, Claude Code only. Install paths now match
  the shape of the want: `orunmila install` (Stain Map alone),
  `install --with-gate` (both), `install --gate-only` (add the gate to an
  existing Stain Map install). `--with-laws` remains accepted forever as the
  original spelling of `--with-gate` — it is in install instructions people have
  already followed.
- **`orunmila lenses`** — the two lenses side by side on nine axes, plus which
  are installed right now and where their hooks live. Read out of the agent's own
  config rather than anything orunmila wrote down, because the user may have
  edited it by hand.
- **Lens state in `orunmila status`**, which now leads with it and flags
  `ORUNMILA_LAWS=off`: an installed-but-env-disabled gate must not read as
  simply "on".
- **Two corpus cases for the false-green defects below**
  (`test/cases/16`, `test/cases/17`), growing the labelled set from 15 turns /
  32 assertions to 17 / 38.

- **Machine-readable trail (`orunmila trail --json`).** The glove (complete
  trail + lineage) now has a JSON sibling alongside its HTML render — the
  existing `trailForSession` model, serialized. Carries its OWN
  `schema_version` (`1.0`) rather than borrowing the reconciler's `json`
  schema, because the trail is recordings, not verdicts (no
  `claim_type`/`outcome`/`verdict_confidence`). Honors `--out <path>` (else
  stdout); the redaction notice is written to stderr so piped stdout stays
  valid JSON. Reuses the existing render-time privacy pass (home-prefix
  collapse + `.orunmila/redact`).
- **`--facts-only` projection for `trail --json`.** Drops the inferred
  lineage layer — per-turn `edges` and every artifact's `touched_by` /
  `touched` — leaving pure recordings: touches, diffs, commands, exit codes,
  hashes, channels, sub-agent attribution. For a facts-first review that
  wants ground truth with no heuristic edges (the read→write links are a
  turn-scoped guess, honestly stamped `inferred:true`, but a guess). The
  output self-declares its mode via a top-level `facts_only` boolean. One
  boolean, not a field-selection DSL.
- **`sentinel_active` on the trail model.** A top-level boolean saying whether
  the independent disk observer (the Filesystem Sentinel, run via
  `orunmila watch`/`watch-fs`) contributed any writes to THIS session's turn
  windows. `false` means "the sentinel saw nothing here" — the trail is
  hook-announced touches only, with no out-of-band cross-check. Never left
  silent, so absence of independent observation is a visible fact.

### Changed

- **`review/ISSUES.md` is a live dated tracker instead of a one-time review
  write-up.** It had drifted into being actively misleading on a public repo —
  its first entry still announced that the Filesystem Sentinel did not exist,
  months after the sentinel shipped and was measured, and it still reported
  phantom precision at 25% when it measures 100%. Every status is now
  re-derived from the code with the file that closed it cited, and four
  production-found defects are logged that review never saw. `PRD.md` moves to
  `docs/PRD.md` with a banner saying it is design history, not a status report.
- **`CONTRIBUTING.md` no longer points contributors at a gap that is closed.**
  It described extractor precision as "the known-open precision gaps"; precision
  measures 100% on the negative corpus. It now points at the tracker for every
  issue with its status, and names `test/cases/precision/` as the
  false-positive guard to add cases to.
- **README restructured so the two lenses are above the fold**, with a real
  captured-session report as the opening exhibit, a `How accurate is it?` section
  where every figure names the command or file that produced it, and a
  `What it cannot see` section that lists the open defects by id. Both install
  routes — npm and a git clone — are documented, and both carry both lenses.
- **Coverage thresholds now reflect reality and act as a ratchet floor.**
  `.c8rc.json` asked for 97% lines/statements/functions and 86% branches; the
  repo had never met any of them, so `prepublishOnly` blocked every publish.
  `bin/dashboard.js` (30KB of untested local server, caught by the `bin/**`
  glob) joins `bin/bench.js` in `exclude` — on its own it was understating the
  real figure by ~5.5 points — and the thresholds sit just under measured
  (92/92/91/81). The gate now passes on a clean tree, so from here it catches
  regressions instead of failing unconditionally. Raising the floor is tracked
  as P2-7 with the four specific gaps.
- **`install --agent claude-code` now refuses a second registration.** The
  idempotency guard matches an existing orunmila capture hook by script
  BASENAME (`user-prompt-submit.js`, `pre-tool-use.js`, `post-tool-use.js`,
  `stop.js`), not exact command string — so a second install pointing at a
  DIFFERENT copy of orunmila (e.g. `~/.claude/orunmila/...` vs
  `tools/orunmila/...`) is caught. Two live registrations double every
  captured event and double-bump the turn counter (the dual-install
  corruption). Install now refuses with a non-zero exit and prints WHERE the
  existing hook lives, rather than silently adding a duplicate.

### Fixed

- **Three false-green paths in reconciliation**, all found by capturing one
  ordinary session and reading the report rather than trusting the corpus. All
  three made a claim score `verified` when its evidence did not support it —
  the worst direction of error for this tool, because the product is someone
  trusting a green stain.
  - A **compound claim joined by a plain "and" was graded as one unit**, so a
    true half verified a false half: *"I added input validation to login.js and
    wrote a test in login.test.js"* passed on the `login.js` write alone. The
    asymmetry that allowed it — the *ask* side has always split on plain "and";
    only the *claim* side did not. The split is conditional, because splitting
    on every "and" separates *"PR #26"* from *"and shipped it"* and breaks VCS
    provenance: it now fires only when both halves independently pass the
    speech-act gate.
  - A **double-extension basename extracted as its tail**: `login.test.js`
    became the target `test.js`, which every `*.test.js` in a repo shares, so a
    claim about one test file was satisfied by a write to any other. Same class
    as the long-closed P1-2, one level up. `app.config.ts` and `foo.spec.tsx`
    come back whole now too.
  - A **weak target stood in for a named file nothing had touched.** Fixing the
    basename did not fix the verdict: the claim also carried the one-word phrase
    target `test`, which matched `test(` inside the other file's diff, and
    `eventsMentioning` accepted any target of any kind. Weak evidence may now
    corroborate a specific claim; it may never replace it.
- **Trail redaction now scrubs nested touch rows, the `touched` lineage array,
  and `output_path` sidecars.** `redactArtifact` previously redacted
  `touched_by` but left an artifact's nested `touches[]`, its `touched[]`
  array, and every row's `output_path` (an absolute path under
  `~/.orunmila/output/`) raw. The HTML renderer didn't surface those fields so
  the gap was latent; the new `trail --json` serializes them verbatim, which
  would have leaked the OS username / absolute paths into a shareable
  artifact. All three are now path-redacted like every other trail field.

- **Machine-readable JSON emitter (`orunmila json`).** Third sibling of the
  terminal and HTML renderers — same reconciler output, new format.
  schema_version `1.0`. Pure and deterministic: same event log + same options
  → byte-identical JSON, including `generated_at` (derived from the last
  event ts, not wall-clock). Two confidence axes per claim are emitted
  separately — `extraction_confidence` (is this text a claim of this type?)
  and `verdict_confidence` (is the outcome right given correct parse?) —
  because fusing them makes calibration analysis impossible. `claim_type`
  ships `other`-heavy on purpose; building a real classifier is the first
  thing the corpus loop will drive. Reserves a 3-field `label` slot
  (`value`/`source`/`labeled_at`) so an optional labeling pass can land
  later with no schema bump. See [docs/SCHEMA.md](docs/SCHEMA.md).
- **Homeward feedback pipe (`orunmila feedback`).** Writes sanitized
  per-session accuracy cases to a local `.orunmila-feedback/` drop folder.
  Each `cases[i]` entry is a **strict superset of `test/cases/precision/*.json`** —
  the precision corpus the engine already scores against — so contributing
  back is a copy, not a translation. INDEX.md points home with exact
  contribution steps.
- **Corpus ingest (`orunmila feedback-import`).** Walks a drop folder and
  copies `cases[]` entries into `test/cases/precision/` as standalone case
  files. Non-destructive: never overwrites without `--force`; skips and
  reports collisions.
- **Per-field text inclusion (`--include`).** Raw text fields are excluded
  by default — `--include claim_text` opts the claim text in. Reserved
  future opt-ins: `prompt_text`, `diff_hunks`, `command_output_snippets`.
  Sanitization (home-prefix collapse + `.orunmila/redact`) is applied
  per-string-field DURING emit (never post-serialization), on default AND
  opt-in fields. `--include` only gates which raw text fields ENTER the
  pipeline; sanitization always runs on what exits. Keeps "privacy-clean by
  construction" literally true even with `--include claim_text`.
- **`classification_features` breadcrumbs.** When a claim's type can't be
  cleanly resolved, the JSON emitter records the categories, counts, and
  pattern-IDs the extractor already computed (`hedge_count`, `verb_count`,
  `target_kinds`, `pattern_ids: ["claim.assertive_anchor", …]`) — never
  raw substrings from the claim text. This is the privacy guarantee that
  lets the feature signal ship by default without leaking the original
  phrasing when `--include claim_text` is off.
- **Nickname: *The Diviner*.** Adopted across user-facing surfaces —
  README hero, benchmark divinations doc, dashboard intro. Reflects
  Orunmila's role as the Yoruba orisha of wisdom and divination, and the
  tool's role as the one that reads what an agent actually did.
- **Glossary tab in the HTML report.** Every outcome, channel, and metric
  defined in plain English with severity coding, so a first-time viewer
  can self-onboard without leaving the page.
- **3D Graph tab.** Force-directed WebGL view of the session graph with
  hover/click detail, particle-animated edges, and channel/outcome filters.
  Rewritten to use a single-script bundled UMD (no chained loader / no
  context leaks) with a lenient `rendererConfig` for restrictive Chrome
  states.
- **Model personality summaries** in `bench-results/README.md` — one-line
  character reads for every benchmarked model, grounded in the specific
  metric that distinguishes it (ConfIdx, phantom rate, claim volume, etc.).

### Changed

- **Report tab reordered**: stats → copy-paste prompt → findings. The
  prompt is the action; it shouldn't be buried under the findings list.
- **Dashboard default port** is now `3773` (was `3000`). Override with
  `PORT=… node bin/dashboard.js`.
- **"Results" → "Divinations"** in user-facing labels (`bench-results/README.md`,
  main README). Directory paths and code identifiers are unchanged for
  backwards compatibility.

### Fixed

- **3D Graph black-screen / failed-load.** Previous version chained three
  separate `<script>` loads (three.js + OrbitControls + 3d-force-graph),
  with `examples/js/controls/OrbitControls.js` removed in three.js v0.148+,
  so the chain stalled. Loading three.js separately also conflicted with
  the bundled copy inside 3d-force-graph, stacking WebGL contexts until
  Chrome's per-process cap blacked out the canvas. New loader uses a
  single UMD that bundles its own three.js, disposes the previous
  instance on re-render, and falls back to jsdelivr if unpkg fails.

- **Antigravity adapter.** Native support for Google's agent-first IDE —
  `orunmila install --agent antigravity` writes hooks into `.agents/hooks.json`
  (or `~/.gemini/config/hooks.json` with `--global`). Handles the nested
  `toolCall.name` / `toolCall.args` payload and Antigravity's tool names
  (`edit_file`, `view_file`, `run_command`, `grep_search`, `find_by_name`).
- **`orunmila stats` command.** Cross-agent aggregate statistics: reliability
  scores, phantom rates, tool-use profiles, and a side-by-side comparison
  table when multiple agents have been captured.
- **Benchmark runner with full reconciliation.** `bin/bench.js` runs the
  10-task corpus against any agent's CLI with orunmila hooks installed,
  capturing phantoms, phantom verifications, silently dropped asks, wild
  writes, and reliability scores per task — not just pass/fail.
  Supports `--model` for tier comparison (e.g. `--model haiku` vs `--model
  opus`). Results auto-save to `bench-results/` as structured JSON.
  Supports Claude Code and Gemini CLI (`--agent gemini-cli`).

## [0.1.0] — 2026-06-20

First public release. orunmila dye-stains an AI coding agent's session:
it verifies what the agent *claimed* against what it *actually did*, and
renders the result as a colored map of the codebase.

### Added

- **The reconciler (the skeptic).** Reconciles each turn's narrative against
  the event log and stains only the mismatches: `phantom`,
  `phantom_verification`, `silently_dropped`, `undisclosed`, and
  `untracked_write`. Verified claims are stained green.
- **The glove (the complete trail).** The inverse lens on the same event log:
  every read, write, command, and network call is captured and trailed, and
  turn-scoped lineage infers which writes were derived from which reads
  (labelled as a heuristic where the user can see it).
- **Filesystem Sentinel.** An independent on-disk observer that detects writes
  the agent never reported (`untracked_write`), correlated into a turn by a
  time window.
- **Stain-first visual report.** A single self-contained HTML page with
  tabbed Graph / Tree / Timeline / Dashboard views.
- **Claude Code capture hooks** (`install`), with an agent-agnostic registry
  (`src/capture/agents.js`) so new agents are a registry entry, not a fork.
- **`orunmila demo`.** Renders a sample unified report from a scripted session
  with zero setup — the real renderer fed scripted events.
- **Render-time redaction.** Home-prefix collapse on by default, plus an
  opt-in `.orunmila/redact` list, for safely sharing a report.
- Zero runtime dependencies; no network calls by the tool itself; no account
  or API key. Everything stays local in `~/.orunmila/`.

[Unreleased]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kalkudiary-ai/orunmila/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kalkudiary-ai/orunmila/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kalkudiary-ai/orunmila/releases/tag/v0.1.0
