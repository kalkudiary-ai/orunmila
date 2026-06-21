'use strict';

/**
 * test/unit.js
 *
 * In-process unit tests for the library modules that can be driven directly
 * (no child process needed): eventlog, the trail (the glove) + reconcile orchestrators,
 * both renderers, and the targeted branch/line gaps in the reconcile and
 * sentinel helpers. Each test points ORUNMILA_HOME at a throwaway dir so it
 * never touches the real ~/.orunmila.
 *
 * Run: node test/unit.js
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, sleep, it, runAll } = require('./helpers');

// Modules under test. eventlog reads ORUNMILA_HOME lazily (per call), so a
// single require up here is fine as long as we set the env before each call.
const eventlog = require('../src/store/eventlog');
const { trailForSession, sentinelWritesForTurn } = require('../src/trail');
const reconcile = require('../src/reconcile');
const { renderSessionHtml } = require('../src/render/html');
const { renderTurn } = require('../src/render/terminal');
const { buildVizData, renderTrailVisual } = require('../src/render/trail-visual');
const ignore = require('../src/capture/fs-sentinel/ignore');
const hasher = require('../src/capture/fs-sentinel/hasher');
const { createWalker } = require('../src/capture/fs-sentinel/walker');
const { startSentinel } = require('../src/capture/fs-sentinel');
const difftool = require('../src/reconcile/difftool');
const provenance = require('../src/reconcile/provenance');
const { extractClaims } = require('../src/reconcile/claim-extractor');
const { extractSubtasks, extractTargets } = require('../src/reconcile/task-extractor');
const { reconcileTurn } = require('../src/reconcile/matcher');
const { lineageForTurn } = require('../src/trail/lineage');
const turnstate = require('../src/capture/claude-code/turnstate');

function seedEvents(events) {
  for (const e of events) eventlog.append(e);
}

// --- store/eventlog ---------------------------------------------------------

it('eventlog: append stamps ts and round-trips through readAll', () => {
  tmpHome();
  const rec = eventlog.append({ session_id: 's1', turn_id: 't1', type: 'file_read', path: 'a.js' });
  assert.ok(rec.ts, 'append returns a record with a ts');
  const all = eventlog.readAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].path, 'a.js');
});

it('eventlog: readAll returns [] when no log exists yet', () => {
  tmpHome();
  assert.deepStrictEqual(eventlog.readAll(), []);
});

it('eventlog: readAll tolerates a half-written/garbage line', () => {
  tmpHome();
  eventlog.append({ session_id: 's', turn_id: 't1', type: 'file_read' });
  fs.appendFileSync(eventlog.logPath(), 'this is not json\n');
  eventlog.append({ session_id: 's', turn_id: 't2', type: 'file_write' });
  const all = eventlog.readAll();
  assert.strictEqual(all.length, 2, 'garbage line is skipped, valid lines survive');
});

it('eventlog: readSession / readTurn / latestSessionId filter correctly', () => {
  tmpHome();
  seedEvents([
    { session_id: 'A', turn_id: 't1', type: 'file_read' },
    { session_id: 'A', turn_id: 't2', type: 'file_write' },
    { session_id: 'B', turn_id: 't1', type: 'file_read' },
  ]);
  assert.strictEqual(eventlog.readSession('A').length, 2);
  assert.strictEqual(eventlog.readTurn('A', 't2').length, 1);
  assert.strictEqual(eventlog.latestSessionId(), 'B');
});

it('eventlog: latestSessionId is null on an empty log', () => {
  tmpHome();
  assert.strictEqual(eventlog.latestSessionId(), null);
});

it('eventlog: readBetween honors open and closed time windows', () => {
  tmpHome();
  fs.writeFileSync(
    eventlog.logPath(),
    [
      JSON.stringify({ ts: '2026-01-01T00:00:01Z', session_id: 's', type: 'x' }),
      JSON.stringify({ ts: '2026-01-01T00:00:05Z', session_id: 's', type: 'y' }),
      JSON.stringify({ ts: '2026-01-01T00:00:09Z', session_id: 's', type: 'z' }),
      JSON.stringify({ session_id: 's', type: 'no_ts' }),
    ].join('\n') + '\n'
  );
  assert.strictEqual(eventlog.readBetween('2026-01-01T00:00:02Z', '2026-01-01T00:00:06Z').length, 1);
  assert.strictEqual(eventlog.readBetween('2026-01-01T00:00:02Z', null).length, 2, 'null toTs = open end');
  assert.strictEqual(eventlog.readBetween(null, '2026-01-01T00:00:02Z').length, 1, 'null fromTs = open start');
});

it('eventlog: groupByTurn buckets and uses _no_turn for turn-less events', () => {
  const turns = eventlog.groupByTurn([
    { turn_id: 't1', type: 'a' },
    { turn_id: 't1', type: 'b' },
    { type: 'sentinel' },
  ]);
  assert.strictEqual(turns.get('t1').length, 2);
  assert.strictEqual(turns.get('_no_turn').length, 1);
});

it('eventlog: readSentinelWrites returns only fs-sentinel file_write events', () => {
  tmpHome();
  seedEvents([
    { session_id: 'S', turn_id: 't1', source: 'hook', type: 'file_write', path: 'a.js' },
    { session_id: null, turn_id: null, source: 'fs-sentinel', type: 'file_write', path: '/abs/b.js' },
    { session_id: null, turn_id: null, source: 'fs-sentinel', type: 'file_read', path: '/abs/c.js' },
  ]);
  const sw = eventlog.readSentinelWrites();
  assert.strictEqual(sw.length, 1, 'only the sentinel write, not the hook write or sentinel read');
  assert.strictEqual(sw[0].path, '/abs/b.js');
});

it('eventlog: sessionsByRecency orders sessions by their last activity', () => {
  tmpHome();
  seedEvents([
    { session_id: 'A', turn_id: 't1', type: 'x' },
    { session_id: 'B', turn_id: 't1', type: 'x' },
    { session_id: 'A', turn_id: 't2', type: 'x' }, // A active again, after B
  ]);
  assert.deepStrictEqual(eventlog.sessionsByRecency(), ['B', 'A'], 'B last-seen before A');
});

it('eventlog: pruneToRecentSessions keeps the N newest whole sessions and shrinks the log', () => {
  tmpHome();
  seedEvents([
    { session_id: 'old1', turn_id: 't1', type: 'file_read' },
    { session_id: 'old2', turn_id: 't1', type: 'file_read' },
    { session_id: 'keep1', turn_id: 't1', type: 'file_read' },
    { session_id: 'keep2', turn_id: 't1', type: 'file_read' },
  ]);
  const res = eventlog.pruneToRecentSessions(2);
  assert.strictEqual(res.before, 4);
  assert.strictEqual(res.after, 2);
  assert.deepStrictEqual(res.removedSessions.sort(), ['old1', 'old2']);
  // the rewritten log holds only the kept sessions
  const survivors = new Set(eventlog.readAll().map((e) => e.session_id));
  assert.ok(survivors.has('keep1') && survivors.has('keep2'));
  assert.ok(!survivors.has('old1') && !survivors.has('old2'));
});

it('eventlog: pruneToRecentSessions is a no-op when sessions <= keep', () => {
  tmpHome();
  seedEvents([
    { session_id: 'A', turn_id: 't1', type: 'file_read' },
    { session_id: 'B', turn_id: 't1', type: 'file_read' },
  ]);
  const res = eventlog.pruneToRecentSessions(5);
  assert.strictEqual(res.before, 2);
  assert.strictEqual(res.after, 2);
  assert.strictEqual(res.removedSessions.length, 0);
  assert.strictEqual(eventlog.readAll().length, 2, 'log untouched when nothing to prune');
});

// --- reconcile/index (orchestrator + sentinel folding) ----------------------

it('reconcile: reconcileAndPersist writes a report and folds sentinel writes by time window', () => {
  tmpHome();
  seedEvents([
    { ts: '2026-01-01T00:00:01Z', session_id: 'S', turn_id: 't1', type: 'user_prompt', text: 'add login to auth.js' },
    { ts: '2026-01-01T00:00:02Z', session_id: 'S', turn_id: 't1', source: 'hook', type: 'file_write', path: 'auth.js', diff: '+login\n' },
    { ts: '2026-01-01T00:00:03Z', session_id: 'S', turn_id: 't1', type: 'turn_claim', text: 'I added login to auth.js.' },
    // sentinel write with no turn_id, inside the [01,03] window, different file => untracked
    { ts: '2026-01-01T00:00:02.5Z', session_id: null, turn_id: null, source: 'fs-sentinel', type: 'file_write', path: '/abs/sneaky.js', rel_path: 'sneaky.js', diff: '+x\n', change_kind: 'create' },
  ]);
  const report = reconcile.reconcileAndPersist('S', 't1');
  assert.strictEqual(report.untracked.length, 1, 'sentinel write folded in as untracked');
  const loaded = reconcile.loadReport('S', 't1');
  assert.ok(loaded, 'report persisted to disk and reloads');
  assert.strictEqual(loaded.turn_id, 't1');
  const list = reconcile.listSessionReports('S');
  assert.strictEqual(list.length, 1);
});

it('reconcile: loadReport returns null and listSessionReports [] when nothing exists', () => {
  tmpHome();
  assert.strictEqual(reconcile.loadReport('nope', 't1'), null);
  assert.deepStrictEqual(reconcile.listSessionReports('nope'), []);
});

it('reconcile: listSessionReports skips non-JSON files in the reports dir', () => {
  tmpHome();
  seedEvents([{ ts: '2026-01-01T00:00:01Z', session_id: 'S', turn_id: 't1', source: 'hook', type: 'file_write', path: 'x.js', diff: '+a\n' }]);
  reconcile.reconcileAndPersist('S', 't1');
  // Drop a stray non-JSON file beside the report (e.g. .DS_Store) — it must be
  // skipped, not JSON.parse'd, or listSessionReports would throw.
  const dir = path.dirname(reconcile.reportPath('S', 't1'));
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'not json at all');
  const list = reconcile.listSessionReports('S');
  assert.strictEqual(list.length, 1, 'only the .json report is loaded; the stray file is ignored');
});

it('reconcile: reconcileAndPersist handles a turn with no prompt and no claim events', () => {
  tmpHome();
  seedEvents([{ ts: '2026-01-01T00:00:01Z', session_id: 'S', turn_id: 't1', source: 'hook', type: 'file_write', path: 'x.js', diff: '+a\n' }]);
  const report = reconcile.reconcileAndPersist('S', 't1');
  assert.ok(report.summary, 'still produces a summary');
});

it('reconcile: a turn whose events carry no timestamps folds zero sentinel writes', () => {
  // sentinelWritesForTurn bails early when there is no time window to correlate
  // against (no ts on any hook event). reconcileAndPersist must still succeed.
  tmpHome();
  seedEvents([{ session_id: 'NT', turn_id: 't1', source: 'hook', type: 'file_write', path: 'x.js', diff: '+a\n' }]);
  const report = reconcile.reconcileAndPersist('NT', 't1');
  assert.ok(report.summary, 'reconciles with no time window');
  assert.strictEqual((report.untracked || []).length, 0, 'no sentinel writes folded without a window');
});

// --- trail/index (session orchestrator) -------------------------------------

it('trail: trailForSession aggregates artifacts across turns and folds sentinel writes', () => {
  tmpHome();
  seedEvents([
    { ts: '2026-01-01T00:00:01Z', session_id: 'G', turn_id: 't1', type: 'user_prompt', text: 'read a, write b' },
    { ts: '2026-01-01T00:00:02Z', session_id: 'G', turn_id: 't1', source: 'hook', type: 'file_read', path: 'a.js', hash: 'h', bytes: 3 },
    { ts: '2026-01-01T00:00:03Z', session_id: 'G', turn_id: 't1', source: 'hook', type: 'file_write', path: 'b.js', diff: '+x\n' },
    { ts: '2026-01-01T00:00:02.5Z', session_id: null, turn_id: null, source: 'fs-sentinel', type: 'file_write', path: '/abs/b.js', rel_path: 'b.js', diff: '+y\n' },
    { ts: '2026-01-01T00:00:10Z', session_id: 'G', turn_id: 't2', source: 'hook', type: 'file_write', path: 'b.js', diff: '+z\n' },
  ]);
  const trail = trailForSession('G');
  assert.strictEqual(trail.totals.turns, 2);
  const b = trail.artifacts.find((a) => a.path === 'b.js');
  assert.ok(b, 'b.js artifact present');
  assert.strictEqual(b.turn_count, 2, 'b.js touched in both turns');
  assert.ok(b.touch_count >= 2);
});

it('trail: sentinelWritesForTurn returns [] when the hook events carry no timestamps', () => {
  tmpHome();
  assert.deepStrictEqual(sentinelWritesForTurn([{ type: 'file_write' }]), []);
});

// --- render/terminal --------------------------------------------------------

function fullReport() {
  return reconcileTurn({
    promptText: 'fix the bug in payment.js and add rate limiting',
    claimText: 'I fixed payment.js and tested it and it works.',
    turnEvents: [
      { type: 'file_write', path: 'payment.js', diff: '+fix\n', source: 'hook' },
      { type: 'file_write', rel_path: 'sneaky.js', diff: '+x\n', source: 'fs-sentinel', path: '/abs/sneaky.js', change_kind: 'create' },
    ],
  });
}

it('terminal: renderTurn prints untracked, claims, subtasks, undisclosed and a summary', () => {
  const r = { session_id: 'S', turn_id: 't1', ...fullReport() };
  const out = renderTurn(r);
  assert.ok(out.includes('UNTRACKED WRITES'), 'untracked block printed');
  assert.ok(out.includes('Claims:'));
  assert.ok(out.includes('Summary:'));
});

it('terminal: renderTurn handles an empty report (no claims, no extras)', () => {
  const out = renderTurn({
    session_id: 'S',
    turn_id: 't1',
    claims: [],
    subtasks: [],
    undisclosed: [],
    untracked: [],
    summary: { verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 0 },
  });
  assert.ok(out.includes('no checkable claims'));
});

it('terminal: renderTurn renders an unknown outcome via the fallback style', () => {
  const out = renderTurn({
    session_id: 'S',
    turn_id: 't1',
    claims: [{ outcome: 'weird_outcome', claim: { text: 'x' }, causeHints: ['hint-a'] }],
    subtasks: [
      { outcome: 'addressed', task: { text: 'one' } },
      { outcome: 'mystery_ask', task: { text: 'two' } },
    ],
    undisclosed: [{ path: 'u.js' }],
    untracked: [],
    summary: { verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 1 },
  });
  assert.ok(out.includes('weird_outcome'), 'unknown claim outcome falls through to its label');
  assert.ok(out.includes('mystery_ask'), 'unknown subtask outcome falls through');
  assert.ok(out.includes('evidence signals: hint-a'));
});

// --- render/html + trail-visual ---------------------------------------------

it('html: renderSessionHtml (no trail) produces a self-contained document', () => {
  const reports = [{ session_id: 'S', turn_id: 't1', ...fullReport() }];
  const html = renderSessionHtml('S', reports);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('session S'));
  assert.ok(html.includes('file-grid'), 'file grid rendered from stains');
});

it('html: renderSessionHtml with no reports shows the empty-grid message', () => {
  const html = renderSessionHtml('S', []);
  assert.ok(html.includes('No file writes captured yet'));
});

it('html: renderSessionHtml with a trail model renders the tabbed visual + trail', () => {
  tmpHome();
  seedEvents([
    { ts: '2026-01-01T00:00:01Z', session_id: 'H', turn_id: 't1', type: 'user_prompt', text: 'read a, write b, run c, fetch d' },
    { ts: '2026-01-01T00:00:02Z', session_id: 'H', turn_id: 't1', source: 'hook', type: 'file_read', path: 'a.js', hash: 'deadbeefcafe', bytes: 12 },
    { ts: '2026-01-01T00:00:03Z', session_id: 'H', turn_id: 't1', source: 'hook', type: 'file_write', path: 'src/b.js', diff: '+x\n+y\n' },
    { ts: '2026-01-01T00:00:04Z', session_id: 'H', turn_id: 't1', source: 'hook', type: 'command_run', command: 'npm test', exit_code: 0, output_path: '/tmp/out.txt' },
    { ts: '2026-01-01T00:00:05Z', session_id: 'H', turn_id: 't1', source: 'hook', type: 'network_call', channel: 'network', tool_name: 'WebFetch', host: 'example.com', target: 'https://example.com' },
  ]);
  const trail = trailForSession('H');
  const reports = [{ session_id: 'H', turn_id: 't1', ...reconcileTurn({ promptText: 'x', claimText: 'I wrote b.', turnEvents: [] }) }];
  const html = renderSessionHtml('H', reports, trail);
  assert.ok(html.includes('gv-tabs') || html.includes('Graph'), 'tabbed visual block present');
  assert.ok(html.includes('Complete trail'), 'trail section present');
});

it('trail-visual: buildVizData backfills a node referenced only by an edge', () => {
  const trail = {
    session_id: 'B',
    totals: { turns: 1, artifacts: 1, touches: 1 },
    artifacts: [{ key: 'a.js', label: 'a.js', path: 'a.js', channels: ['read'], touch_count: 1, touched_by: [], turn_count: 1 }],
    turns: [{ turn_id: 't1', prompt: '', edges: [{ from: 'a.js', to: 'ghost-only-in-edge', kind: 'file_read->file_write' }], trail: [] }],
  };
  const viz = buildVizData(trail, new Map());
  const ghost = viz.nodes.find((n) => n.key === 'ghost-only-in-edge');
  assert.ok(ghost, 'edge-only node backfilled into the node list');
  assert.strictEqual(ghost.touches, 0);
});

it('trail-visual: buildVizData defaults primaryChannel to tool when channels are absent', () => {
  const trail = {
    session_id: 'C',
    totals: { turns: 1, artifacts: 1, touches: 0 },
    artifacts: [{ key: 'k', label: 'k', path: null, channels: [], touch_count: 0, touched_by: [], turn_count: 1 }],
    turns: [{ turn_id: 't1', prompt: '', edges: [], trail: [] }],
  };
  const viz = buildVizData(trail, null);
  assert.strictEqual(viz.nodes[0].primaryChannel, 'tool');
  assert.ok(renderTrailVisual(viz).length > 0);
});

it('trail-visual: buildVizData + renderTrailVisual cover every channel and a failed touch', () => {
  const trail = {
    session_id: 'V',
    totals: { turns: 1, artifacts: 5, touches: 6 },
    artifacts: [
      { key: 'a.js', label: 'a.js', path: 'a.js', channels: ['read'], touch_count: 1, touched_by: [], turn_count: 1 },
      { key: 'b.js', label: 'b.js', path: 'src/b.js', channels: ['write'], touch_count: 2, touched_by: ['a.js'], turn_count: 1 },
    ],
    turns: [
      {
        turn_id: 't1',
        prompt: 'do things',
        artifacts: [],
        edges: [{ from: 'a.js', to: 'src/b.js', kind: 'file_read->file_write' }],
        trail: [
          { key: 'a.js', type: 'file_read', channel: 'read', path: 'a.js', hash: 'abcd1234', bytes: 4 },
          { key: 'b.js', type: 'file_write', channel: 'write', path: 'src/b.js', diff_volume: 2 },
          { key: 'cmd', type: 'command_run', channel: 'command', command: 'x'.repeat(120), exit_code: 1, failed: true },
          { key: 'h', type: 'network_call', channel: 'network', host: 'example.com', target: 'https://example.com' },
          { key: 'd', type: 'file_write', channel: 'disk', path: 'd.js', source: 'fs-sentinel', output_path: '/t' },
          { key: 'gen', type: 'tool_call', channel: 'tool', target: 'x' },
        ],
      },
    ],
  };
  const stainByKey = new Map([['src/b.js', 'untracked_write']]);
  const viz = buildVizData(trail, stainByKey);
  assert.ok(viz.nodes.length >= 2);
  const out = renderTrailVisual(viz);
  assert.ok(typeof out === 'string' && out.length > 0, 'renders a non-empty block');
});

it('html: a hand-built rich trail exercises every trail-row, badge, meta and edge branch', () => {
  // Feeding a fully-populated trail straight into renderSessionHtml covers the
  // many label/meta ternaries in renderTrailEntry + the file-grid badge + the
  // lineage edges that a minimal captured session never reaches in one report.
  const trail = {
    session_id: 'RICH',
    totals: { turns: 1, artifacts: 6, touches: 7 },
    artifacts: [
      // a file-grid cell WITH a trail overlay (badge + channels + touched_by)
      { key: 'src/b.js', label: 'b.js', path: 'src/b.js', channels: ['write', 'disk'], touch_count: 3, touched_by: ['src/a.js'], turn_count: 1 },
    ],
    turns: [
      {
        turn_id: 't1',
        prompt: 'p'.repeat(300), // > 240 => the prompt-truncation branch
        artifacts: [{ path: 'src/b.js' }],
        edges: [{ from: 'src/a.js', to: 'src/b.js', kind: 'file_read->file_write' }],
        trail: [
          { key: 'src/a.js', channel: 'read', path: 'src/a.js', hash: 'abcd1234ef', bytes: 10 },              // path label + sha + bytes meta
          { key: 'src/b.js', channel: 'write', path: 'src/b.js', diff_volume: 4 },                            // diff_volume meta
          { key: 'd.js', channel: 'disk', path: 'd.js', source: 'fs-sentinel', output_path: '/x.txt' },       // disk-observed + full-output meta
          { key: 'cmd', channel: 'command', command: 'c'.repeat(120), exit_code: 2, failed: true },           // command truncation + exit + FAILED
          { key: 'host', channel: 'network', host: 'example.com', target: 'https://example.com/a' },          // host label
          { key: 'tgt', channel: 'tool', target: 'some-target' },                                             // target label
          { key: 'bare', channel: 'tool' },                                                                   // key fallback label (no path/host/cmd/target)
        ],
      },
    ],
  };
  // One real report so the file grid has a stained cell for src/b.js to overlay.
  tmpHome();
  seedEvents([
    { session_id: 'RICH', turn_id: 't1', type: 'user_prompt', text: 'edit b.js' },
    { session_id: 'RICH', turn_id: 't1', source: 'hook', type: 'file_write', path: 'src/b.js', diff: '+const x = realLogic();\n', failed: false },
    { session_id: 'RICH', turn_id: 't1', type: 'turn_claim', text: 'I edited b.js.' },
  ]);
  const reports = [reconcile.reconcileAndPersist('RICH', 't1')];
  const html = renderSessionHtml('RICH', reports, trail);
  assert.ok(html.includes('trail-row'), 'trail rows rendered');
  assert.ok(html.includes('FAILED'), 'failed command surfaced');
  assert.ok(html.includes('disk-observed'), 'sentinel-source meta surfaced');
  assert.ok(html.includes('full output saved'), 'output_path meta surfaced');
  assert.ok(html.includes('sha abcd1234'), 'hash meta truncated to 8 chars');
  assert.ok(html.includes('example.com'), 'network host labelled');
  assert.ok(html.includes('&rarr;'), 'a lineage edge rendered');
  assert.ok(html.includes('trail-badge'), 'file-grid trail badge rendered');
});

it('html: a Windows backslash path renders just the basename in the grid + lineage', () => {
  // On Windows the sentinel emits rel_path with backslashes (src\foo.js). Every
  // display basename must split on both separators so the label is `foo.js`,
  // not the whole path. This pins the file-grid label and the lineage tooltip
  // ("stained by"), both of which call baseLabel, so the posix-only split can't
  // creep back. The path reaches the grid as an undisclosed write.
  const winPath = 'src\\deep\\win-file.js';
  const srcPath = 'lib\\helpers\\dep.js';
  const reports = [{
    session_id: 'WIN', turn_id: 't1',
    claims: [], subtasks: [], undisclosed: [{ path: winPath }], untracked: [],
    summary: { verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 1, untracked_writes: 0 },
  }];
  const trail = {
    session_id: 'WIN', totals: { turns: 1, artifacts: 1, touches: 2 },
    artifacts: [{ key: winPath, label: 'win-file.js', path: winPath, channels: ['write'], touch_count: 2, touched_by: [srcPath], turn_count: 1 }],
    turns: [{ turn_id: 't1', prompt: 'go', artifacts: [{ path: winPath }],
      edges: [{ from: srcPath, to: winPath, kind: 'file_read->file_write' }], trail: [] }],
  };
  const html = renderSessionHtml('WIN', reports, trail);
  assert.ok(html.includes('>win-file.js<'), 'grid label is the basename, not the full backslash path');
  assert.ok(html.includes('stained by: dep.js'), 'lineage tooltip uses the source basename');
});

// --- render: the <script>-inlining / XSS bug class --------------------------
// Paths, commands and claim text are all attacker-influenceable (the agent can
// be steered to read/write/run anything). A file named `</script><img onerror>`
// must NOT be able to break out of the inlined data blob or the HTML body. These
// tests pin the two defenses: esc() in the markup, and the \u003c JSON-blob
// neutralisation that keeps a `</script>` inside trail data from ending the tag.

const XSS = '</script><img src=x onerror=alert(1)>';

it('html: a malicious file path cannot break out of the HTML body (esc applied)', () => {
  const reports = [{
    session_id: 'X', turn_id: 't1',
    claims: [], subtasks: [], undisclosed: [{ path: XSS }], untracked: [],
    summary: { verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 1, untracked_writes: 0 },
  }];
  const html = renderSessionHtml('X', reports);
  assert.ok(!html.includes(XSS), 'the raw payload never appears verbatim');
  assert.ok(!html.includes('<img src=x'), 'no live <img> tag leaks into the body');
  assert.ok(html.includes('&lt;/script&gt;'), 'the </script> is HTML-escaped');
});

it('html: a malicious session id is escaped in the title and heading', () => {
  const html = renderSessionHtml(XSS, []);
  assert.ok(!html.includes(XSS), 'session id payload is not emitted raw');
  assert.ok(html.includes('&lt;/script&gt;'), 'session id </script> escaped');
});

it('html: a </script> inside trail data is neutralised in the inlined JSON blob', () => {
  // The tabbed visual inlines vizData as a <script> literal. A path containing
  // </script> must be emitted as \u003c so it cannot terminate the script tag.
  tmpHome();
  seedEvents([
    { ts: '2026-01-01T00:00:01Z', session_id: 'XS', turn_id: 't1', type: 'user_prompt', text: 'go' },
    { ts: '2026-01-01T00:00:02Z', session_id: 'XS', turn_id: 't1', source: 'hook', type: 'file_write', path: XSS, diff: '+x\n' },
  ]);
  const trail = trailForSession('XS');
  const reports = [{ session_id: 'XS', turn_id: 't1', ...reconcileTurn({ promptText: 'go', claimText: 'done', turnEvents: [] }) }];
  const html = renderSessionHtml('XS', reports, trail);
  // The closing-tag sequence must never appear except as the page's own real
  // </script> tags. Strip those, then assert no payload </script> survives.
  const withoutRealTags = html.split('</script>').join('');
  assert.ok(!/<\/script/i.test(withoutRealTags), 'no stray </script from trail data');
  assert.ok(html.includes('\\u003c'), 'the < in the blob is escaped to \\u003c');
});

it('terminal: renderTurn passes untrusted text through without throwing', () => {
  // The terminal renderer is plain text (not HTML), so escaping is not its job,
  // but it must never throw on hostile content — it is the default stop-hook view.
  const out = renderTurn({
    session_id: XSS, turn_id: 't1',
    claims: [{ outcome: 'phantom', claim: { text: XSS }, causeHints: [] }],
    subtasks: [], undisclosed: [{ path: XSS }],
    untracked: [{ rel_path: XSS, change_kind: 'create' }],
    summary: { verified: 0, partial: 0, phantom: 1, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 1, untracked_writes: 1 },
  });
  assert.ok(typeof out === 'string' && out.length > 0, 'renders without throwing');
});

// --- fs-sentinel/ignore: branch coverage ------------------------------------

it('ignore: effectiveIgnore applies build toggle, user adds and un-ignores', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'ignore'), '# a comment\nsecret/\n!dist/\n!\n\n');
  const withBuild = ignore.effectiveIgnore(root); // default true
  assert.ok(withBuild.includes('secret/'), 'user add applied');
  assert.ok(!withBuild.map((e) => e.replace(/\/$/, '')).includes('dist'), 'dist/ un-ignored');
  const noBuild = ignore.effectiveIgnore(root, { ignoreBuildOutput: false });
  assert.ok(!noBuild.some((e) => e === 'build/'), 'build dirs omitted when toggled off');
  rmrf(root);
});

it('ignore: readUserOverrides returns empty sets when the file is missing', () => {
  const root = tmpDir();
  assert.deepStrictEqual(ignore.readUserOverrides(root), { add: [], unignore: [] });
  rmrf(root);
});

it('ignore: isIgnored matches dir prefixes, bare names, nested runs; misses lookalikes', () => {
  const list = ['node_modules/', '.git/', 'src/generated/', '.env'];
  assert.ok(ignore.isIgnored('node_modules/foo/bar.js', list), 'dir prefix');
  assert.ok(ignore.isIgnored('node_modules', list), 'the dir itself');
  assert.ok(ignore.isIgnored('a/b/node_modules/x.js', list), 'bare-ish name anywhere via run');
  assert.ok(ignore.isIgnored('pkg/src/generated/x.js', list), 'nested contiguous run');
  assert.ok(ignore.isIgnored('config/.env', list), 'bare filename anywhere');
  assert.ok(!ignore.isIgnored('my-node_modules.txt', list), 'lookalike NOT ignored');
  assert.ok(!ignore.isIgnored('', list), 'empty path not ignored');
  assert.ok(!ignore.isIgnored('src/app.js', list), 'unrelated path not ignored');
});

// --- fs-sentinel/hasher: change descriptors ---------------------------------

it('hasher: store seed/diffAndUpdate reports create, modify, unchanged and delete', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'f.txt');
  const store = hasher.createStore();
  assert.strictEqual(store.diffAndUpdate(f), null, 'missing file we never had = no change');

  fs.writeFileSync(f, 'one\n');
  const created = store.diffAndUpdate(f);
  assert.strictEqual(created.kind, 'create');
  assert.strictEqual(store.diffAndUpdate(f), null, 'touch-without-modify suppressed');

  fs.writeFileSync(f, 'one\ntwo\n');
  assert.strictEqual(store.diffAndUpdate(f).kind, 'modify');

  fs.rmSync(f);
  const del = store.diffAndUpdate(f);
  assert.strictEqual(del.kind, 'delete');
  assert.strictEqual(store.size(), 0, 'deleted file removed from store');
  rmrf(dir);
});

it('hasher: seed snapshots without emitting; get returns the snapshot', () => {
  const dir = tmpDir();
  const f = path.join(dir, 's.txt');
  fs.writeFileSync(f, 'hi');
  const store = hasher.createStore();
  store.seed(f);
  assert.ok(store.get(f), 'seeded snapshot retrievable');
  assert.strictEqual(store.diffAndUpdate(f), null, 'seeded then unchanged = no event');
  assert.strictEqual(store.get(path.join(dir, 'nope')), null, 'get of unknown path = null');
  rmrf(dir);
});

it('hasher: looksBinary flags NUL bytes; snapshot drops content for binary', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'b.bin');
  fs.writeFileSync(f, Buffer.from([1, 2, 0, 3]));
  assert.ok(hasher.looksBinary(Buffer.from([0])));
  assert.ok(!hasher.looksBinary(Buffer.from('plain text')));
  const store = hasher.createStore();
  const change = store.diffAndUpdate(f);
  assert.strictEqual(change.kind, 'create');
  assert.ok(change.binary, 'binary flagged');
  rmrf(dir);
});

// --- fs-sentinel/walker: real fs.watch path ---------------------------------

it('walker: start() seeds existing files and reports new writes via onPath', (/* sync */) => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'b');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'x');

  const seen = [];
  const errors = [];
  const walker = createWalker({
    root: dir,
    isIgnored: (rel) => ignore.isIgnored(rel, ['node_modules/']),
    onPath: (p) => seen.push(p),
    onError: (e) => errors.push(e),
    onWatcherCount: () => {},
  });
  const files = walker.start();
  assert.ok(files.some((f) => f.endsWith('a.js')), 'walk found a.js');
  assert.ok(!files.some((f) => f.includes('node_modules')), 'ignored dir skipped');
  assert.ok(walker.watcherCount() >= 1, 'at least one watcher attached');
  // walk() on a missing dir surfaces an onError, doesn't throw
  walker.walk(path.join(dir, 'does-not-exist'));
  assert.ok(errors.some((e) => /cannot read/.test(e.message)), 'unreadable dir reported via onError');
  walker.close();
  assert.strictEqual(walker.watcherCount(), 0, 'close() drops watchers');
  rmrf(dir);
});

