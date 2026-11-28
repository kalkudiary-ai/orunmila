# Security Policy

## Supported versions

Security fixes land on the latest `1.x` release; please upgrade to the newest
version before reporting (`orunmila update`, or your package manager).

| Version | Supported |
|---|---|
| latest `1.x` | yes |
| `0.x` and older | no |

## The tool's security posture

orunmila is designed to minimise its own attack surface:

- **Zero runtime dependencies** — there is no third-party supply chain to
  compromise. The only installed packages are dev tooling (`c8`, `eslint`,
  `prettier`).
- **No network calls in capture or reports** — the hooks, the sentinel and
  every CLI command but `orunmila update` (below) never contact a remote server,
  send no telemetry, and need no account or API key. Everything stays on your machine in `~/.orunmila/`, and the pages
  Orunmila renders load nothing from the network. `bin/dashboard.js` is a local
  web server (loopback only since 0.2.2). The benchmark runner
  `scripts/bench.js` is not in the npm package: in a git clone, when you invoke
  it, it runs AI agents and calls AI models over the internet. The intake
  (`orunmila intake`, sent to by `orunmila install --intake`) listens on a
  Unix socket in `~/.orunmila/intake/` (on Windows, a named pipe with a fresh
  name at each start, published in `~/.orunmila/intake/address`) and on
  `127.0.0.1` only (port 47390, or `ORUNMILA_INTAKE_PORT`), for Claude Code's
  own hooks on the same machine; it contacts nothing. A program running as your
  own account can rewrite that address file, as elsewhere it can replace the
  socket file.
- **One network call, for Orunmila's own updates** — `orunmila update` asks the
  npm registry (`ORUNMILA_REGISTRY`, else npm's own registry setting, else
  `https://registry.npmjs.org`) for the latest version of the `orunmila`
  package and downloads it. The request carries the package's name and nothing
  else: no session data, nothing that identifies you or your machine. The
  download is checked against the integrity hash the registry gives, and the
  new version's self-check must pass before Orunmila switches to it, which it
  does only while no session is being recorded. Each switch, and each refused
  update, is written to the hash-chained `~/.orunmila/updates.jsonl`
  (`orunmila verify --updates`). **It also runs by itself:** `orunmila install`
  turns on a daily check, unless you have already chosen, so at most once a
  day the intake, or where none runs a hook, starts `orunmila update --auto` in
  the background. `orunmila install --without-updates`, or
  `ORUNMILA_UPDATES=0` where the intake and hooks start, turns it off; then
  nothing reaches the network unless you run `orunmila update` yourself.
  Orunmila does not need the internet to work, only to stay up to date. The
  code is one file, `src/runtime/registry.js`, and a test fails if anything
  else in the package reaches the network.
- **Read-mostly** — orunmila observes your agent's activity and renders reports.
  It does not modify your source files. It writes only to its own data dir and
  to report files you explicitly ask for.

The main thing to be aware of: the event log (`~/.orunmila/events.jsonl`) and the
command-output sidecars (`~/.orunmila/output/`) contain the content of your
session — file diffs, command output, prompts. Treat that directory as you would
your shell history.

Since 0.2.2 that directory is readable by your account only (not on Windows; see
"Known limits"), and known secret
formats are redacted before anything is written (see the 0.2.2 advisory in
`CHANGELOG.md`). Two limits: redaction cannot recognise every unknown secret
format, and the agent runs as your own user, so it can read and change these
files. Logs written by 0.1.0 to 0.2.1 are unredacted until you run
`orunmila log redact` or `orunmila log delete --yes`. The HTML report is the artifact you're likely to share, and
it has a render-time redaction pass (home-prefix collapse on by default, plus an
opt-in `.orunmila/redact` list) — see "Sharing a report (privacy)" in `docs/GUIDE.md`.

### Known limits

Orunmila has two witnesses: the hooks (the Glove), which record what the agent
does, and the Filesystem Sentinel, which watches the disk. Both redact the whole
text before they cut an excerpt or make a diff, so Orunmila never splits a
complete key itself.

