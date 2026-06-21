'use strict';

/**
 * test/redact.js
 *
 * Tests the render-time privacy pass (src/render/redact.js): home-prefix
 * collapse (default on / opt-out) and the opt-in `.orunmila/redact` list. Drives
 * the pure data->data transform directly, plus one end-to-end check that the
 * sanitised models reach the rendered HTML (no leaked home prefix, no leaked
 * listed path). No real ~/.orunmila is touched.
 *
 * Run: node test/redact.js
 */

const os = require('os');
const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { buildRedactor, redactForRender, PLACEHOLDER } = require('../src/render/redact');
const { renderSessionHtml } = require('../src/render/html');

const HOME = os.homedir();

function reportFixture() {
  return [
    {
      turn_id: 't1',
      summary: { verified: 1, phantom: 0, phantom_verification: 0, silently_dropped: 0, undisclosed_changes: 1, untracked_writes: 0 },
      claims: [
        {
          claim: { text: `edited ${HOME}/proj/secret/keys.js` },
          outcome: 'verified',
          evidence: [{ type: 'file_write', path: `${HOME}/proj/secret/keys.js`, diff: '+x' }],
        },
      ],
      subtasks: [],
      undisclosed: [{ path: `${HOME}/proj/src/app.js` }],
      untracked: [],
    },
  ];
}

function trailFixture() {
  return {
    session_id: 's1',
    turns: [
      {
        turn_id: 't1',
        prompt: `look at ${HOME}/proj/secret/keys.js`,
        trail: [
          { channel: 'read', path: `${HOME}/proj/secret/keys.js`, key: `${HOME}/proj/secret/keys.js` },
          { channel: 'command', command: `cat ${HOME}/proj/secret/keys.js`, key: 'cmd:cat' },
          { channel: 'network', host: 'example.com', target: 'https://example.com/x', key: 'example.com' },
        ],
        edges: [{ from: `${HOME}/proj/secret/keys.js`, to: `${HOME}/proj/src/app.js`, kind: 'read->write' }],
        artifacts: [
          { key: `${HOME}/proj/secret/keys.js`, label: 'keys.js', path: `${HOME}/proj/secret/keys.js`, channels: ['read'], touch_count: 1, touched_by: [] },
          { key: `${HOME}/proj/src/app.js`, label: 'app.js', path: `${HOME}/proj/src/app.js`, channels: ['write'], touch_count: 1, touched_by: [`${HOME}/proj/secret/keys.js`] },
        ],
      },
    ],
    artifacts: [
      { key: `${HOME}/proj/secret/keys.js`, label: 'keys.js', path: `${HOME}/proj/secret/keys.js`, channels: ['read'], touch_count: 1, touched_by: [] },
      { key: `${HOME}/proj/src/app.js`, label: 'app.js', path: `${HOME}/proj/src/app.js`, channels: ['write'], touch_count: 1, touched_by: [`${HOME}/proj/secret/keys.js`] },
    ],
    totals: { turns: 1, artifacts: 2, touches: 2 },
  };
}

it('home-prefix collapse rewrites an absolute home path to ~ (default on)', () => {
  const R = buildRedactor({ root: tmpDir() }); // no redact file -> empty list
  assert.strictEqual(R.path(`${HOME}/proj/x.js`), '~/proj/x.js');
  assert.strictEqual(R.path(HOME), '~');
  // a path NOT under home is untouched
  assert.strictEqual(R.path('/etc/passwd'), '/etc/passwd');
});

it('home collapse can be disabled with { home:false }', () => {
  const R = buildRedactor({ home: false, root: tmpDir() });
  assert.strictEqual(R.path(`${HOME}/proj/x.js`), `${HOME}/proj/x.js`);
});

it('home prefix inside a command/free-text string is collapsed too', () => {
  const R = buildRedactor({ root: tmpDir() });
  assert.strictEqual(R.text(`run ${HOME}/proj/build.sh now`), 'run ~/proj/build.sh now');
});

it('.orunmila/redact list replaces a matching path wholesale with the placeholder', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), '# secrets\nsecret/\n');
  const R = buildRedactor({ root });
  assert.deepStrictEqual(R.redactList, ['secret/']);
  assert.strictEqual(R.path(`${HOME}/proj/secret/keys.js`), PLACEHOLDER);
  // a sibling path NOT under secret/ survives (just home-collapsed)
  assert.strictEqual(R.path(`${HOME}/proj/src/app.js`), '~/proj/src/app.js');
});

