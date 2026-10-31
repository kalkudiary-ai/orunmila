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

Since 0.2.2 that directory is readable by your account only, and known secret
formats are redacted before anything is written (see the 0.2.2 advisory in
`CHANGELOG.md`). Two limits: redaction cannot recognise every unknown secret
format, and the agent runs as your own user, so it can read and change these
files. Logs written by 0.1.0 to 0.2.1 are unredacted until you run
`orunmila log redact` or `orunmila log delete --yes`. The HTML report is the artifact you're likely to share, and
it has a render-time redaction pass (home-prefix collapse on by default, plus an
opt-in `.orunmila/redact` list) — see "Sharing a report (privacy)" in the README.

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
