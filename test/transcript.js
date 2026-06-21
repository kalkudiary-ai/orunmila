'use strict';

/**
 * test/transcript.js
 *
 * The transcript parser is the one declared-unstable contract (its shape shifts
 * across Claude Code / other-agent versions), so it gets its own focused suite
 * exercising every known line shape plus the defensive fallbacks.
 *
 * Run: node test/transcript.js
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const transcript = require('../src/capture/claude-code/transcript');

function write(lines) {
  const dir = tmpDir();
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { dir, p };
}

it('transcript: readLines returns [] for a missing path or null', () => {
  assert.deepStrictEqual(transcript.readLines(null), []);
  assert.deepStrictEqual(transcript.readLines('/no/such/file.jsonl'), []);
});

it('transcript: readLines skips unparseable lines', () => {
  const { dir, p } = write([{ role: 'user', content: 'hi' }, 'GARBAGE', { role: 'assistant', content: 'ok' }]);
  assert.strictEqual(transcript.readLines(p).length, 2);
  rmrf(dir);
});

it('transcript: normalize handles {role,content} string shape', () => {
  assert.deepStrictEqual(transcript.normalize({ role: 'user', content: 'hello' }), { role: 'user', text: 'hello' });
});

it('transcript: normalize handles the nested {message:{role,content}} shape', () => {
  const n = transcript.normalize({ type: 'x', message: { role: 'assistant', content: 'done' } });
  assert.deepStrictEqual(n, { role: 'assistant', text: 'done' });
});

it('transcript: normalize handles the {type:user|assistant} shape', () => {
  assert.deepStrictEqual(transcript.normalize({ type: 'assistant', content: 'yo' }), { role: 'assistant', text: 'yo' });
});

it('transcript: normalize flattens an array content with text blocks', () => {
  const n = transcript.normalize({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { text: 'b' }] });
  assert.strictEqual(n.text, 'a\nb');
});

it('transcript: normalize handles an object content with a .text field', () => {
  assert.deepStrictEqual(transcript.normalize({ role: 'user', content: { text: 'inner' } }), { role: 'user', text: 'inner' });
});

it('transcript: normalize returns null for a line no extractor matches', () => {
  assert.strictEqual(transcript.normalize({ foo: 'bar' }), null);
  assert.strictEqual(transcript.normalize({ role: 'user', content: '' }), null, 'empty text is not a usable line');
});

it('transcript: an extractor-matched line whose content is an unhandled type yields no text', () => {
  // role present (so an extractor matches) but content is neither string, array,
  // nor an object-with-.text — textOf falls through to '', and normalize drops it.
  assert.strictEqual(transcript.normalize({ role: 'assistant', content: 42 }), null);
  assert.strictEqual(transcript.normalize({ role: 'user', content: { note: 'no text field' } }), null);
});

it('transcript: lastAssistantText / lastUserText pick the last of each role', () => {
  const { dir, p } = write([
    { role: 'user', content: 'first ask' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second ask' },
    { role: 'assistant', content: 'second answer' },
  ]);
  assert.strictEqual(transcript.lastAssistantText(p), 'second answer');
  assert.strictEqual(transcript.lastUserText(p), 'second ask');
  rmrf(dir);
});

it('transcript: lastAssistantText / lastUserText return "" on an empty transcript', () => {
  assert.strictEqual(transcript.lastAssistantText(null), '');
  assert.strictEqual(transcript.lastUserText(null), '');
});

runAll('transcript');