it('walker: attaching to a non-directory surfaces an attach error, not a throw', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  const errors = [];
  const walker = createWalker({
    root: dir,
    isIgnored: () => false,
    onPath: () => {},
    onError: (e) => errors.push(e),
    onWatcherCount: () => {},
  });
  // fs.watch on a regular file behaves like a watcher on some platforms but the
  // attach path is exercised either way; the key contract is "no throw".
  assert.doesNotThrow(() => walker.attach(file));
  walker.close();
  rmrf(dir);
});

it('walker: a real write into a watched dir reaches onPath via the fs.watch callback', async () => {
  const dir = tmpDir();
  const seen = [];
  const walker = createWalker({
    root: dir,
    isIgnored: () => false,
    onPath: (p) => seen.push(p),
    onError: () => {},
    onWatcherCount: () => {},
  });
  walker.start();
  // Drive a real change and await real fs.watch delivery (handle() path).
  fs.writeFileSync(path.join(dir, 'new.js'), 'hello');
  for (let i = 0; i < 20 && !seen.some((p) => p.endsWith('new.js')); i++) await sleep(40);
  walker.close();
  assert.ok(seen.some((p) => p.endsWith('new.js')), 'real write delivered to onPath');
  rmrf(dir);
});

it('walker: a new subdirectory with a file inside gets a watcher and the file is seen', async () => {
  const dir = tmpDir();
  const seen = [];
  const walker = createWalker({
    root: dir,
    isIgnored: () => false,
    onPath: (p) => seen.push(p),
    onError: () => {},
    onWatcherCount: () => {},
  });
  walker.start();
  // Create a brand-new subdir + file: handle() must stat the dir, attach, and
  // walk it so the inner file is reported even though it landed pre-watcher.
  const sub = path.join(dir, 'fresh');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'inner.js'), 'x');
  for (let i = 0; i < 25 && !seen.some((p) => p.endsWith('inner.js')); i++) await sleep(40);
  walker.close();
  assert.ok(walker.watcherCount() === 0, 'closed cleanly');
  rmrf(dir);
});

