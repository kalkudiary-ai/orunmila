# Security Policy

## Supported versions

orunmila is pre-1.0. Security fixes land on the latest `0.x` release; please
upgrade to the newest version before reporting.

| Version | Supported |
|---|---|
| latest `0.x` | yes |
| older | no |

## The tool's security posture

orunmila is designed to minimise its own attack surface:

- **Zero runtime dependencies** — there is no third-party supply chain to
  compromise. The only installed packages are dev tooling (`c8`, `eslint`,
  `prettier`).
- **No network calls in capture or reports** — the hooks, the sentinel and the
  CLI never contact a remote server, send no telemetry, and need no account or
  API key. Everything stays on your machine in `~/.orunmila/`. Exceptions, all
  opt-in: the report's 3D Graph tab loads a script from a CDN when you open it;
  the developer benchmark `bin/bench.js` runs other agents and can call
  OpenRouter when you invoke it; `bin/dashboard.js` is a local web server
  (loopback only since 0.2.2).
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
opt-in `.orunmila/redact` list) — see "Sharing a report (privacy)" in the README.

### Known limits

Orunmila has two witnesses: the hooks (the Glove), which record what the agent
does, and the Filesystem Sentinel, which watches the disk. Both redact the whole
text before they cut an excerpt or make a diff, so Orunmila never splits a
complete key itself.

| Case | Witness | What happens |
|---|---|---|
| A secret in a format Orunmila does not know | Glove and Sentinel | Not redacted. |
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

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Report it privately to the maintainer, **KJ**, at **kalkudiary@gmail.com**, or
via GitHub's [private vulnerability reporting](https://github.com/kalkudiary-ai/orunmila/security/advisories/new)
on the repository. Include:

- a description of the issue and its impact,
- the smallest set of steps that reproduces it,
- the version (`orunmila --version` / the `package.json` version) and your OS +
  Node version.

You'll get an acknowledgement as soon as the maintainer sees it. Once a fix is
released, we're happy to credit you in the changelog unless you'd prefer to stay
anonymous.
