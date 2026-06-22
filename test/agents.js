'use strict';

/**
 * test/agents.js
 *
 * Covers the agent-agnostic capture layer added by the multi-agent refactor:
 *   - the adapter registry (src/capture/agents.js): tool classification across
 *     agents' differing tool names, and the liberal field accessors;
 *   - the shared core helpers (src/capture/core.js): host parsing, failure
 *     detection, read provenance;
 *   - the universal connector (src/capture/connector.js) end-to-end for a
 *     NON-Claude agent (Cursor), proving a foreign payload shape becomes the
 *     same canonical events with the right `agent` stamp.
 *
 * This is the regression guard for "adding an agent is data, not a fork": if a
 * default field name or tool-name union regresses, a foreign agent silently
 * stops capturing, and these tests catch it.
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, it, runAll } = require('./helpers');
const agents = require('../src/capture/agents');
const core = require('../src/capture/core');

const CONNECTOR = 'src/capture/connector.js';

function readEvents(home) {
  const p = path.join(home, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

// --- registry: tool classification ----------------------------------------

it('agents: classifyTool maps each agent\'s write tool to "write"', () => {
  const c = agents.defaultClassifyTool;
  for (const name of ['Write', 'Edit', 'MultiEdit', 'edit_file', 'apply_patch', 'str_replace_editor']) {
    assert.strictEqual(c(name, {}), 'write', `${name} should be write`);
  }
});

it('agents: classifyTool maps reads, pattern-reads, commands distinctly', () => {
  const c = agents.defaultClassifyTool;
  assert.strictEqual(c('Read', {}), 'read');
  assert.strictEqual(c('read_file', {}), 'read');
  assert.strictEqual(c('view_file', {}), 'read');
  assert.strictEqual(c('list_dir', {}), 'read');
  assert.strictEqual(c('Grep', {}), 'pattern_read');
  assert.strictEqual(c('codebase_search', {}), 'pattern_read');
  assert.strictEqual(c('find_by_name', {}), 'pattern_read');
  assert.strictEqual(c('grep_search', {}), 'pattern_read');
  assert.strictEqual(c('Bash', {}), 'command');
  assert.strictEqual(c('run_terminal_cmd', {}), 'command');
  assert.strictEqual(c('run_command', {}), 'command');
});

it('agents: classifyTool detects network by tool name, mcp, and outbound url input', () => {
  const c = agents.defaultClassifyTool;
  assert.strictEqual(c('WebFetch', {}), 'network');
  assert.strictEqual(c('mcp__browser__navigate', {}), 'network');
  assert.strictEqual(c('some_unknown_tool', { url: 'https://x.com' }), 'network');
  assert.strictEqual(c('ExitPlanMode', {}), 'tool', 'unknown non-network tool falls through');
});

it('agents: default field accessors read Claude names AND alternatives', () => {
  const f = agents.defaultFields;
  assert.strictEqual(f.sessionId({ session_id: 'A' }), 'A');
  assert.strictEqual(f.sessionId({ conversation_id: 'B' }), 'B', 'cursor-style id');
  assert.strictEqual(f.toolName({ tool: 'edit_file' }), 'edit_file');
  assert.strictEqual(f.filePath({ target_file: '/x.js' }), '/x.js', 'cursor write target');
  assert.strictEqual(f.prompt({ message: 'hi' }), 'hi');
  assert.strictEqual(f.exitCode({ success: false }), 1, 'boolean success → exit 1');
  assert.strictEqual(f.exitCode({ success: true }), 0);
  assert.strictEqual(f.exitCode({}), null, 'no signal → unknown, never fabricated');
});

it('agents: getAdapter is case-insensitive and defaults to claude-code; unknown → null', () => {
  assert.strictEqual(agents.getAdapter('CURSOR').id, 'cursor');
  assert.strictEqual(agents.getAdapter(undefined).id, 'claude-code');
  assert.strictEqual(agents.getAdapter('does-not-exist'), null);
});

it('agents: every adapter declares the four lifecycle phases', () => {
  for (const { id } of agents.listAgents()) {
    const a = agents.getAdapter(id);
    for (const phase of ['prompt', 'preTool', 'postTool', 'stop']) {
      assert.ok(a.events[phase], `${id} missing ${phase} event`);
    }
  }
});

it('agents: configPath honours --global vs cwd', () => {
  const cursor = agents.getAdapter('cursor');
  assert.strictEqual(
    agents.configPath(cursor, { global: true, home: '/H', cwd: '/W' }),
    path.join('/H', '.cursor', 'hooks.json')
  );
  assert.strictEqual(
    agents.configPath(cursor, { global: false, home: '/H', cwd: '/W' }),
    path.join('/W', '.cursor', 'hooks.json')
  );
});

// --- core helpers ----------------------------------------------------------

it('core: hostOf parses a URL host and returns null for a bare query', () => {
  assert.strictEqual(core.hostOf('https://docs.example.com/x'), 'docs.example.com');
  assert.strictEqual(core.hostOf('how to center a div'), null);
  assert.strictEqual(core.hostOf(null), null);
});

it('core: isFailure is adapter-aware (exit code) with a top-level error fallback', () => {
  const a = agents.getAdapter('claude-code');
  assert.strictEqual(core.isFailure({}, a, { exit_code: 0 }), false);
  assert.strictEqual(core.isFailure({}, a, { exit_code: 2 }), true);
  assert.strictEqual(core.isFailure({ error: 'boom' }, a, {}), true, 'top-level error implies failure');
  assert.strictEqual(core.isFailure({}, a, {}), false, 'no signal → not a failure');
});

it('core: readProvenance hashes a real file and is null for a missing one', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'r.txt');
  fs.writeFileSync(f, 'hello');
  const prov = core.readProvenance(f);
  assert.ok(prov.hash && prov.bytes === 5, 'real file hashed with byte size');
  const missing = core.readProvenance(path.join(dir, 'nope.txt'));
  assert.strictEqual(missing.hash, null);
  rmrf(dir);
});

// --- connector end-to-end for a NON-claude agent (Cursor) ------------------

it('connector: a Cursor session produces canonical events stamped agent:cursor', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'util.js');
  fs.writeFileSync(file, 'export const x = 1;\n');

  const env = { ORUNMILA_HOME: home };
  const C = (phase, payload) =>
    run(CONNECTOR, { args: ['cursor', phase], input: JSON.stringify(payload), env });

  C('prompt', { conversation_id: 'C1', prompt: 'add a helper to util.js' });
  C('preTool', { conversation_id: 'C1', tool: 'edit_file', input: { target_file: file } });
  C('postTool', { conversation_id: 'C1', tool: 'edit_file', input: { target_file: file }, result: { success: true } });
  C('postTool', { conversation_id: 'C1', tool: 'run_terminal_cmd', input: { command: 'npm test' }, result: { exit_code: 0, stdout: 'ok' } });
  C('postTool', { conversation_id: 'C1', tool: 'web_search', input: { query: 'https://example.com/docs' }, result: {} });

  const events = readEvents(home);
  assert.ok(events.length >= 4, `expected several events, got ${events.length}`);
  assert.ok(events.every((e) => e.agent === 'cursor'), 'every event stamped agent:cursor');

  const byType = (t) => events.find((e) => e.type === t);
  assert.strictEqual(byType('user_prompt').text, 'add a helper to util.js');
  assert.strictEqual(byType('file_write').path, file);
  assert.strictEqual(byType('command_run').command, 'npm test');
  assert.strictEqual(byType('network_call').host, 'example.com');

  rmrf(home);
  rmrf(work);
});

it('connector: an unknown agent or phase no-ops and exits 0 (never blocks the host)', () => {
  const home = tmpHome();
  const bad = run(CONNECTOR, { args: ['no-such-agent', 'postTool'], input: '{}', env: { ORUNMILA_HOME: home } });
  assert.strictEqual(bad.status, 0);
  const badPhase = run(CONNECTOR, { args: ['cursor', 'no-such-phase'], input: '{}', env: { ORUNMILA_HOME: home } });
  assert.strictEqual(badPhase.status, 0);
  assert.strictEqual(readEvents(home).length, 0, 'misconfigured hook writes nothing');
  rmrf(home);
});

it('cli: install --agent cursor writes a .cursor/hooks.json pointing at the connector', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--agent', 'cursor'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8'));
  // The connector script path is double-quoted so spaces/backslashes in it stay
  // intact on every platform; the args follow the closing quote.
  assert.ok(cfg.hooks.afterFileEdit.includes('connector.js" cursor postTool'), 'maps afterFileEdit → postTool');
  assert.ok(cfg.hooks.beforeSubmitPrompt.includes('" cursor prompt'));
  rmrf(home);
  rmrf(work);
});

it('cli: install --agent claude-code quotes the hook script path (space/backslash safe)', () => {
  // The generated command must double-quote the script path so it survives a
  // path with spaces (C:\Users\Jane Doe\...) and Windows backslash separators.
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  const cmd = cfg.hooks.PostToolUse[0].hooks[0].command;
  assert.ok(/^node "/.test(cmd), 'command opens with: node "');
  assert.ok(cmd.includes('post-tool-use.js"'), 'script path is closed-quoted');
  rmrf(home);
  rmrf(work);
});

// --- Antigravity adapter -----------------------------------------------------

it('agents: antigravity field accessors read nested toolCall payloads', () => {
  const a = agents.getAdapter('antigravity');
  const payload = {
    session_id: 'AG1',
    toolCall: { name: 'edit_file', args: { file_path: '/x.js' }, result: { success: true } },
    transcriptPath: '/tmp/log.jsonl',
  };
  assert.strictEqual(a.fields.toolName(payload), 'edit_file');
  assert.strictEqual(a.fields.toolInput(payload).file_path, '/x.js');
  assert.strictEqual(a.fields.toolResponse(payload).success, true);
  assert.strictEqual(a.fields.transcriptPath(payload), '/tmp/log.jsonl');
});

it('agents: antigravity configPath uses globalConfig for --global', () => {
  const a = agents.getAdapter('antigravity');
  assert.strictEqual(
    agents.configPath(a, { global: false, home: '/H', cwd: '/W' }),
    path.join('/W', '.agents', 'hooks.json')
  );
  assert.strictEqual(
    agents.configPath(a, { global: true, home: '/H', cwd: '/W' }),
    path.join('/H', '.gemini/config', 'hooks.json')
  );
});

it('connector: an Antigravity session produces canonical events stamped agent:antigravity', () => {
  const home = tmpHome();
  const work = tmpDir();
  const file = path.join(work, 'app.js');
  fs.writeFileSync(file, 'const x = 1;\n');

  const env = { ORUNMILA_HOME: home };
  const C = (phase, payload) =>
    run(CONNECTOR, { args: ['antigravity', phase], input: JSON.stringify(payload), env });

  C('prompt', { session_id: 'AG1', prompt: 'refactor app.js' });
  C('preTool', { session_id: 'AG1', toolCall: { name: 'edit_file', args: { file_path: file } } });
  C('postTool', { session_id: 'AG1', toolCall: { name: 'edit_file', args: { file_path: file }, result: { success: true } } });
  C('postTool', { session_id: 'AG1', toolCall: { name: 'run_command', args: { command: 'npm test' }, result: { exit_code: 0, stdout: 'pass' } } });
  C('postTool', { session_id: 'AG1', toolCall: { name: 'grep_search', args: { pattern: 'TODO' }, result: {} } });

  const events = readEvents(home);
  assert.ok(events.length >= 4, `expected several events, got ${events.length}`);
  assert.ok(events.every((e) => e.agent === 'antigravity'), 'every event stamped agent:antigravity');

  const byType = (t) => events.find((e) => e.type === t);
  assert.strictEqual(byType('user_prompt').text, 'refactor app.js');
  assert.strictEqual(byType('file_write').path, file);
  assert.strictEqual(byType('command_run').command, 'npm test');
  assert.strictEqual(byType('file_read').path, 'TODO');

  rmrf(home);
  rmrf(work);
});

it('cli: install --agent antigravity writes .agents/hooks.json in Antigravity format', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--agent', 'antigravity'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.agents', 'hooks.json'), 'utf8'));
  assert.ok(cfg.orunmila, 'hooks live under the "orunmila" group');
  assert.ok(cfg.orunmila.PreInvocation, 'has PreInvocation event');
  assert.ok(cfg.orunmila.PostToolUse, 'has PostToolUse event');
  assert.ok(cfg.orunmila.Stop, 'has Stop event');
  const postCmd = cfg.orunmila.PostToolUse[0].hooks[0].command;
  assert.ok(postCmd.includes('connector.js" antigravity postTool'), 'PostToolUse → postTool via connector');
  rmrf(home);
  rmrf(work);
});

it('cli: install --agent unknown exits non-zero and lists known agents', () => {
  const home = tmpHome();
  const work = tmpDir();
  const r = run('bin/orunmila.js', { args: ['install', '--agent', 'nope'], env: { ORUNMILA_HOME: home }, cwd: work });
  assert.strictEqual(r.status, 1);
  assert.ok((r.stderr + r.stdout).includes('claude-code'), 'lists known agents');
  rmrf(home);
  rmrf(work);
});

runAll('agents');
