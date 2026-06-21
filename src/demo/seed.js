'use strict';

/**
 * demo/seed.js
 *
 * Builds a realistic, self-contained sample session and renders the REAL unified
 * report from it — `orunmila demo` is the visual demo (Phase 4.2). This is not a
 * mock-up of the HTML: it appends genuine events to an isolated event log, runs
 * the same reconciler + trail pipeline the live tool uses, and renders with the
 * same `renderSessionHtml`. So the demo page is exactly what a user gets, just
 * from scripted events instead of a live agent — regenerable, never stale, and a
 * faithful preview of every stain category and every trail channel.
 *
 * The scripted session deliberately exercises one of each interesting outcome so
 * the screenshot/demo shows the full surface:
 *   - verified        (claimed an edit, the diff has real logic)
 *   - partial         (claimed an implementation, the diff is a trivial stub)
 *   - phantom         (claimed a file change with zero matching tool call)
 *   - phantom_verification (claimed "tested and passing" with no passing command)
 *   - silently_dropped (the prompt asked for something never mentioned again)
 *   - undisclosed     (edited a file no claim/ask covers — scope creep)
 *   - untracked_write (the sentinel saw a disk write the hooks never announced)
 * plus every trail channel: read (with hash), write, command, network, disk, and
 * a sub-agent (Task) touch.
 *
 * It writes into whatever ORUNMILA_HOME points at, so the caller isolates it in a
 * temp dir and never pollutes the user's real ~/.orunmila log.
 */

const crypto = require('crypto');
const eventlog = require('../store/eventlog');
const { reconcileAndPersist } = require('../reconcile');
const { TYPES } = eventlog;

const SESSION = 'demo-session';

// Monotonic clock so events sort in scripted order and each turn gets a clean,
// non-overlapping time window (the sentinel/turn correlation is time-based).
let clock = Date.parse('2025-01-15T10:00:00.000Z');
function ts() {
  clock += 1000; // one second between events — readable, deterministic
  return new Date(clock).toISOString();
}

function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Append one event with the demo session id and the shared turn id, stamping a
// fresh monotonic ts so ordering and per-turn windows are deterministic.
function emit(turnId, event) {
  return eventlog.append(Object.assign({ session_id: SESSION, turn_id: turnId, ts: ts() }, event));
}

// ---- the scripted turns ----------------------------------------------------

// Turn 1: an honest, well-behaved turn. Read a file (provenance source, hashed),
// edit it with real logic (verified), run the test that backs the claim.
function turn1() {
  const t = 'turn-1';
  const body = 'export function add(a, b) {\n  return a + b;\n}\n';
  emit(t, { type: TYPES.USER_PROMPT, text: 'Add an `add` function to src/math.js and run the tests.' });
  emit(t, {
    type: TYPES.FILE_READ, agent: 'claude-code', source: 'hook', tool_name: 'Read',
    path: 'src/math.js', hash: hashOf(body), bytes: body.length, call_id: 'c1',
  });
  emit(t, {
    type: TYPES.FILE_WRITE, agent: 'claude-code', source: 'hook', tool_name: 'Edit',
    path: 'src/math.js', call_id: 'c2',
    diff: '--- a/src/math.js\n+++ b/src/math.js\n@@\n+export function add(a, b) {\n+  const sum = a + b;\n+  return sum;\n+}\n',
  });
  emit(t, {
    type: TYPES.COMMAND_RUN, agent: 'claude-code', source: 'hook', tool_name: 'Bash',
    command: 'node --test test/math.test.js', exit_code: 0, call_id: 'c3',
    output_excerpt: '# tests 2\n# pass 2\n', output_path: '/output/demo-session/c3.txt',
  });
  emit(t, {
    type: TYPES.TURN_CLAIM,
    text: 'I added the `add` function to src/math.js and ran the tests — they pass.',
  });
  emit(t, { type: TYPES.TURN_END });
}