it('a listed fragment inside a command string is masked, not the whole command', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), 'secret/keys.js\n');
  const R = buildRedactor({ root });
  const out = R.text(`cat ${HOME}/proj/secret/keys.js | wc -l`);
  assert.ok(out.includes('cat '), 'command verb survives');
  assert.ok(out.includes(PLACEHOLDER), 'the listed fragment is masked');
  assert.ok(!out.includes('keys.js'), 'the secret fragment does not leak');
});

it('redactForRender sanitises reports + trail on COPIES (originals untouched)', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), 'secret/\n');
  const reports = reportFixture();
  const trail = trailFixture();
  const { reports: r, trail: t, redactList } = redactForRender(reports, trail, { root });

  assert.deepStrictEqual(redactList, ['secret/']);
  // copy is redacted
  assert.strictEqual(r[0].claims[0].evidence[0].path, PLACEHOLDER);
  assert.strictEqual(r[0].undisclosed[0].path, '~/proj/src/app.js');
  assert.strictEqual(t.artifacts[0].path, PLACEHOLDER);
  assert.strictEqual(t.artifacts[0].label, PLACEHOLDER, 'label of a redacted artifact is also masked');
  assert.strictEqual(t.artifacts[1].touched_by[0], PLACEHOLDER, 'a redacted lineage source is masked in touched_by');
  // ORIGINAL is byte-for-byte unchanged (no mutation)
  assert.strictEqual(reports[0].claims[0].evidence[0].path, `${HOME}/proj/secret/keys.js`);
  assert.strictEqual(trail.artifacts[0].path, `${HOME}/proj/secret/keys.js`);
});

it('end to end: rendered HTML leaks neither the home prefix nor a redacted path', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), 'secret/\n');
  const { reports, trail } = redactForRender(reportFixture(), trailFixture(), { root });
  const html = renderSessionHtml('s1', reports, trail);
  assert.ok(!html.includes(HOME), 'no absolute home directory in the shared HTML');
  assert.ok(!html.includes('keys.js'), 'the redacted secret file never reaches the HTML');
  assert.ok(html.includes('~/proj/src/app.js') || html.includes('app.js'), 'non-secret files still render');
  rmrf(root);
});

it('no redact file -> empty list, only home collapse applies', () => {
  const { reports, redactList } = redactForRender(reportFixture(), null, { root: tmpDir() });
  assert.deepStrictEqual(redactList, []);
  // still home-collapsed, just not placeholdered
  assert.strictEqual(reports[0].claims[0].evidence[0].path, '~/proj/secret/keys.js');
});

it('a null trail passes straight through (orunmila html, no glove)', () => {
  const { trail, reports } = redactForRender(reportFixture(), null, { root: tmpDir() });
  assert.strictEqual(trail, null);
  assert.ok(Array.isArray(reports));
});