// --- fs-sentinel/index: startSentinel wiring --------------------------------

it('sentinel: startSentinel baselines files, ignores its own log, and stop() is clean', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'keep.js'), 'v1');
  const logs = [];
  const s = startSentinel({ root: dir, log: (m) => logs.push(m) });
  assert.strictEqual(s.root, path.resolve(dir));
  assert.ok(logs.some((l) => l.includes('watching')), 'startup log emitted');
  assert.ok(s.ignoreList.includes('.orunmila/'), 'own dir is ignored');
  s.stop();
  rmrf(dir);
});

it('sentinel: the default onError logs to stderr without a custom log opt', () => {
  const dir = tmpDir();
  // No `log` opt => the default stderr logger is used. Force an error through it
  // by walking a path that cannot be read, which the walker reports via onError.
  const errs = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  try {
    const s = startSentinel({ root: dir }); // default log path active
    s.walker.walk(path.join(dir, 'nope-not-here'));
    s.stop();
  } finally {
    process.stderr.write = realWrite;
  }
  assert.ok(errs.some((m) => m.includes('[fs-sentinel]')), 'default logger wrote to stderr');
  rmrf(dir);
});

// --- capture/turnstate ------------------------------------------------------

it('turnstate: currentTurn defaults to 1, bumpTurn increments and persists', () => {
  tmpHome();
  assert.strictEqual(turnstate.currentTurn('S'), 1, 'fresh session starts at turn 1');
  assert.strictEqual(turnstate.bumpTurn('S'), 2, 'bump returns the next turn');
  assert.strictEqual(turnstate.turnId('S'), 't2', 'turnId reflects the bumped value');
});

