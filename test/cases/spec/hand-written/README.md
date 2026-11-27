# A session record written from `spec/` alone (test 27)

`ses_handwritten_1/` was written on 2026-11-27 by a fresh agent that was given a copy of `spec/` and nothing else: it
never saw Orunmila's code, and it wrote its own Python (standard library only) for RFC 8785, the hash chain and the
schemas (brief v4 line 794; LD365). Every value in it is made up. `test/spec.js` checks that `orunmila verify` finds it
intact, and that one changed byte breaks it.

Its first attempt failed `verify` because the spec did not yet publish the quarantine log's format; that gap and
others it found were closed in SP1b. The gaps it still reported are listed in `review/done-ledger.md` (session
`982aff85`).
