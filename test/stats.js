'use strict';

const { assert, fs, path, tmpHome, rmrf, it, runAll } = require('./helpers');
const stats = require('../src/stats');
const eventlog = require('../src/store/eventlog');

function seedSession(home, sessionId, agent, turns) {
  for (const turn of turns) {
    eventlog.append({
      session_id: sessionId, turn_id: turn.id, agent, type: 'user_prompt', text: turn.prompt || '',
    });
    for (const evt of turn.events || []) {
      eventlog.append(Object.assign({ session_id: sessionId, turn_id: turn.id, agent, source: 'hook' }, evt));
    }
    eventlog.append({ session_id: sessionId, turn_id: turn.id, agent, type: 'turn_end' });

    // Write a report
    const reportDir = path.join(home, 'reports', sessionId);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, `${turn.id}.json`),
      JSON.stringify({
        session_id: sessionId,
        turn_id: turn.id,
        summary: turn.summary,
        claims: [], subtasks: [], undisclosed: [], untracked: [],
      })
    );
  }
}

it('stats: computeStats returns empty agents when no reports exist', () => {
  const home = tmpHome();
  const s = stats.computeStats();
  assert.deepStrictEqual(s.agents, []);
  assert.strictEqual(s.totalSessions, 0);
  rmrf(home);
});