it('turnstate: a missing sessionId is bucketed under "unknown"', () => {
  tmpHome();
  // exercises the `sessionId || "unknown"` branch in statePath()
  assert.strictEqual(turnstate.bumpTurn(), 2);
  assert.strictEqual(turnstate.turnId(), 't2');
});

it('turnstate: a state file with no turn field falls back to 1', () => {
  const home = tmpHome();
  const slot = path.join(home, 'cache', 'S');
  fs.mkdirSync(slot, { recursive: true });
  // turn.json present but with no `turn` key => the `|| 1` fallback in currentTurn
  fs.writeFileSync(path.join(slot, 'turn.json'), JSON.stringify({ other: true }));
  assert.strictEqual(turnstate.currentTurn('S'), 1);
});

// --- reconcile/difftool -----------------------------------------------------

it('difftool: unifiedDiff shows added lines; substanceStats separates logic from comments', () => {
  const diff = difftool.unifiedDiff('', 'const x = 1;\n// a comment\n\n', 'f.js');
  assert.ok(diff.includes('const x = 1;'), 'diff contains the added logic line');
  const stats = difftool.substanceStats(diff);
  assert.ok(stats.added >= 2);
  assert.strictEqual(stats.addedSubstance, 1, 'only the real-logic line counts as substance');
  assert.deepStrictEqual(difftool.substanceStats(''), { added: 0, removed: 0, addedSubstance: 0 });
});

