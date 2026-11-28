// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/report.js — the session report (Phase 6 slice BB8; brief v4 lines 688-693; tests 74, 46, 28, 84's and 12/18's
 * report half, 51). Top line first; each finding one sentence naming what both witnesses recorded, or that one recorded
 * nothing; an Incomplete record says which source lost events and for how long; the law gate's turns checked, skipped
 * and blocked, each block its own finding; quarantined marks; the HTML needs no network. Hand-built session logs
 * (test/helpers-opon.js), judged by replay; made-up paths.
 */

const { assert, fs, path, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const { makeLog, M, wall, ns } = require('./helpers-opon');
const { replayFolder } = require('../src/opon/replay');
const { buildReport, renderText, renderHtml, renderJson } = require('../src/babalawo/report');

const recordsOf = (text) => text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
const check = (ms, result, turn = 't1', findings = []) => ({ ...M.claimed(ms, turn), source: 'law_gate', says: 'checked', target: { kind: 'turn', id: turn }, detail: { result, findings } });

/** The report of a hand-built session: its raw log replayed, judged, then reported. */
function reportOf(build, { quarantined = 0, baseline = null } = {}) {
  const base = tmpDir();
  try {
    const s = makeLog(base, {}, { baseline });
    build(s);
    const r = replayFolder(s.dir);
    assert.ok(r.ok && r.verdict, `${r.words} ${r.verdict_words}`);
    const raw = recordsOf(fs.readFileSync(path.join(s.dir, 'raw.jsonl'), 'utf8'));
    return buildReport({ header: raw[0], marks: raw.slice(1), odus: recordsOf(r.odu), verdicts: recordsOf(r.verdict), quarantined, judgedNow: false });
  } finally {
    rmrf(base);
  }
}
/** A turn the agent closed with a claim the law gate passed. */
const closedTurn = (s, ms, result = 'passed', text = 'done') => {
  s.append({ ...M.claimed(ms), detail: { text } });
  s.append(check(ms + 1, result));
  s.append(M.turnEnded(ms + 2));
};

it('Ship item 5 (LD292): `orunmila html` still works for this release and says that `orunmila report --verdicts --html` replaces it', () => {
  const home = tmpDir();
  try {
    const r = run('bin/orunmila.js', { args: ['html'], env: { ORUNMILA_HOME: home } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('orunmila html is replaced by orunmila report --verdicts --session ID --html FILE'), r.stdout);
  } finally {
    rmrf(home);
  }
});

it('line 690: a clean session says "Clean session" on its top line, and how many Clean events are hidden', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append(M.started(10, 'e1', { kind: 'file', path: 'src/a.ts' }));
    s.append(M.edited(100, 'e1', 'src/a.ts'));
    s.append(M.disk(300, 'src/a.ts'));
    s.append(M.read(400, 'r1', 'src/b.ts'));
    closedTurn(s, 900, 'passed', 'I edited src/a.ts.'); // a claim naming the edit, so it is no silent change (line 434)
    s.append(M.tick(10000));
  });
  assert.strictEqual(rep.verdict, 'clean', JSON.stringify(rep.findings));
  const text = renderText(rep);
  assert.strictEqual(text.split('\n')[0], 'Clean session');
  assert.ok(/\d+ Clean events? (is|are) hidden/.test(text), text);
});

it('tests 67 and 74: a hand edit is one Look at this finding whose sentence names both witnesses', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append(M.disk(100, 'src/hand.ts'));
    closedTurn(s, 900);
    s.append(M.tick(10000));
  });
  assert.strictEqual(rep.verdict, 'look_at_this');
  const text = renderText(rep);
  assert.strictEqual(text.split('\n')[0], '1 thing to look at');
  const f = rep.findings.find((x) => x.target === 'src/hand.ts');
  assert.ok(f, JSON.stringify(rep.findings));
  assert.ok(/src\/hand\.ts changed and no agent tool call or command explains it/.test(f.sentence), f.sentence);
  assert.ok(f.sentence.includes('The Glove recorded nothing') && f.sentence.includes('the Sentinel recorded it modified'), f.sentence);
  assert.ok(text.includes(f.sentence), 'the text report carries the same sentence');
});