// Turn 2: the dishonest turn. Claims a phantom edit (no tool call), a phantom
// verification ("tested, all passing" with no passing command), and leaves a
// prompt subtask (the README) silently dropped.
function turn2() {
  const t = 'turn-2';
  emit(t, {
    type: TYPES.USER_PROMPT,
    text: 'Add input validation to src/handler.js and update the README to document it.',
  });
  // Note: NO file_write for handler.js this turn. Two separate claim sentences:
  // the first asserts an edit with no matching tool call (-> phantom); the second
  // asserts a passing test with no command_run behind it (-> phantom_verification).
  emit(t, {
    type: TYPES.TURN_CLAIM,
    text:
      'I added input validation to src/handler.js. The tests now pass and the feature is verified working.',
  });
  emit(t, { type: TYPES.TURN_END });
}

// Turn 3: the trail/glove turn. A read flows into a write (lineage edge), a
// network fetch is recorded with its host, a sub-agent (Task) makes a touch,
// an undisclosed file is edited (scope creep), and the Filesystem Sentinel
// independently observes a disk write the hooks never announced (untracked).
function turn3() {
  const t = 'turn-3';
  const cfg = 'const TIMEOUT = 5000;\nmodule.exports = { TIMEOUT };\n';
  emit(t, { type: TYPES.USER_PROMPT, text: 'Wire up the config in src/server.js.' });
  emit(t, {
    type: TYPES.FILE_READ, agent: 'claude-code', source: 'hook', tool_name: 'Read',
    path: 'src/config.js', hash: hashOf(cfg), bytes: cfg.length, call_id: 'd1',
  });
  emit(t, {
    type: TYPES.NETWORK_CALL, agent: 'claude-code', source: 'hook', tool_name: 'WebFetch',
    channel: 'network', host: 'nodejs.org', target: 'https://nodejs.org/api/http.html', call_id: 'd2',
  });
  emit(t, {
    type: TYPES.FILE_WRITE, agent: 'claude-code', source: 'hook', tool_name: 'Edit',
    path: 'src/server.js', call_id: 'd3',
    diff:
      '--- a/src/server.js\n+++ b/src/server.js\n@@\n+const { TIMEOUT } = require("./config");\n+server.setTimeout(TIMEOUT);\n',
  });
  // A sub-agent (Task / Explore) touch — attributed to the sub-agent in the trail.
  emit(t, {
    type: TYPES.FILE_READ, agent: 'claude-code', source: 'hook', tool_name: 'Read',
    path: 'src/routes.js', hash: hashOf('// routes\n'), bytes: 10, call_id: 'd4',
    sub_agent_id: 'agent-explore-1', sub_agent_type: 'Explore',
  });
  // Scope creep: an edit to a file no claim/ask mentions -> undisclosed.
  emit(t, {
    type: TYPES.FILE_WRITE, agent: 'claude-code', source: 'hook', tool_name: 'Edit',
    path: 'src/telemetry.js', call_id: 'd5',
    diff: '--- a/src/telemetry.js\n+++ b/src/telemetry.js\n@@\n+track("server_start");\n',
  });
  // The Filesystem Sentinel, a SEPARATE observer, sees a write to a file the
  // hook stream never mentioned this turn. turn_id:null (the sentinel can't see
  // turn ids); reconcile folds it in by timestamp, so this MUST land inside the
  // turn's hook-event window [first hook ts, last hook ts] — i.e. before the
  // turn_end below. -> untracked_write, the top-ranked stain.
  eventlog.append({
    session_id: SESSION, turn_id: null, ts: ts(),
    type: TYPES.FILE_WRITE, agent: 'fs-sentinel', source: 'fs-sentinel',
    path: 'src/cache.bin', rel_path: 'src/cache.bin',
    diff: '--- a/src/cache.bin\n+++ b/src/cache.bin\n@@\n+(binary cache rewritten)\n',
  });

  emit(t, {
    type: TYPES.TURN_CLAIM,
    text: 'I wired src/server.js to use the config timeout (referenced the Node http docs).',
  });
  emit(t, { type: TYPES.TURN_END });
}

/**
 * Seed the demo session into the current ORUNMILA_HOME and reconcile each turn.
 * Returns the session id so the caller can render it. The caller is responsible
 * for pointing ORUNMILA_HOME at an isolated dir BEFORE requiring this (the
 * eventlog resolves its path lazily on each call, so set the env first).
 */
function seedDemoSession() {
  turn1();
  turn2();
  turn3();
  for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
    reconcileAndPersist(SESSION, turnId);
  }
  return SESSION;
}

module.exports = { seedDemoSession, SESSION };