it('difftool: substanceStats counts removed lines', () => {
  const stats = difftool.substanceStats('--- a\n+++ b\n-gone\n+kept = 1;\n');
  assert.strictEqual(stats.removed, 1);
  assert.strictEqual(stats.addedSubstance, 1);
});

// --- reconcile/provenance: branch gaps --------------------------------------

it('provenance: verification claim with a passing test => receipt_matches', () => {
  const r = provenance.classify(
    { verificationClaim: true, targets: [] },
    [{ type: 'command_run', command: 'npm test', exit_code: 0, failed: false }]
  );
  assert.strictEqual(r.provenance, 'receipt_matches');
});

it('provenance: verification claim with a failing test => disregarded_failure', () => {
  const r = provenance.classify(
    { verificationClaim: true, targets: [] },
    [{ type: 'command_run', command: 'npm test', exit_code: 1, failed: true }]
  );
  assert.strictEqual(r.provenance, 'disregarded_failure');
  assert.ok(r.causeHints.includes('error-in-context'));
});

it('provenance: verification claim with no test command => not_sent / no-verification-attempted', () => {
  const r = provenance.classify({ verificationClaim: true, targets: [] }, []);
  assert.strictEqual(r.provenance, 'not_sent');
  assert.ok(r.causeHints.includes('no-verification-attempted'));
});