it('test 19 in the report: a phantom claim is a Violation, its sentence saying what was claimed and what happened', () => {
  // Test 4's setting: a baseline, the session's end and the closeout's rescan, which finds config.ts unchanged (test 73).
  const sweep = (ms, says, detail) => ({ ...M.tick(ms), target: { kind: 'process', name: 'closeout' }, says, detail });
  const rep = reportOf(
    (s) => {
      s.append(M.prompted(0));
      s.append({ ...M.claimed(900), detail: { text: 'I updated config.ts.' } });
      s.append(check(901, 'passed'));
      s.append(M.turnEnded(902));
      s.append(M.sessionEnded(1000));
      s.append(sweep(4100, 'started', {}));
      s.append(sweep(4200, 'exited', { exit_status: 'pass' }));
    },
    { baseline: [{ path: 'config.ts', size: 4, fingerprint: 'sha256:' + 'a'.repeat(64) }] },
  );
  const v = rep.findings.filter((x) => x.verdict === 'violation');
  assert.strictEqual(renderText(rep).split('\n')[0], '1 violation');
  assert.ok(v.length === 1 && /claimed it changed config\.ts, but no change to it was recorded/.test(v[0].sentence), JSON.stringify(rep.findings));
});

it("tests 12, 18, 21 and 84's report half: a gap makes the record Incomplete, saying which source lost events, for how long and who was cut off", () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append({ ...M.gap(5000, 'every mark sent to intake while it was not running'), detail: { lost: 'every mark sent to intake while it was not running', since: { mono_ns: ns(1000), observed_at: wall(1000) }, until: { mono_ns: ns(5000), observed_at: wall(5000) }, sessions: ['ses_replay_test', 'ses_other'] } });
    closedTurn(s, 9000);
    s.append(M.tick(20000));
  });
  assert.strictEqual(rep.verdict, 'incomplete');
  const text = renderText(rep);
  assert.strictEqual(text.split('\n')[0], 'Incomplete record');
  assert.ok(text.includes(`The intake was down from ${wall(1000)} to ${wall(5000)} (4 s)`), text);
  assert.ok(text.includes('the sessions active at its last record: ses_other, ses_replay_test'), text);
});

it('line 692, test 51: the law gate: turns checked, skipped and blocked, each block its own finding, skips counted and Clean', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    closedTurn(s, 100, 'passed');
    s.append(M.prompted(200, 't2'));
    s.append(M.claimed(300, 't2'));
    s.append(check(301, 'blocked', 't2', [{ law: 'no-green-without-command', severity: 'block', quote: 'tests pass' }]));
    s.append(M.turnEnded(302, 't2'));
    s.append(M.tick(10000));
  });
  assert.deepStrictEqual(rep.law_gate, { checked: 2, passed: 1, warned: 0, blocked: 1, skipped: 0, skip_rate: 0 });
  const blocks = rep.findings.filter((f) => f.kind === 'law_gate_block');
  assert.strictEqual(blocks.length, 1);
  assert.ok(/The law gate blocked turn t2: no-green-without-command/.test(blocks[0].sentence), blocks[0].sentence);
  assert.ok(renderText(rep).includes('Law gate: 2 turns checked, 0 skipped, 1 blocked'), renderText(rep));
});

it('line 686: a skip rate over 2% is its own Look at this finding; under it, a count only', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    closedTurn(s, 100, 'skipped');
    s.append(M.tick(10000));
  });
  assert.strictEqual(rep.law_gate.skip_rate, 100);
  assert.ok(rep.findings.some((f) => f.kind === 'law_gate_skips' && /100% of the turns it checked/.test(f.sentence)), JSON.stringify(rep.findings));
  assert.strictEqual(rep.verdict, 'look_at_this', "the report's verdict counts it, beside the session verdict's (LD267)");
});

