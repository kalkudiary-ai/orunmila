'use strict';

/**
 * test/trail-page.js — HTML1 (LD305; O, 2026-11-25: "the whole html page needs thorough functionality checks, and a
 * deep dive update and uplight"). What the page SAYS, held here; what it DOES in a browser is
 * scripts/trail-page-check.js.
 *
 *   - nothing checked never reads as clean (F17, LD303): with no turn reports the header, the file list, the
 *     Report tab and the claim-vs-reality section each say "Not checked", and no "looks clean" or "all clean" appears;
 *   - turns checked with no checkable claim say so, never "all clean";
 *   - one palette: every outcome has one colour across the page;
 *   - the glossary and the copy-paste prompt use neutral words (a finding means "recheck this", never "you lied"),
 *     describe no metric the page does not show, and mark the dropped-ask check as noisy (LD302);
 *   - no emoji icon (they draw differently, or not at all, on Windows and Linux).
 */

const { assert, it, runAll } = require('./helpers');
const { renderSessionHtml } = require('../src/render/html');
const tv = require('../src/render/trail-visual');

const trail = {
  session_id: 's1',
  turns: [{ turn_id: 't1', prompt: 'p', edges: [], trail: [{ key: 'a', channel: 'write', path: 'src/a.js' }], artifacts: [{ key: 'a' }] }],
  artifacts: [{ key: 'a', label: 'a.js', path: 'src/a.js', channels: ['write'], touch_count: 1, touched_by: [], sub_agents: [] }],
  totals: { turns: 1, artifacts: 1, touches: 1 },
};
/** The header alone: from the verdict block to the file list's title. */
const header = (html) => html.slice(html.indexOf('<div class="verdict">'), html.indexOf('Files worth a look'));
const summary = (over) => Object.assign({ verified: 0, partial: 0, phantom: 0, phantom_verification: 0, unverifiable: 0, silently_dropped: 0, unverifiable_ask: 0, undisclosed_changes: 0, untracked_writes: 0 }, over);

it('HTML1 (F17): with no turn reports nothing reads as clean; each part says "Not checked"', () => {
  const html = renderSessionHtml('s1', [], trail);
  for (const bad of ['looks clean', 'all clean', 'No file writes captured yet', 'Nothing flagged']) assert.ok(!html.includes(bad), `"${bad}" is on a page nothing checked`);
  const n = html.split('Not checked').length - 1;
  assert.ok(n >= 3, `"Not checked" appears ${n} times (header, file list, claim vs reality)`);
  assert.ok(header(html).includes('Not checked'), 'the header itself says Not checked');
  assert.ok(html.includes('"checked":false'), 'the tabs are told nothing was checked');
});

it('HTML1: turns checked with no checkable claim say so, never "all clean"', () => {
  const html = renderSessionHtml('s1', [{ turn_id: 't1', claims: [], subtasks: [], undisclosed: [], untracked: [], summary: summary({}) }], trail);
  assert.ok(!html.includes('all clean') && !html.includes('looks clean'), 'no clean verdict without a claim');
  assert.ok(header(html).includes('No checkable claims'), 'the header says what was found');
  assert.ok(!header(html).includes('none wrong'), 'and never that claims were checked');
});

it('HTML1: a checked session with every claim verified may read clean', () => {
  const html = renderSessionHtml('s1', [{ turn_id: 't1', claims: [{ claim: { text: 'x' }, outcome: 'verified', evidence: [] }], subtasks: [], undisclosed: [], untracked: [], summary: summary({ verified: 1 }) }], trail);
  assert.ok(html.includes('Clean'), 'clean, when it was checked and nothing is wrong');
});

it('HTML1: one palette: each outcome has one colour across the page', () => {
  const html = require('../src/render/html');
  assert.deepStrictEqual(html.COLORS, Object.assign({}, html.COLORS, tv.STAIN_COLORS), 'the header and the tabs agree on every outcome they share');
});

it('HTML1: neutral words, no metric the page does not show, and the dropped-ask check marked noisy', () => {
  const html = renderSessionHtml('s1', [], trail);
  for (const w of ['fabrication', 'Reliability', 'Phantom Rate', 'ConfIdx', 'actually complete', 'benchmark', 'false confidence']) assert.ok(!html.includes(w), `"${w}" is on the page`);
  assert.ok(!/\blies?\b/.test(html), 'no "lie" or "lies" as a word');
  assert.ok(html.includes('often wrong'), 'the dropped-ask finding says it is often wrong (LD302)');
});

it('HTML1: the ranked file bars draw (an inline span ignored its width, so none ever showed)', () => {
  const css = renderSessionHtml('s1', [], trail);
  assert.ok(/\.rank-bar span \{ display:block;/.test(css), 'the bar fill is a block');
  assert.ok(!/got wrong|fix its mistakes/.test(css), 'the Report hint is neutral');
});

it("HTML1: the judge's report shows a finding repeated 89 times as one line with its count; the JSON keeps all 89", () => {
  const rep = require('../src/babalawo/report');
  const same = (i) => ({ kind: 'verdict', verdict: 'violation', rule: 'R16', odu_id: `odu_${i}`, target: 'src', sentence: "Orunmila's own code changed during the session (src)." });
  const model = {
    session_id: 's1', verdict: 'violation', top_line: '89 violations', judged_now: false, experimental: null,
    findings: [...Array.from({ length: 89 }, (_, i) => same(i)), { kind: 'verdict', verdict: 'look_at_this', rule: 'R6', odu_id: 'odu_x', target: 'a.js', sentence: 'a.js changed.' }],
    law_gate: { checked: 0, passed: 0, warned: 0, blocked: 0, skipped: 0, skip_rate: 0 }, hidden: 0, quarantined: 0, overlapped: [],
  };
  const html = rep.renderHtml(model);
  assert.strictEqual((html.match(/<li /g) || []).length, 2, 'two lines: the 89 as one, and the other');
  assert.ok(html.includes('89×'), 'with its count');
  assert.ok(html.includes('89 violations') && html.includes('1 thing to look at'), 'and a summary of every kind');
  const text = rep.renderText(model);
  assert.strictEqual(text.split('\n').filter((l) => l.startsWith('- ')).length, 2);
  assert.strictEqual(JSON.parse(rep.renderJson(model)).findings.length, 90, 'the JSON for the agent is unchanged');
});

it('HTML1: no emoji icons (they draw differently, or not at all, on Windows and Linux)', () => {
  const html = renderSessionHtml('s1', [], trail);
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  assert.deepStrictEqual([...new Set(emoji)], []);
});

it('MR3 (LD316): the trail page carries the witness gap under its header; with no odù log it says the gap is not shown, never a clean figure', () => {
  const witnesses = { changes: 2, sentence: 'What changed on disk: 2 changes. The Sentinel alone recorded 2: no tool call or command the agent made explains them.' };
  const html = renderSessionHtml('s1', [], trail, { witnesses });
  assert.ok(header(html).includes(`<p class="gap">${witnesses.sentence}</p>`), header(html));
  const none = renderSessionHtml('s1', [], trail, { witnesses: null });
  assert.ok(header(none).includes('What changed on disk is not shown: this session has no odù log to read both witnesses from'), header(none));
  assert.ok(!renderSessionHtml('s1', [], trail).includes('What changed on disk'), '`orunmila html`, which passes nothing, is unchanged');
});

runAll('trail-page');
