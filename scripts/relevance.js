// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/relevance.js — R50 (Phase 7; brief v4 lines 760, 817, test 50): a stripped fixture is accepted only if, on
 * O's machine, it gives the same results as the raw recording it came from: the same number and kinds of odù records,
 * conflicts and verdicts. src/opon/fixtures/strip.js `relevance` holds the mark-level half; this is the rest.
 *
 * Each side, raw and stripped, goes the same way: today's events translated to marks (A8), written to a session log of
 * its own in a scratch folder (mono_ns from each mark's own wall time, since today's events have no monotonic clock),
 * closed by the closeout's sweep marks (which seal every group, as the live intake ends a session), replayed
 * (src/opon/replay) and judged (the judge's one interface). A kept file whose text the record carries (a diff)
 * is kept; one the record names by path (a command's output sidecar) is left out on both sides, since the stripped
 * fixture's path is a placeholder. Nothing is printed but counts and kinds: no value of the raw recording.
 *
 *   node scripts/relevance.js --session <id prefix> --fixture <stripped events.jsonl> [--sentinel N] [--events <file>]
 *       raw: the session's events from the event log (default ~/.orunmila/events.jsonl) and the first N Sentinel
 *       rows of its span (EU1's rule); the raw set is stripped again and must equal the fixture byte for byte, so the
 *       raw set compared is exactly the one the fixture came from. Exit 0 when the results are the same.
 *   outcomes(events, sessionId, scratch) -> { odu, verdicts, session, marks }   compare(a, b) -> [differences]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { translateEvents } = require('../src/opon/intake/adapters/events-v0');
const { buildHeader } = require('../src/opon/intake/header');
const { createSessionLog } = require('../src/opon/ledger/session-log');
const { replayFolder } = require('../src/opon/replay');

const sortedJoin = (xs) => xs.slice().sort().join('\n');

/** The kinds of a replay's odù records, conflicts and verdicts, as sorted lists of plain tuples (no values). */
function kindsOf(odu, verdict) {
  const recs = String(odu || '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.record === 'odu');
  // Each witness by its status, verbs, scope and its slots' exit statuses and read kinds (kept by stripping), never
  // their fingerprints, which stripping replaces by design.
  const slots = (s) => (s.slots || []).map((x) => `${x.exit_status || ''}/${x.read_kind === undefined ? '' : x.read_kind}`).join('+');
  const witnesses = (ws) => Object.entries(ws || {}).sort().map(([w, s]) => `${w}:${s.status}:${(s.says || []).join('+')}:${s.scope || ''}:${slots(s)}`).join(',');
  const oduKinds = recs.map((r) => [r.action, r.target && r.target.kind, r.state, r.attribution, r.confidence, witnesses(r.witness_status), r.children.length, r.ceiling, r.amends ? 'amends' : '', r.continues ? 'continues' : ''].join('|'));
  const conflicts = recs.flatMap((r) => (r.conflicts || []).map((c) => [r.action, c.kind || c.type || JSON.stringify(Object.keys(c).sort())].join('|')));
  const vrecs = String(verdict || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const verdicts = vrecs.filter((r) => r.record === 'verdict').map((r) => [r.verdict, r.rule, (r.also || []).slice().sort().join(','), r.hidden].join('|'));
  const session = vrecs.filter((r) => r.record === 'session_verdict').map((r) => [r.verdict, JSON.stringify(r.counts), (r.reasons || []).map((x) => (x && (x.kind || x.rule)) || typeof x).sort().join(',')].join('|'));
  return { odu: oduKinds, conflicts, verdicts, session };
}

/** One side: events -> a session log in `scratch` -> replay and judge -> its kinds. */
function outcomes(events, sessionId, scratch) {
  const { marks, rejects } = translateEvents(events, { sessionId });
  const root = fs.mkdtempSync(path.join(scratch, 'root-'));
  const code = fs.mkdtempSync(path.join(scratch, 'code-'));
  fs.writeFileSync(path.join(code, 'x.js'), '// code\n');
  const t0 = Math.min(...marks.map((m) => Date.parse(m.mark.observed_at)).filter(Number.isFinite));
  const mono = (wall) => String((BigInt(Date.parse(wall) - t0) + 1000n) * 1000000n);
  const header = buildHeader({ sessionId, root, agent: { name: 'claude-code', version: null }, orunmilaVersion: 'relevance', codeRoot: code, lawPacks: {}, hookSettings: [], config: {}, observedAt: new Date(t0).toISOString(), monoNs: String(999n * 1000000n), byproducts: false });
  const dir = path.join(fs.mkdtempSync(path.join(scratch, 'sessions-')), sessionId);
  const log = createSessionLog(dir, header, {});
  let refused = 0;
  let last = 0n;
  for (const { mark, keep } of marks) {
    let ns = BigInt(mono(mark.observed_at));
    if (ns <= last) ns = last + 1n; // one clock, never backwards (marks of one millisecond keep their order)
    last = ns;
    const m = { ...mark, session_id: sessionId, mono_ns: String(ns) };
    const r = log.append(m, keep.filter((k) => typeof k.text === 'string'));
    if (!r.ok) refused++;
  }
  // The closeout's sweep, as the live intake ends every session (K5): its exited mark seals every group (K1). Today's
  // events hold no closeout, so both sides get the same one, after their last mark; no rescan (there is no baseline).
  const at = (n) => ({ observed_at: new Date(t0 + Number((last + BigInt(n) * 1000000n) / 1000000n) - 1000).toISOString(), mono_ns: String(last + BigInt(n) * 1000000n) });
  const sweep = (says, detail, n) => ({ schema_version: 1, session_id: sessionId, source: 'process', agent: null, turn: null, sub_agent: null, ...at(n), target: { kind: 'process', name: 'closeout' }, says, detail, cause_hint: null });
  log.append(sweep('started', {}, 1), []);
  log.append(sweep('exited', { exit_status: 'pass' }, 2), []);
  const rep = replayFolder(dir);
  if (!rep.ok) return { error: rep.words, marks: marks.length, rejects: rejects.length, refused };
  return { ...kindsOf(rep.odu, rep.verdict), marks: marks.length, rejects: rejects.length, refused, verdict_words: rep.verdict_words };
}

/** What differs between two sides' outcomes, in words with counts only. */
function compare(a, b) {
  const out = [];
  if (a.error || b.error) return [`a side did not replay: ${a.error || ''} ${b.error || ''}`.trim()];
  for (const k of ['marks', 'rejects', 'refused']) if (a[k] !== b[k]) out.push(`${k}: ${a[k]} raw, ${b[k]} stripped`);
  for (const k of ['odu', 'conflicts', 'verdicts', 'session']) {
    if (sortedJoin(a[k]) === sortedJoin(b[k])) continue;
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const ca = count(a[k]);
    const cb = count(b[k]);
    const keys = [...new Set([...ca.keys(), ...cb.keys()])].sort();
    out.push(`${k}: ${a[k].length} raw, ${b[k].length} stripped; differing kinds: ${keys.filter((x) => ca.get(x) !== cb.get(x)).length}`);
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (require.main === module) {
  const prefix = arg('--session');
  const fixture = arg('--fixture');
  const n = Number(arg('--sentinel', '60'));
  const file = arg('--events', path.join(os.homedir(), '.orunmila', 'events.jsonl'));
  if (!prefix || !fixture) {
    console.error('usage: node scripts/relevance.js --session <id prefix> --fixture <stripped events.jsonl> [--sentinel N] [--events <file>]');
    process.exit(2);
  }
  const all = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      /* a line that does not parse is not an event */
    }
  }
  const own = all.filter((e) => String(e.session_id || '').startsWith(prefix));
  const first = own.length ? own[0].ts : null;
  const lastTs = own.length ? own[own.length - 1].ts : null;
  let s = 0;
  const raw = all.filter((e) => {
    if (own.includes(e)) return true;
    if (e.source === 'fs-sentinel' && e.ts >= first && e.ts <= lastTs && s < n) return ++s > 0;
    return false;
  });
  const { stripEvents } = require('../src/opon/fixtures/strip');
  const again = stripEvents(raw).events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const same = again === fs.readFileSync(fixture, 'utf8');
  console.log(`raw: ${own.length} session events and ${s} Sentinel rows; stripped again, ${same ? 'identical to the fixture' : 'NOT the fixture'}`);
  if (!same) process.exit(1);
  const stripped = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-relevance-'));
  try {
    const sid = 'relevance-check';
    const a = outcomes(raw, sid, scratch);
    const b = outcomes(stripped, sid, scratch);
    const diff = compare(a, b);
    const line = (x) => `${x.marks} marks (${x.rejects} rejected, ${x.refused} refused), ${x.odu.length} odù records, ${x.conflicts.length} conflicts, ${x.verdicts.length} verdicts, ${x.session.length} session verdict`;
    console.log(`raw:      ${a.error || line(a)}`);
    console.log(`stripped: ${b.error || line(b)}`);
    console.log(diff.length ? `DIFFERENT: ${diff.join('; ')}` : 'the same odù, conflict and verdict results');
    process.exit(diff.length ? 1 : 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { outcomes, compare, kindsOf };