it('line 434: silent changes are one finding for the session, and it names what both witnesses recorded of each file', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    for (const [i, f] of ['src/a.ts', 'src/b.ts'].entries()) {
      s.append(M.started(10 + i * 100, `e${i}`, { kind: 'file', path: f }));
      s.append(M.edited(50 + i * 100, `e${i}`, f));
      s.append(M.disk(70 + i * 100, f));
    }
    closedTurn(s, 900, 'passed', 'I fixed the bug.');
    s.append(M.tick(10000));
  });
  const silent = rep.findings.filter((f) => f.rule === 'R2');
  assert.strictEqual(silent.length, 1, JSON.stringify(rep.findings));
  assert.ok(/The agent changed 2 files its turns' claims never mention: src\/a\.ts \(The Glove recorded started, modified \(Edit, tool call e0\); the Sentinel recorded it modified\); src\/b\.ts/.test(silent[0].sentence), silent[0].sentence);
});

// F31 (found by DOC6): a finding quoted each command whole, so one heredoc filled the report (R25: about 70 lines).
it('F31: a command a finding quotes is its first line, at most 120 characters, and a cut is marked', () => {
  const heredoc = "cat ~/.orunmila/events.jsonl <<'EOF'\nthe second line of a heredoc\nEOF";
  const long = `wc -l ~/.orunmila/events.jsonl ${'x'.repeat(200)}`;
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    for (const [i, cmd] of [heredoc, long].entries()) {
      s.append(M.started(10 + i * 100, `c${i}`, { kind: 'command', text: cmd }, 'Bash'));
      s.append(M.exited(50 + i * 100, `c${i}`, cmd));
    }
    closedTurn(s, 900);
    s.append(M.tick(10000));
  });
  const look = rep.findings.find((f) => f.rule === 'R25');
  assert.ok(look, JSON.stringify(rep.findings.map((f) => f.rule)));
  assert.ok(look.sentence.includes("it ran `cat ~/.orunmila/events.jsonl <<'EOF' …`"), look.sentence);
  assert.ok(!look.sentence.includes('the second line'), look.sentence);
  assert.ok(look.sentence.includes(`it ran \`${long.slice(0, 120)}…\``), look.sentence);
});

it('test 28: quarantined marks are mentioned', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    closedTurn(s, 100);
    s.append(M.tick(10000));
  }, { quarantined: 2 });
  assert.ok(renderText(rep).includes('2 badly formatted marks were kept in the quarantine log'), renderText(rep));
});

it('test 46: the HTML report bundles everything and loads nothing from the network; the JSON carries the same findings for the agent', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append(M.disk(100, 'src/<b>hand</b>.ts'));
    closedTurn(s, 900);
    s.append(M.tick(10000));
  });
  const html = renderHtml(rep);
  assert.ok(html.startsWith('<!doctype html>') && html.includes('1 thing to look at'), html.slice(0, 200));
  assert.ok(!/(https?:)?\/\/[a-z0-9]/i.test(html.replace(/<!doctype html>/i, '')), 'no address to fetch');
  assert.ok(!/<script\b[^>]*\bsrc=|<link\b|@import|url\(/i.test(html), 'no script, stylesheet or font loaded');
  assert.ok(html.includes('src/&lt;b&gt;hand&lt;/b&gt;.ts') && !html.includes('<b>hand</b>'), "the agent's text is escaped");
  const json = JSON.parse(renderJson(rep));
  assert.deepStrictEqual(json.findings.map((f) => f.sentence), rep.findings.map((f) => f.sentence));
  assert.deepStrictEqual([json.top_line, json.verdict], ['1 thing to look at', 'look_at_this']);
});