| Case | Witness | What happens |
|---|---|---|
| A secret in a format Orunmila does not know | Glove and Sentinel | Not redacted. |
| A value from your `.env` file in a format Orunmila does not know | Glove and Sentinel | Not redacted: capture does not use your `.env` values to redact. Run `orunmila leak-check` to find any that were stored. |
| A PEM private key with its END line | Glove and Sentinel | Removed whole. |
| A PEM header with no END line (text that reached Orunmila already cut off, or a header string in source code) | Glove and Sentinel | The header and the next 16384 characters are removed, up to the end of that line but at most 128 more, or up to the next `-----BEGIN `, whichever comes first. If an END line follows later with no `-----BEGIN ` in between, everything up to it is removed. |
| A cut-off key longer than 16384 characters | Glove and Sentinel | Its remaining lines can be written. |
| Key lines with no BEGIN line before them (part of a key printed by a command, or a file holding only key lines) | Glove and Sentinel | Not redacted. |
| PGP blocks, PuTTY `.ppk` files, JWK fields, Kubernetes `data:` values (base64 of a whole PEM) | Glove and Sentinel | Not redacted. |
| An edit made entirely inside redacted text | Glove and Sentinel | The diff is empty, so the edit does not show in the log. The Sentinel's `hash_before` and `hash_after` still differ. |
| A secret the edit removed (it was only in the file's before-state) | Glove | The diff shows `[REDACTED:<kind>]`, but `redactions` does not list that kind, except `url_credentials`, which is found again in its own placeholder. |
| A bare number under a count word: COUNT, LIMIT, MAX, MIN, SIZE, LEN, LENGTH, TTL, TIMEOUT, AGE, SECONDS, MS, DAYS | Glove and Sentinel | Kept, even beside a secret word (`SECRET_MIN=12345678`, `MS_PASSWORD=12345678`). A number under any other secret-style name is removed. |
| Per-session folders created before 0.2.2 | Storage | Keep their mode, inside a parent that is now `0700`. Reports, law state, the turn counter and archives are written with the default file mode, relying on those folders; sidecars and before-snapshots are `0600`. |
| Windows | Storage | File modes do not apply, so the owner-only settings above have no effect: the data dir is only as private as the folder it sits in. |

## Your `.env` values, and the leak check

The trade-off, stated plainly: redaction will sometimes miss a secret.
Orunmila keeps everything on your machine and sends none of it anywhere, so a
missed secret sits with the rest of your session data. The risk is a report or
export you share. Orunmila's part is to say so, and to give you a way to find
one.

`orunmila leak-check`, run in your project folder, reads that folder's own
`.env` and `.env.*` files once (`NAME=value` lines, with `export`, quotes and
backticks; an unquoted value is tried both cut at its first `#` and cut at its
first ` #`), keeps their values in memory, and
searches for each value as written, JSON-escaped, HTML-escaped, and as
Orunmila's report pages escape it in their embedded data, in:

- everything in the data dir (`~/.orunmila`, or `ORUNMILA_HOME`); a symbolic
  link inside it is listed as not read, never followed,
- the report files Orunmila writes into the project folder by default
  (`orunmila-*.html`, `orunmila-*.json` and `.orunmila-feedback/`),
- any file or folder you name with `--path`.

Every file there is read, whatever its name (a `.env.bak` too), except the
`.env` files the values came from. An argument it does not understand
(`--path=file`, a typo) stops it with exit 2 rather than being dropped.

It prints the file, the line and byte offset, the variable's name and the
value's length, never the value. Exit 1 means at least one value was found:
rotate that secret. Exit 2 means nothing was checked, a path could not be read,
or the command failed. Exit 0 means every file was read and no value was found.

What it does not cover:

- It finds only the values it was given. A secret that is not in a top-level
  `.env` file of the folder it runs in (a nested `config/.env.production`, a
  key in your shell profile) is not looked for. `--root <dir>` reads another
  folder's.
- A value of 4 to 7 characters is looked for only under a name that the rule
  redacting `NAME=value` assignments treats as a secret's (such as
  `DB_PASSWORD` or `API_TOKEN`; `APP_PASSPHRASE` is not one), and a shorter
  one never.
- A value that, trimmed and with one pair of `'` or `"` quotes taken off, is
  the whole word `true`, `false`, `yes`, `no`, `on`, `off`, `null`, `none`,
  `nil` or `undefined` (in any case) is never looked for and never used to
  redact, at any length: these words fill ordinary text and code. A real
  `DB_PASSWORD=undefined` is not looked for.
- Some `.env` forms are not read: a name with `.` or `-`, `NAME: value`, a
  quoted value over several lines, and a line ended by a lone carriage return.
- It also reports a value inside a longer word (`pw12` inside `pw123`), so a
  short value can raise a false alarm. An alarm hides nothing.
- Output printed to the terminal or piped (`trail --json`, or `json` without
  `--out`) is not on disk for it to read: pass a saved copy with `--path`.
  Other encodings (base64, URL encoding) are not searched.
- You run it by hand, and nothing runs it automatically, so a leak is found
  when you run the command, not when it happens.

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Report it privately to the maintainer, **KJ**, at **kalkudiary@gmail.com**, or
via GitHub's [private vulnerability reporting](https://github.com/kalkudiary-ai/orunmila/security/advisories/new)
on the repository. Include:

- a description of the issue and its impact,
- the smallest set of steps that reproduces it,
- the version (`orunmila --version` / the `package.json` version) and your OS +
  Node version.

Orunmila has one maintainer, so these are the longest waits, not the usual ones:

- an acknowledgement within 7 days of your report;
- within 30 days, whether the issue is confirmed and what will be done;
- within 90 days, a released fix, or, when a fix takes longer, a published
  advisory with a workaround, on a date agreed with you first.

Once a fix is released, we're happy to credit you in the changelog unless you'd
prefer to stay anonymous.