it('stats: computeStats aggregates outcome rates per agent', () => {
  const home = tmpHome();
  seedSession(home, 'S1', 'claude-code', [
    { id: 't1', summary: { verified: 3, phantom: 1, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
    { id: 't2', summary: { verified: 2, phantom: 0, partial: 1, phantom_verification: 0, unverifiable: 0, silently_dropped: 1, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
  ]);
  seedSession(home, 'S2', 'antigravity', [
    { id: 't1', summary: { verified: 1, phantom: 2, partial: 0, phantom_verification: 1, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 1, untracked_writes: 1 } },
  ]);

  const s = stats.computeStats();
  assert.strictEqual(s.agents.length, 2);
  assert.strictEqual(s.totalSessions, 2);
  assert.strictEqual(s.totalTurns, 3);

  const claude = s.agents.find((a) => a.agent === 'claude-code');
  assert.strictEqual(claude.sessions, 1);
  assert.strictEqual(claude.turns, 2);
  assert.strictEqual(claude.outcomes.verified, 5);
  assert.strictEqual(claude.outcomes.phantom, 1);
  assert.strictEqual(claude.outcomes.partial, 1);

  const ag = s.agents.find((a) => a.agent === 'antigravity');
  assert.strictEqual(ag.outcomes.phantom, 2);
  assert.strictEqual(ag.outcomes.phantom_verification, 1);
  assert.strictEqual(ag.outcomes.untracked_writes, 1);
  assert.ok(ag.phantomRate > 0, 'phantom rate should be > 0');

  rmrf(home);
});

it('stats: reliabilityScore computes a weighted percentage', () => {
  assert.strictEqual(stats.reliabilityScore({ verified: 10, partial: 0, phantom: 0, phantom_verification: 0 }), 100);
  assert.strictEqual(stats.reliabilityScore({ verified: 0, partial: 0, phantom: 5, phantom_verification: 0 }), 0);
  assert.strictEqual(stats.reliabilityScore({ verified: 5, partial: 0, phantom: 5, phantom_verification: 0 }), 50);
  assert.strictEqual(stats.reliabilityScore({ verified: 0, partial: 10, phantom: 0, phantom_verification: 0 }), 50);
  assert.strictEqual(stats.reliabilityScore({ verified: 0, partial: 0, phantom: 0, phantom_verification: 0 }), null);
});

it('stats: formatStats produces readable output with comparison table', () => {
  const home = tmpHome();
  seedSession(home, 'S1', 'claude-code', [
    { id: 't1', summary: { verified: 8, phantom: 2, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
  ]);
  seedSession(home, 'S2', 'antigravity', [
    { id: 't1', summary: { verified: 5, phantom: 4, partial: 1, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
  ]);

  const s = stats.computeStats();
  const output = stats.formatStats(s);
  assert.ok(output.includes('claude-code'), 'contains agent name');
  assert.ok(output.includes('antigravity'), 'contains second agent');
  assert.ok(output.includes('comparison'), 'has comparison section');
  assert.ok(output.includes('Reliability'), 'shows reliability header');
  assert.ok(output.includes('Phantom rate'), 'shows phantom rate');

  rmrf(home);
});

it('stats: formatStats handles no data gracefully', () => {
  const home = tmpHome();
  const s = stats.computeStats();
  const output = stats.formatStats(s);
  assert.ok(output.includes('No reconciled sessions'));
  rmrf(home);
});

it('stats: single-agent output has no comparison table', () => {
  const home = tmpHome();
  seedSession(home, 'S1', 'claude-code', [
    { id: 't1', summary: { verified: 5, phantom: 0, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
  ]);
  const s = stats.computeStats();
  const output = stats.formatStats(s);
  assert.ok(!output.includes('comparison'), 'single agent should not have comparison section');
  assert.ok(output.includes('Reliability'));
  rmrf(home);
});

it('stats: handles turns with zero claims gracefully', () => {
  const home = tmpHome();
  seedSession(home, 'S1', 'claude-code', [
    { id: 't1', summary: { verified: 0, phantom: 0, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } },
  ]);
  const s = stats.computeStats();
  assert.strictEqual(s.agents[0].phantomRate, 0);
  assert.strictEqual(s.agents[0].reliability, null);
  rmrf(home);
});

it('stats: tool profile counts event types correctly', () => {
  const home = tmpHome();
  seedSession(home, 'S1', 'claude-code', [
    {
      id: 't1',
      summary: { verified: 1, phantom: 0, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 },
      events: [
        { type: 'file_read', path: '/a.js' },
        { type: 'file_read', path: '/b.js' },
        { type: 'file_write', path: '/c.js' },
        { type: 'command_run', command: 'npm test' },
        { type: 'network_call', host: 'example.com' },
        { type: 'tool_call', tool_name: 'mcp_foo' },
      ],
    },
  ]);
  const s = stats.computeStats();
  const t = s.agents[0].tools;
  assert.strictEqual(t.reads, 2);
  assert.strictEqual(t.writes, 1);
  assert.strictEqual(t.commands, 1);
  assert.strictEqual(t.network, 1);
  assert.strictEqual(t.other, 1);
  rmrf(home);
});

it('stats: corrupt report files are skipped', () => {
  const home = tmpHome();
  const reportDir = path.join(home, 'reports', 'bad-session');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 't1.json'), 'not json');
  fs.writeFileSync(path.join(reportDir, 'readme.txt'), 'skip me');
  const s = stats.computeStats();
  assert.strictEqual(s.agents.length, 0);
  rmrf(home);
});

it('stats: session with no agent field defaults to unknown', () => {
  const home = tmpHome();
  // Write events without an agent field
  eventlog.append({ session_id: 'X1', turn_id: 't1', type: 'user_prompt', text: 'hi' });
  const reportDir = path.join(home, 'reports', 'X1');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 't1.json'),
    JSON.stringify({ session_id: 'X1', turn_id: 't1', summary: { verified: 1, phantom: 0, partial: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 } })
  );
  const s = stats.computeStats();
  assert.strictEqual(s.agents[0].agent, 'unknown');
  rmrf(home);
});

it('stats: report with no summary does not crash', () => {
  const home = tmpHome();
  eventlog.append({ session_id: 'Y1', turn_id: 't1', agent: 'cursor', type: 'turn_end' });
  const reportDir = path.join(home, 'reports', 'Y1');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 't1.json'), JSON.stringify({ session_id: 'Y1', turn_id: 't1' }));
  const s = stats.computeStats();
  assert.strictEqual(s.agents[0].outcomes.verified, 0);
  rmrf(home);
});

it('cli: orunmila stats runs without error', () => {
  const home = tmpHome();
  const { run } = require('./helpers');
  const r = run('bin/orunmila.js', { args: ['stats'], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(r.status, 0);
  assert.ok((r.stdout + r.stderr).includes('No reconciled sessions'));
  rmrf(home);
});

runAll('stats');