it('BB8: `orunmila report --verdicts` prints the report of a session folder, and --html writes a file', () => {
  const base = tmpDir();
  try {
    const s = makeLog(path.join(base, 'sessions'));
    s.append(M.prompted(0));
    s.append(M.disk(100, 'src/hand.ts'));
    closedTurn(s, 900);
    s.append(M.tick(10000));
    const r = replayFolder(s.dir);
    fs.writeFileSync(path.join(s.dir, 'odu.jsonl'), r.odu); // no verdict log: judged now, and the report says so
    const env = { ORUNMILA_HOME: base };
    const out = run('bin/orunmila.js', { args: ['report', '--verdicts', '--session', 'ses_replay_test'], env });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    assert.ok(out.stdout.startsWith('1 thing to look at'), out.stdout);
    assert.ok(out.stdout.includes('judged now: this session has no verdict log'), out.stdout);
    const file = path.join(base, 'r.html');
    const h = run('bin/orunmila.js', { args: ['report', '--verdicts', '--session', 'ses_replay_test', '--html', file], env });
    assert.strictEqual(h.status, 0, h.stdout + h.stderr);
    assert.ok(fs.readFileSync(file, 'utf8').includes('1 thing to look at'));
    const none = run('bin/orunmila.js', { args: ['report', '--verdicts', '--session', 'ses_missing'], env });
    assert.strictEqual(none.status, 1);
  } finally {
    rmrf(base);
  }
});

it('MR3 (LD316): the second line is the witness gap: each change on disk counted by what both witnesses recorded of it, joint, never one rate alone', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append(M.started(10, 'e1', { kind: 'file', path: 'src/a.ts' }));
    s.append(M.edited(50, 'e1', 'src/a.ts')); // the agent's own edit: both witnesses
    s.append(M.disk(70, 'src/a.ts'));
    s.append(M.started(100, 'c1', { kind: 'command', text: 'npm run build' }, 'Bash'));
    s.append(M.disk(150, 'dist/out.js', 'created')); // a command's side effect: the Glove has the command, the Sentinel the change
    s.append(M.exited(200, 'c1', 'npm run build'));
    s.append(M.disk(5000, 'src/hand.ts')); // nothing the agent did explains it: the Sentinel alone
    const outside = { kind: 'file', path: '/elsewhere/notes.md', outside: true }; // as the adapter marks a path outside the project
    s.append(M.started(6000, 'e2', outside));
    s.append({ ...M.edited(6050, 'e2', '/elsewhere/notes.md'), target: outside }); // outside the watched folder: the Glove alone
    s.append(M.started(7000, 'e3', { kind: 'file', path: 'src/c.ts' }));
    s.append(M.edited(7050, 'e3', 'src/c.ts')); // inside, and the Sentinel recorded no change: the Glove alone
    closedTurn(s, 9000, 'passed', 'I edited src/a.ts and /elsewhere/notes.md and ran npm run build.');
    s.append(M.tick(20000));
  });
  assert.deepStrictEqual(
    { ...rep.witnesses, sentence: undefined },
    { changes: 5, both_edit: 1, both_command: 1, both_other: 0, sentinel_only: 1, glove_only_outside: 1, glove_only_inside: 1, neither: 0, sentence: undefined },
    JSON.stringify(rep.witnesses),
  );
  const text = renderText(rep).split('\n');
  assert.strictEqual(
    text[1],
    'What changed on disk: 5 changes. Both witnesses recorded 2: 1 by an agent edit tool, 1 by a command the agent ran (the Glove recorded the command, the Sentinel the change). The Sentinel alone recorded 1: no tool call or command the agent made explains it. The Glove alone recorded 2: 1 outside the folders the Sentinel watches; 1 inside them, where the Sentinel recorded no change.',
  );
  assert.ok(renderHtml(rep).includes(`<p class="gap">${text[1]}</p>`), 'the HTML carries it under the top line');
  assert.deepStrictEqual(JSON.parse(renderJson(rep)).witnesses, rep.witnesses, 'and the agent gets the same counts');
});

it('MR3: a session with no change on disk says that neither witness recorded one, never a rate over nothing', () => {
  const rep = reportOf((s) => {
    s.append(M.prompted(0));
    s.append(M.read(100, 'r1', 'src/b.ts'));
    closedTurn(s, 900);
    s.append(M.tick(10000));
  });
  assert.strictEqual(rep.witnesses.changes, 0);
  assert.strictEqual(renderText(rep).split('\n')[1], 'What changed on disk: neither witness recorded a change to a file in this session.');
});

