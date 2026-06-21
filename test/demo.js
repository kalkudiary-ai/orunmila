'use strict';

/**
 * test/demo.js
 *
 * Locks in the visual demo (`orunmila demo`). The demo is only useful if it
 * keeps exercising every stain category and every trail channel — that's the
 * whole point of it as a preview. These tests assert the scripted session still
 * produces each finding through the REAL reconcile + trail pipeline (not a
 * mock), and that the demo CLI writes a self-contained HTML file without ever
 * touching the developer's real ~/.orunmila.
 */

const { it, runAll, assert, fs, os, path, tmpHome, rmrf, run } = require('./helpers');

it('seedDemoSession exercises every stain category through the real reconciler', () => {
  const home = tmpHome();
  // Require AFTER ORUNMILA_HOME is set so the eventlog writes into the temp dir.
  const { seedDemoSession } = require('../src/demo/seed');
  const { listSessionReports } = require('../src/reconcile');
  const sessionId = seedDemoSession();
  const reports = listSessionReports(sessionId);
  assert.strictEqual(reports.length, 3, 'three turns reconciled');

  // Aggregate the per-turn summaries so we assert on the whole session.
  const total = reports.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r.summary)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});

  assert.ok(total.verified >= 1, 'a verified claim');
  assert.ok(total.phantom >= 1, 'a phantom claim');
  assert.ok(total.phantom_verification >= 1, 'a phantom verification');
  assert.ok(total.silently_dropped >= 1, 'a silently dropped subtask');
  assert.ok(total.undisclosed_changes >= 1, 'an undisclosed change');
  assert.ok(total.untracked_writes >= 1, 'an untracked (sentinel) write');
  rmrf(home);
});

it('seedDemoSession produces every trail channel + a sub-agent + lineage', () => {
  const home = tmpHome();
  const { seedDemoSession } = require('../src/demo/seed');
  const { trailForSession } = require('../src/trail');
  const sessionId = seedDemoSession();
  const trail = trailForSession(sessionId);

  const channels = new Set(trail.artifacts.flatMap((a) => a.channels));
  for (const ch of ['read', 'write', 'command', 'network', 'disk']) {
    assert.ok(channels.has(ch), `trail has a ${ch} channel`);
  }

  // A network artifact keyed by host, a sub-agent attribution, and at least one
  // inferred lineage edge (read -> write within a turn).
  assert.ok(trail.artifacts.some((a) => a.key === 'nodejs.org'), 'network host artifact');
  const subAgents = new Set(trail.artifacts.flatMap((a) => a.sub_agents));
  assert.ok(subAgents.has('Explore'), 'a sub-agent (Explore) touch is attributed');
  const edges = trail.turns.flatMap((t) => t.edges || []);
  assert.ok(edges.some((e) => e.to === 'src/server.js' && e.inferred), 'an inferred lineage edge into server.js');
  rmrf(home);
});

it('the demo command writes a self-contained HTML report and cleans up its temp log', () => {
  const home = tmpHome(); // the demo must NOT write here — it isolates its own log
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-demoout-'));
  const out = path.join(outDir, 'demo.html');
  const res = run('bin/orunmila.js', { args: ['demo', '--out', out], env: { ORUNMILA_HOME: home } });
  assert.strictEqual(res.status, 0, res.stderr || 'demo exits 0');
  assert.ok(fs.existsSync(out), 'demo HTML written');
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'), 'is an HTML document');
  assert.ok(/untracked/i.test(html), 'untracked stain visible');
  assert.ok(/nodejs\.org/.test(html), 'network host visible');
  assert.ok(/Explore/.test(html), 'sub-agent visible');
  assert.ok(/\(inferred\)/.test(html), 'lineage labelled inferred');

  // The demo isolates its event log in its own temp dir; the real home it was
  // handed must stay empty (no events.jsonl leaked into it).
  assert.ok(!fs.existsSync(path.join(home, 'events.jsonl')), 'demo did not pollute the given home');
  rmrf(home);
  rmrf(outDir);
});

runAll('demo');