it('provenance: a matched-but-failed action (non-verification) => disregarded_failure', () => {
  const r = provenance.classify(
    { targets: [{ kind: 'path', value: 'auth.js' }] },
    [{ type: 'file_write', path: 'auth.js', diff: '+x\n', failed: true }]
  );
  assert.strictEqual(r.provenance, 'disregarded_failure');
});

it('provenance: hedged claim with no match => not_sent / vague-hedge', () => {
  const r = provenance.classify(
    { targets: [{ kind: 'path', value: 'auth.js' }], hedged: true },
    [{ type: 'file_write', path: 'other.js', diff: '+x\n' }]
  );
  assert.strictEqual(r.provenance, 'not_sent');
  assert.ok(r.causeHints.includes('vague-hedge'));
});

it('provenance: targetMatchesEvent handles symbol, phrase, literal and the legacy keyword shim', () => {
  const symbolEv = { type: 'file_write', path: 'x.js', diff: '+function getUser(){}\n' };
  assert.ok(provenance.targetMatchesEvent({ kind: 'symbol', value: 'getuser' }, symbolEv));
  assert.ok(provenance.targetMatchesEvent({ kind: 'phrase', value: 'user auth' }, { type: 'file_write', diff: '+user auth flow\n', path: 'a' }));
  assert.ok(provenance.targetMatchesEvent({ kind: 'literal', value: 'todo' }, { type: 'command_run', command: 'echo todo' }));
  assert.ok(!provenance.targetMatchesEvent({ kind: 'phrase', value: '' }, { type: 'file_write', diff: '+x\n' }), 'empty phrase matches nothing');
  assert.ok(!provenance.targetMatchesEvent({ kind: 'unknown' }, symbolEv), 'unknown kind => false');
  // legacy keywords path through targetsOf
  assert.deepStrictEqual(
    provenance.targetsOf({ keywords: ['Foo'] }),
    [{ kind: 'symbol', value: 'foo' }]
  );
  assert.deepStrictEqual(provenance.targetsOf({}), []);
});

