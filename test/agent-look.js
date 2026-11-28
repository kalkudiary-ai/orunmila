// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/agent-look.js — the agent's look at Orunmila's record (Phase 6 slice BB12; O's level A, LD261, LD262; brief v4
 * lines 76, 691). An agent tool call that reads Orunmila's home, or runs one of Orunmila's reading commands, is a
 * finding, Look at this, never Violation; the report gives it one calm line for the session naming each look, in the
 * agent's feedback too. Hand-built session logs (test/helpers-opon.js), judged by replay; made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { buildReport, renderText } = require('../src/babalawo/report');
const { loadRules, DEFAULT_RULES } = require('../src/babalawo/rules');

const recordsOf = (text) => text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
const HOME_LOG = '/Users/someone/.orunmila/sessions/ses_x/raw.jsonl';

/** A session with the given tool calls in one turn, judged; returns its verdicts by target and its report. */
function judgedWith(calls) {
  const base = tmpDir();
  try {
    const s = makeLog(base);
    s.append(M.prompted(0));
    calls(s);
    s.append({ ...M.claimed(900), detail: { text: 'I looked around.' } });
    s.append({ ...M.claimed(901), source: 'law_gate', says: 'checked', target: { kind: 'turn', id: 't1' }, detail: { result: 'passed', findings: [] } });
    s.append(M.turnEnded(902));
    s.append(M.tick(10000));
    const r = replayFolder(s.dir);
    assert.ok(r.ok && r.verdict, `${r.words} ${r.verdict_words}`);
    const raw = recordsOf(fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8'));
    const odus = recordsOf(r.odu);
    const verdicts = recordsOf(r.verdict);
    const byTarget = new Map();
    for (const v of verdicts.filter((x) => x.record === 'verdict')) {
      const o = odus.find((x) => x.odu_id === v.odu_id);
      byTarget.set(o.target && (o.target.path || o.target.text), v);
    }
    return { byTarget, rep: buildReport({ header: raw[0], marks: raw.slice(1), odus, verdicts, quarantined: 0 }) };
  } finally {
    rmrf(base);
  }
}
const read = (ms, call, p) => ({ ...M.read(ms, call, p), target: { kind: 'file', path: p, outside: true } });
const ran = (ms, call, text) => [M.started(ms, call, { kind: 'command', text }, 'Bash'), M.exited(ms + 5, call, text)];

it("BB12: the agent's Read of Orunmila's log, and its run of `orunmila trail`, are each Look at this by R25", () => {
  const { byTarget } = judgedWith((s) => {
    s.append(read(100, 'r1', HOME_LOG));
    for (const m of ran(200, 'c1', 'node bin/orunmila.js trail --json --session ses_x')) s.append(m);
    for (const m of ran(300, 'c2', 'cat ~/.orunmila/events.jsonl | wc -l')) s.append(m);
    for (const m of ran(400, 'c3', 'npx orunmila verify /Users/someone/.orunmila/sessions/ses_x')) s.append(m);
  });
  for (const t of [HOME_LOG, 'node bin/orunmila.js trail --json --session ses_x', 'cat ~/.orunmila/events.jsonl | wc -l', 'npx orunmila verify /Users/someone/.orunmila/sessions/ses_x']) {
    const v = byTarget.get(t);
    assert.ok(v, `${t}: ${JSON.stringify([...byTarget.keys()])}`);
    assert.deepStrictEqual([v.verdict, v.rule], ['look_at_this', 'R25'], t);
  }
});

it("BB12: the project's own .orunmila/ settings, a project file, and Orunmila's setup commands are not looks at the record", () => {
  const { byTarget } = judgedWith((s) => {
    s.append(M.read(100, 'r1', '.orunmila/rules'));
    s.append(M.read(150, 'r2', 'src/a.ts'));
    for (const m of ran(200, 'c1', 'orunmila install --intake')) s.append(m);
    for (const m of ran(300, 'c2', 'cat .orunmila/rules')) s.append(m);
    for (const m of ran(400, 'c3', 'echo orunmila trail is a command')) s.append(m);
  });
  for (const [t, v] of byTarget) assert.ok(v.rule !== 'R25', `${t} judged a look`);
});

it('BB12: the report gives the looks one calm line for the session, naming each, and the rules file cannot make them a Violation', () => {
  const { rep } = judgedWith((s) => {
    s.append(read(100, 'r1', HOME_LOG));
    for (const m of ran(200, 'c1', 'orunmila report --verdicts --session ses_x')) s.append(m);
  });
  const looks = rep.findings.filter((f) => f.rule === 'R25');
  assert.strictEqual(looks.length, 1, JSON.stringify(rep.findings));
  assert.strictEqual(looks[0].sentence, `The agent looked at Orunmila's record of its work 2 times: it read ${HOME_LOG} (Read, tool call r1); it ran \`orunmila report --verdicts --session ses_x\` (tool call c1).`);
  assert.ok(renderText(rep).includes(looks[0].sentence));
  const refused = loadRules(DEFAULT_RULES.replace('R25 look_at_this', 'R25 violation'));
  assert.ok(!refused.ok && refused.errors.some((e) => e.includes('R25')), JSON.stringify(refused.errors));
});

runAll('agent-look');