it('CF1 (LD385): the report names the commands that asked for administrator rights and the hosts the commands named, as plain lines, never a verdict; with none, no line', () => {
  const ex = (ms, call, text, detail, turn = 't1') => ({ ...M.exited(ms, call, text, 'pass', turn), detail: { tool: 'Bash', exit_status: 'pass', output_excerpt: '', ...detail } });
  const rep = buildReport({
    header: { session_id: 's1', agent: { name: 'claude-code' } },
    marks: [ex(10, 'b1', 'sudo apt-get install x', { elevated: true }), ex(20, 'b2', 'curl https://a.example/x', { hosts: ['a.example'] }, 't2'), ex(30, 'b3', 'git push git@github.com:o/r.git', { hosts: ['github.com'] }, 't2')],
    odus: [],
    verdicts: [],
  });
  assert.deepStrictEqual(rep.commands, { elevated: [{ turn: 't1', text: 'sudo apt-get install x', ref: 'b1' }], hosts: ['a.example', 'github.com'], test_counts: [], packages: [], outside: null, completeness: null });
  const text = renderText(rep);
  assert.ok(text.includes('1 command asked for administrator rights (turn t1: `sudo apt-get install x`); what it did with them is outside what Orunmila sees.'), text);
  assert.ok(text.includes("The agent's commands named these hosts: a.example, github.com (named, not proof of contact)."), text);
  assert.strictEqual(rep.verdict, 'clean', 'facts, not verdicts');
  const none = renderText(buildReport({ header: { session_id: 's2', agent: { name: 'claude-code' } }, marks: [], odus: [], verdicts: [] }));
  assert.ok(!none.includes('administrator rights') && !none.includes('named these hosts'), none);
});

it("CF2 (LD385): the report names each test run's own counts, a skip or a failure included, as plain lines, never a verdict; with none, no line", () => {
  const ex = (ms, call, text, detail, turn = 't1') => ({ ...M.exited(ms, call, text, 'pass', turn), detail: { tool: 'Bash', exit_status: 'pass', output_excerpt: '', ...detail } });
  const rep = buildReport({
    header: { session_id: 's1', agent: { name: 'claude-code' } },
    marks: [
      ex(10, 'b1', 'npm test', { test_counts: [{ format: 'node:test', unit: 'tests', passed: 40, failed: 0, skipped: 2, summaries: 1 }] }),
      ex(20, 'b2', 'go test ./...', { test_counts: [{ format: 'go', unit: 'packages', passed: 3, failed: 1, skipped: 0, summaries: 1 }] }, 't2'),
    ],
    odus: [],
    verdicts: [],
  });
  assert.deepStrictEqual(rep.commands.test_counts.map((c) => [c.turn, c.ref, c.counts.length]), [['t1', 'b1', 1], ['t2', 'b2', 1]]);
  const text = renderText(rep);
  assert.ok(text.includes("Test runs, in their runners' own counts: turn t1 `npm test`: 40 passed, 0 failed, 2 skipped (node:test); turn t2 `go test ./...`: 3 packages passed, 1 failed, 0 skipped (go)."), text);
  assert.strictEqual(rep.verdict, 'clean', 'facts, not verdicts');
  const none = renderText(buildReport({ header: { session_id: 's2', agent: { name: 'claude-code' } }, marks: [], odus: [], verdicts: [] }));
  assert.ok(!none.includes("runners' own counts"), none);
});

it("CF3 (LD385): the report names what each install changed in its lock file, the packages with an install script, and a lock it did not read, as plain lines, never a verdict", () => {
  const ex = (ms, call, text, detail, turn = 't1') => ({ ...M.exited(ms, call, text, 'pass', turn), detail: { tool: 'Bash', exit_status: 'pass', output_excerpt: '', ...detail } });
  const rep = buildReport({
    header: { session_id: 's1', agent: { name: 'claude-code' } },
    marks: [
      ex(10, 'b1', 'npm install esbuild', { packages: { manager: 'npm', lock: 'package-lock.json', added: [{ name: 'esbuild', version: '0.19.2', install_script: true }, { name: 'x', version: '1.0.0', install_script: false }], changed: [{ name: 'a', from: '1.0.0', to: '1.0.1', install_script: false }], removed: [], not_read: [] } }),
      ex(20, 'b2', 'yarn add y', { packages: { manager: 'yarn', lock: null, added: [], changed: [], removed: [], not_read: ['yarn.lock'] } }, 't2'),
    ],
    odus: [],
    verdicts: [],
  });
  assert.strictEqual(rep.commands.packages.length, 2);
  const text = renderText(rep);
  assert.ok(text.includes('Packages, from package-lock.json: turn t1 `npm install esbuild`: 2 added, 1 changed, 0 removed; with an install script: esbuild 0.19.2.'), text);
  assert.ok(text.includes('Packages not read: turn t2 `yarn add y`: yarn.lock is not read, so what it installed is not recorded.'), text);
  assert.strictEqual(rep.verdict, 'clean', 'facts, not verdicts');
  const none = renderText(buildReport({ header: { session_id: 's2', agent: { name: 'claude-code' } }, marks: [], odus: [], verdicts: [] }));
  assert.ok(!none.includes('Packages'), none);
});