it('sparse events: fields that are absent stay absent (no fabricated keys)', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), 'secret/\n');
  // A report with: a claim whose evidence is a pure read (no command/host/target/
  // rel_path), an untracked entry with only rel_path (no path), and a subtask
  // with neither task nor evidence. Each exercises a different `!= null` guard.
  const reports = [
    {
      turn_id: 't1',
      summary: { verified: 1 },
      claims: [{ claim: { text: 'read a file' }, outcome: 'verified', evidence: [{ type: 'file_read', path: `${HOME}/proj/a.js` }] }],
      subtasks: [{ task: { text: 'do thing' }, outcome: 'unverifiable_ask', evidence: [] }],
      undisclosed: [],
      untracked: [{ rel_path: 'src/sneaky.js', change_kind: 'modified' }],
    },
  ];
  const trail = {
    session_id: 's2',
    turns: [
      {
        turn_id: 't1',
        // no prompt field at all
        trail: [{ channel: 'read', path: `${HOME}/proj/a.js`, key: `${HOME}/proj/a.js` }],
        edges: [],
        artifacts: [{ key: `${HOME}/proj/a.js`, label: 'a.js', path: `${HOME}/proj/a.js`, channels: ['read'], touch_count: 1 }],
      },
    ],
    artifacts: [{ key: `${HOME}/proj/a.js`, label: 'a.js', path: `${HOME}/proj/a.js`, channels: ['read'], touch_count: 1 }],
    totals: { turns: 1, artifacts: 1, touches: 1 },
  };
  const { reports: r, trail: t } = redactForRender(reports, trail, { root });
  const ev = r[0].claims[0].evidence[0];
  assert.strictEqual(ev.path, '~/proj/a.js');
  assert.ok(!('command' in ev), 'absent command is not fabricated');
  assert.ok(!('host' in ev), 'absent host is not fabricated');
  assert.strictEqual(r[0].untracked[0].rel_path, 'src/sneaky.js');
  assert.ok(!('path' in r[0].untracked[0]) || r[0].untracked[0].path == null, 'absent untracked.path stays absent');
  // sparse trail row: no command/host/target to redact, just the read path
  const row = t.turns[0].trail[0];
  assert.strictEqual(row.path, '~/proj/a.js');
  // artifact with no touched_by array: must not crash, key/label home-collapsed
  assert.strictEqual(t.artifacts[0].path, '~/proj/a.js');
});

it('an artifact whose path is redacted has its touched_by sources masked, missing array tolerated', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.orunmila'), { recursive: true });
  fs.writeFileSync(path.join(root, '.orunmila', 'redact'), 'vault/\n');
  const { trail } = redactForRender(reportFixture(), {
    session_id: 's3',
    turns: [],
    artifacts: [
      { key: `${HOME}/vault/a`, label: 'a', path: `${HOME}/vault/a`, channels: ['read'], touch_count: 1 }, // no touched_by
      { key: `${HOME}/src/b`, label: 'b', path: `${HOME}/src/b`, channels: ['write'], touch_count: 1, touched_by: [`${HOME}/vault/a`] },
    ],
    totals: { turns: 0, artifacts: 2, touches: 2 },
  }, { root });
  assert.strictEqual(trail.artifacts[0].path, PLACEHOLDER);
  assert.strictEqual(trail.artifacts[1].touched_by[0], PLACEHOLDER, 'redacted lineage source masked');
});

it('empty / missing collections render to empty, never crash (early session)', () => {
  // A report object missing claims/subtasks/undisclosed/untracked entirely, and a
  // trail with empty turns/artifacts — the shapes you get before anything is
  // reconciled. Every `|| []` fallback must hold.
  const { reports, trail } = redactForRender([{ turn_id: 't0', summary: {} }], {
    session_id: 's0', turns: [], artifacts: [], totals: { turns: 0, artifacts: 0, touches: 0 },
  }, { root: tmpDir() });
  assert.deepStrictEqual(reports[0].claims, []);
  assert.deepStrictEqual(reports[0].subtasks, []);
  assert.deepStrictEqual(reports[0].undisclosed, []);
  assert.deepStrictEqual(reports[0].untracked, []);
  assert.deepStrictEqual(trail.turns, []);
  assert.deepStrictEqual(trail.artifacts, []);
});

it('a claim/subtask with a null inner object is passed through untouched', () => {
  // matcher always populates claim/task, but the redactor must not assume it —
  // exercises the `c.claim ? ... : c.claim` false branch.
  const { reports } = redactForRender([{
    turn_id: 't1', summary: {},
    claims: [{ claim: null, outcome: 'unverifiable', evidence: [] }],
    subtasks: [{ task: null, outcome: 'unverifiable_ask', evidence: [] }],
  }], null, { root: tmpDir() });
  assert.strictEqual(reports[0].claims[0].claim, null);
  assert.strictEqual(reports[0].subtasks[0].task, null);
});

it('reportFixture()/trailFixture() with no opts.root falls back to cwd (default path)', () => {
  // buildRedactor() with no root reads .orunmila/redact from process.cwd(); this
  // repo has none, so it is a pure home-collapse — exercises the default-root branch.
  const { reports } = redactForRender(reportFixture(), null, {});
  assert.strictEqual(reports[0].claims[0].evidence[0].path, '~/proj/secret/keys.js');
});

runAll('redact (privacy pass)');
