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
- **No network calls of its own** — the default mode never contacts a remote
  server, sends no telemetry, and needs no account or API key. Everything stays
  on your machine in `~/.orunmila/`.
- **Read-mostly** — orunmila observes your agent's activity and renders reports.
  It does not modify your source files. It writes only to its own data dir and
  to report files you explicitly ask for.

The main thing to be aware of: the event log (`~/.orunmila/events.jsonl`) and the
command-output sidecars (`~/.orunmila/output/`) contain the raw content of your
session — file diffs, command output, prompts. Treat that directory as you would
your shell history. The HTML report is the artifact you're likely to share, and
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