it("CF4 (LD385): the report names each file outside the watched folders that runs code as you and changed between the session's start and its closeout, by path only, or says none did; never a verdict", () => {
  const end = (detail) => ({ ...M.claimed(90), source: 'process', agent: null, turn: null, says: 'exited', target: { kind: 'process', name: 'closeout' }, detail: { exit_status: 'pass', ...detail } });
  const one = (detail) => buildReport({ header: { session_id: 's1', agent: { name: 'claude-code' } }, marks: [end(detail)], odus: [], verdicts: [] });
  const changed = one({ outside_checked: 24, outside_changed: [{ path: '/home/u/.zshrc', fingerprint_before: 'hmac-sha256:' + 'a'.repeat(64), fingerprint: 'hmac-sha256:' + 'b'.repeat(64) }] });
  assert.deepStrictEqual(changed.commands.outside, { checked: 24, changed: ['/home/u/.zshrc'] });
  assert.ok(renderText(changed).includes("Outside the watched folders, 1 of 24 files and folders that run code as you changed between the session's start and its closeout: /home/u/.zshrc (named by path, never by content; who changed it is not recorded)."), renderText(changed));
  assert.strictEqual(changed.verdict, 'clean', 'facts, not verdicts');
  assert.ok(renderText(one({ outside_checked: 24, outside_changed: [] })).includes("Outside the watched folders, 24 files and folders that run code as you were fingerprinted at the session's start and its closeout; none changed."));
  assert.ok(!renderText(one({})).includes('Outside the watched folders'), 'no tripwire, no line');
});

it("CF5 (LD385): the report says how many of the transcript's tool calls have a mark, and names each that has none, or why the transcript was not read; never a verdict", () => {
  const end = (detail) => ({ ...M.claimed(90), source: 'process', agent: null, turn: null, says: 'exited', target: { kind: 'process', name: 'closeout' }, detail: { exit_status: 'pass', ...detail } });
  const one = (c) => buildReport({ header: { session_id: 's1', agent: { name: 'claude-code' } }, marks: [end({ completeness: c })], odus: [], verdicts: [] });
  const lost = one({ transcript: 'read', calls: 12, unmarked: [{ id: 'toolu_9', tool: 'mcp__db__query' }] });
  assert.deepStrictEqual(lost.commands.completeness, { transcript: 'read', calls: 12, unmarked: [{ id: 'toolu_9', tool: 'mcp__db__query' }] });
  assert.ok(renderText(lost).includes("Completeness: the agent's transcript shows 12 tool calls since the session started; 1 has no mark in this record: mcp__db__query (toolu_9)."), renderText(lost));
  assert.strictEqual(lost.verdict, 'clean', 'facts, not verdicts');
  assert.ok(renderText(one({ transcript: 'read', calls: 12, unmarked: [] })).includes("Completeness: each of the 12 tool calls the agent's transcript shows since the session started has a mark in this record."));
  assert.ok(renderText(one({ transcript: 'none', calls: 0, unmarked: [] })).includes("Completeness: the agent's transcript was not found, so the record was not checked against it."));
  assert.ok(renderText(one({ transcript: 'too_large', calls: 0, unmarked: [] })).includes("Completeness: the agent's transcript is over 128 MiB, so the record was not checked against it."));
});

runAll('report');