it('provenance: tool-blob matching catches a symbol inside an MCP tool input', () => {
  const ev = { type: 'tool_call', tool_name: 'mcp__db__query', input: { sql: 'select getUser' } };
  assert.ok(provenance.targetMatchesEvent({ kind: 'symbol', value: 'getuser' }, ev));
});

// --- claim-extractor / task-extractor: line gaps ----------------------------

it('claim-extractor: empty input => [], and anaphoric verification inherits prior targets', () => {
  assert.deepStrictEqual(extractClaims(''), []);
  assert.deepStrictEqual(extractClaims('   '), []);
  const claims = extractClaims('I added login to auth.js. I tested it and it works.');
  const verif = claims.find((c) => c.verificationClaim);
  assert.ok(verif, 'second sentence flagged as a verification claim');
  assert.ok(verif.targets.length > 0, 'inherited the auth.js target from the prior claim');
  assert.ok(verif.inheritedTargets, 'inheritance flagged');
});

it('claim-extractor: a sentence with no verb, no target and no verification is dropped', () => {
  const claims = extractClaims('The weather today is quite nice outside.');
  assert.strictEqual(claims.length, 0);
});

it('task-extractor: empty prompt => [], bullets win over comma-splitting', () => {
  assert.deepStrictEqual(extractSubtasks(''), []);
  const bullets = extractSubtasks('- add login\n- add logout\n- add rate limiting');
  assert.strictEqual(bullets.length, 3, 'three bullet subtasks');
  const commas = extractSubtasks('add the parser, write the tests, and update the docs');
  assert.ok(commas.length >= 3, 'comma + and splitting yields all parts');
});

it('task-extractor: extractTargets pulls paths, symbols, literals, well-known files and phrases', () => {
  const t = extractTargets('implement user authentication in `src/auth.js` and the README with getUserToken and rate_limit and "exact str"');
  const kinds = new Set(t.map((x) => x.kind));
  assert.ok(kinds.has('path'), 'path target');
  assert.ok(kinds.has('symbol'), 'symbol target');
  assert.ok(kinds.has('literal'), 'literal target');
  assert.ok(kinds.has('phrase'), 'phrase target');
  assert.ok(t.some((x) => x.value === 'readme'), 'well-known README captured');
  assert.deepStrictEqual(extractTargets(''), []);
});

