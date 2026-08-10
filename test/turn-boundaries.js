'use strict';

/**
 * test/turn-boundaries.js
 *
 * Turn identity is the spine of the whole tool: the glove groups by it, the
 * stain reconciles by it, and the law layer reads a turn's claim against that
 * turn's receipts. When the boundary is wrong every layer above it inherits the
 * error, so these run the REAL hook scripts as child processes rather than
 * calling the handlers directly.
 *
 * The bug being locked out (measured 2026-08-10 over 195 sessions / 1183 turns):
 * the counter advanced only on a prompt and Stop never touched it, so 39.1% of
 * claimed turns carried more than one claim and 16.0% held a claim with no
 * evidence at all. Both split a claim from the work that earned it.
 *
 * Run: node test/turn-boundaries.js
 */

const { assert, fs, path, tmpHome, rmrf, run, it, runAll } = require('./helpers');

const HOOK = (name) => `src/capture/claude-code/${name}`;

function readEvents(home) {
  const p = path.join(home, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const S = 'S';
const prompt = (home, text) =>
  run(HOOK('user-prompt-submit.js'), { env: { ORUNMILA_HOME: home }, input: JSON.stringify({ session_id: S, prompt: text }) });
const tool = (home, cmd) =>
  run(HOOK('post-tool-use.js'), {
    env: { ORUNMILA_HOME: home },
    input: JSON.stringify({
      session_id: S,
      tool_name: 'Bash',
      tool_input: { command: cmd },
      tool_response: { stdout: 'ok', exit_code: 0 },
    }),
  });
const stop = (home, claim, env) =>
  run(HOOK('stop.js'), { env: Object.assign({ ORUNMILA_HOME: home }, env || {}), input: JSON.stringify({ session_id: S, claim }) });

const turnsOf = (home, type) => readEvents(home).filter((e) => e.type === type).map((e) => e.turn_id);

it('a normal turn keeps prompt, work and claim together', () => {
  const home = tmpHome();
  prompt(home, 'do the thing');
  tool(home, 'echo one');
  stop(home, 'did the thing');
  const ev = readEvents(home).filter((e) => e.turn_id);
  const ids = [...new Set(ev.map((e) => e.turn_id))];
  assert.deepStrictEqual(ids, ['t1'], 'one turn, and the first turn is t1');
  rmrf(home);
});

it('a continuation with NO prompt starts a new turn instead of collapsing into the last one', () => {
  const home = tmpHome();
  prompt(home, 'first ask');
  tool(home, 'echo one');
  stop(home, 'first answer');
  // No prompt hook fires here -- this is the mid-turn-message / auto-continuation
  // case that used to fold a second response into the first turn.
  tool(home, 'echo two');
  stop(home, 'second answer');

  const claims = turnsOf(home, 'turn_claim');
  assert.strictEqual(claims.length, 2, 'two claims captured');
  assert.notStrictEqual(claims[0], claims[1], 'the two claims must NOT share a turn_id');
  assert.deepStrictEqual(claims, ['t1', 't2']);

  // and the second turn must own the evidence that earned its claim
  const cmds = readEvents(home).filter((e) => e.type === 'command_run');
  assert.strictEqual(cmds[1].turn_id, 't2', 'the continuation\'s command belongs to the continuation\'s turn');
  rmrf(home);
});

it('no turn ever carries two claims', () => {
  const home = tmpHome();
  prompt(home, 'a');
  stop(home, 'answer a');
  stop(home, 'answer b');
  stop(home, 'answer c');
  const claims = turnsOf(home, 'turn_claim');
  assert.strictEqual(new Set(claims).size, claims.length, 'every claim sits in a distinct turn');
  rmrf(home);
});

it('a prompt arriving MID-turn stays with the work in flight, not with a fresh empty turn', () => {
  const home = tmpHome();
  prompt(home, 'first ask');
  tool(home, 'echo work');
  // The user sends another message while the agent is still working. Under the
  // old behaviour this advanced the counter, so the claim describing the work
  // above landed in a turn holding none of it.
  prompt(home, 'actually also do this');
  stop(home, 'here is what I did');

  const ev = readEvents(home);
  const claim = ev.find((e) => e.type === 'turn_claim');
  const cmd = ev.find((e) => e.type === 'command_run');
  assert.strictEqual(claim.turn_id, cmd.turn_id, 'the claim sits in the turn that holds its evidence');
  rmrf(home);
});

it('every claimed turn holds at least one evidence event when evidence was produced', () => {
  const home = tmpHome();
  prompt(home, 'ask');
  tool(home, 'echo a');
  stop(home, 'one');
  tool(home, 'echo b');
  stop(home, 'two');

  const ev = readEvents(home);
  const META = new Set(['user_prompt', 'turn_claim', 'turn_end', 'session_end']);
  for (const id of new Set(ev.filter((e) => e.type === 'turn_claim').map((e) => e.turn_id))) {
    const evidence = ev.filter((e) => e.turn_id === id && !META.has(e.type));
    assert.ok(evidence.length > 0, `turn ${id} has evidence behind its claim`);
  }
  rmrf(home);
});

it('the counter does NOT advance during the stop cascade, so a later Stop hook still sees the finished turn', () => {
  const home = tmpHome();
  prompt(home, 'ask');
  tool(home, 'echo a');
  stop(home, 'answered');
  // The law gate runs as a SEPARATE Stop hook after capture. It resolves its
  // turn by reading this state, so an eager bump would hand it an empty turn
  // and it would judge nothing while appearing to work.
  const { turnId } = require('../src/capture/turnstate');
  process.env.ORUNMILA_HOME = home;
  assert.strictEqual(turnId(S), 't1', 'a reader after stop still points at the turn that just closed');
  const ev = readEvents(home);
  assert.ok(ev.some((e) => e.turn_id === 't1' && e.type === 'turn_claim'), 'and that turn holds the claim');
  rmrf(home);
});

it('ORUNMILA_TURN_BOUNDARIES=legacy restores the old collapsing behaviour', () => {
  const home = tmpHome();
  const env = { ORUNMILA_TURN_BOUNDARIES: 'legacy' };
  run(HOOK('user-prompt-submit.js'), { env: Object.assign({ ORUNMILA_HOME: home }, env), input: JSON.stringify({ session_id: S, prompt: 'a' }) });
  stop(home, 'one', env);
  stop(home, 'two', env);
  const claims = turnsOf(home, 'turn_claim');
  assert.strictEqual(claims[0], claims[1], 'legacy still folds both claims into one turn');
  rmrf(home);
});

if (require.main === module) runAll();
module.exports = { runAll };