// --- matcher: remaining branches --------------------------------------------

it('matcher: an unverifiable ask (no extractable target) is not silently_dropped', () => {
  const r = reconcileTurn({ promptText: 'please be nice', claimText: '', turnEvents: [] });
  assert.ok(r.subtasks.every((s) => s.outcome !== 'silently_dropped'), 'vague ask is unverifiable, not dropped');
});

it('matcher: a subtask mentioned in the claim but unbacked reads as acknowledged_incomplete', () => {
  const r = reconcileTurn({
    promptText: 'add caching to dashboard.js',
    claimText: 'I started on dashboard.js but did not finish caching.',
    turnEvents: [],
  });
  const ack = r.subtasks.find((s) => s.outcome === 'acknowledged_incomplete');
  assert.ok(ack, 'claim-mentioned-but-unbacked => acknowledged_incomplete');
});

it('matcher: a partial (scaffolding-only) write is graded partial, not verified', () => {
  const r = reconcileTurn({
    promptText: 'implement the parser in parser.js',
    claimText: 'I implemented the parser in parser.js.',
    turnEvents: [{ type: 'file_write', path: 'parser.js', diff: '+function parse(){\n+  return null;\n+}\n', source: 'hook' }],
  });
  assert.ok(r.claims.some((c) => c.outcome === 'partial' || c.outcome === 'verified'));
});

it('matcher: an undisclosed write (no claim/subtask covers it) is flagged scope-creep', () => {
  const r = reconcileTurn({
    promptText: 'update dashboard.js',
    claimText: 'I updated dashboard.js.',
    turnEvents: [
      { type: 'file_write', path: 'dashboard.js', diff: '+a\n', source: 'hook' },
      { type: 'file_write', path: 'totally-unrelated.js', diff: '+b\n', source: 'hook' },
    ],
  });
  assert.ok(r.undisclosed.some((u) => u.path === 'totally-unrelated.js'));
  assert.ok(!r.undisclosed.some((u) => u.path === 'dashboard.js'));
});

// --- lineage: remaining artifactKey / channel / sort branches ---------------

it('lineage: a generic tool_call keys by tool name and uses the tool channel', () => {
  const model = lineageForTurn([
    { type: 'tool_call', tool_name: 'mcp__db__query', input: {}, ts: '2026-01-01T00:00:01Z' },
  ]);
  const art = model.artifacts.find((a) => a.key === 'tool:mcp__db__query');
  assert.ok(art, 'tool_call keyed by tool name');
  assert.ok(art.channels.includes('tool'), 'falls back to the tool channel');
});

it('lineage: an event with no path/host/command/tool falls back to an event-typed key', () => {
  const model = lineageForTurn([{ type: 'tool_result', ts: '2026-01-01T00:00:01Z' }]);
  assert.ok(model.artifacts.some((a) => a.key === 'event:tool_result'));
});

it('lineage: events out of timestamp order are sorted forward before linking', () => {
  // read has a LATER raw position but EARLIER ts, so the write must inherit it
  const model = lineageForTurn([
    { type: 'file_write', path: 'b.js', diff: '+x\n', ts: '2026-01-01T00:00:05Z' },
    { type: 'file_read', path: 'a.js', hash: 'h', ts: '2026-01-01T00:00:01Z' },
  ]);
  const b = model.artifacts.find((a) => a.path === 'b.js');
  assert.ok(b.touched_by.includes('a.js'), 'sort put the read first so the write inherits it');
});

it('lineage: a command keyed by its first word; network keyed by host fallback chain', () => {
  const model = lineageForTurn([
    { type: 'command_run', command: 'npm run build', ts: '2026-01-01T00:00:01Z' },
    { type: 'network_call', target: 'https://x.test/y', ts: '2026-01-01T00:00:02Z' },
  ]);
  assert.ok(model.artifacts.some((a) => a.key === 'cmd:npm'));
  assert.ok(model.artifacts.some((a) => a.key === 'https://x.test/y'), 'network with no host keys by target');
});

// --- html: trail truncation, undisclosed bump, subtask render ---------------

it('html: a long command in the trail is truncated, and subtasks render in the report', () => {
  tmpHome();
  const longCmd = 'echo ' + 'z'.repeat(200);
  seedEvents([
    { ts: '2026-01-01T00:00:01Z', session_id: 'HT', turn_id: 't1', type: 'user_prompt', text: 'run build, write a.js, and add caching' },
    { ts: '2026-01-01T00:00:02Z', session_id: 'HT', turn_id: 't1', source: 'hook', type: 'command_run', command: longCmd, exit_code: 0 },
    { ts: '2026-01-01T00:00:03Z', session_id: 'HT', turn_id: 't1', source: 'hook', type: 'file_write', path: 'a.js', diff: '+x\n' },
  ]);
  const trail = trailForSession('HT');
  const reports = [
    {
      session_id: 'HT',
      turn_id: 't1',
      ...reconcileTurn({
        promptText: 'run build, write a.js, and add caching',
        claimText: 'I wrote a.js.',
        turnEvents: [{ type: 'file_write', path: 'a.js', diff: '+x\n', source: 'hook' }],
      }),
    },
  ];
  const html = renderSessionHtml('HT', reports, trail);
  assert.ok(html.includes('…'), 'long command truncated with an ellipsis');
  assert.ok(html.includes('Original ask'), 'subtask section rendered when >1 subtask');
});

it('html: undisclosed and untracked entries colour their own cells in the file grid', () => {
  const reports = [
    {
      session_id: 'U',
      turn_id: 't1',
      claims: [],
      subtasks: [],
      undisclosed: [{ path: 'snuck-in.js' }],
      untracked: [{ rel_path: 'on-disk.js', change_kind: 'create' }],
      summary: { verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, undisclosed_changes: 1, untracked_writes: 1 },
    },
  ];
  const html = renderSessionHtml('U', reports);
  assert.ok(html.includes('snuck-in.js'), 'undisclosed file appears in the grid');
  assert.ok(html.includes('on-disk.js'), 'untracked file appears in the grid');
});

runAll('unit');
