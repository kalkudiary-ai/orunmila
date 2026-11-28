// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/reconcile/claims-block.js — the structured claims block (MR1, LD319; brief v4 line 443: "a structured claims
 * block the agent is asked to produce at closeout, or fixed patterns"; O's approval of R1, LD315). The format is
 * spec/claims-block.md. Plain code, no model (guarantee 8).
 *
 * The agent ends a turn's message with one fenced block whose info string is `orunmila-claims`:
 *
 *   ```orunmila-claims
 *   changed: src/a.js, src/b.js
 *   proved: npm test
 *   not done: the Windows run
 *   ```
 *
 * `changed:` the files it changed (comma-separated, one or more lines); `proved:` one command per line that shows the
 * work passes, which must have run in the turn and passed; `not done:` what it was asked and did not do. The last block
 * in the message counts. Prose claims are still read as before: the block adds exact claims, it replaces nothing.
 *
 *   parseClaimsBlock(text) -> null (no block) | { changed: [path], proved: [command], not_done: [text], errors: [words] }
 *   provedBy(command, passing) -> the passing run whose exit status is `command`'s, or null (see below)
 *   mentions(command, run)     -> whether a run names `command` as a step or a pipeline stage (for a finding's words)
 */

const FENCE = /^(```|~~~)[ \t]*orunmila-claims[ \t]*$/;
const KEYS = { changed: 'changed', proved: 'proved', 'not done': 'not_done' };

function parseClaimsBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i].trim());
    if (!open) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== open[1]) body.push(lines[j++]);
    if (j < lines.length) block = body; // a block with no closing fence is not a block
    i = j;
  }
  if (!block) return null;
  const out = { changed: [], proved: [], not_done: [], errors: [] };
  block.forEach((raw, n) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^([a-z][a-z ]*?)\s*:\s*(.*)$/i.exec(line);
    const key = m && KEYS[m[1].toLowerCase()];
    if (!key) return out.errors.push(`line ${n + 1} of the block: "${line.slice(0, 60)}" is not changed:, proved: or not done:`);
    const value = m[2].trim();
    if (!value) return out.errors.push(`line ${n + 1} of the block: ${m[1].toLowerCase()}: names nothing`);
    if (key === 'changed') out.changed.push(...value.split(',').map((p) => p.trim()).filter(Boolean));
    else out[key].push(value);
  });
  return out;
}

const norm = (s) => String(s).trim().replace(/\s+/g, ' ');

/**
 * A run proves the declared command only when its exit status is that command's. The run's status is its last
 * segment's (after the last `;` or line break), so the command must be one of that segment's `&&` steps: `cd web &&
 * npm test` and `cd web; npm test` prove `npm test`; `npm test; echo done` does not (echo's status), nor does a last
 * segment with `||` (`npm test && x || true` exits 0 whatever the tests did: line 433's laundering). Pipes are the
 * caller's: it passes only runs whose exit status means what it says. A `;` inside quotes is read as a separator: a
 * stated limit, on the cautious side.
 */
function provedBy(command, runs) {
  const want = norm(command);
  return (
    runs.find((r) => {
      const segments = String(r.command).split(/;|\n/).map(norm).filter(Boolean);
      const last = segments[segments.length - 1] || '';
      return !last.includes('||') && last.split('&&').map(norm).includes(want);
    }) || null
  );
}

function mentions(command, run) {
  return String(run.command).split(/&&|\|\||\||;|\n/).map(norm).includes(norm(command));
}

/**
 * MR1b1 (LD339; brief line 443: "a structured claims block the agent is asked to produce at closeout"): the request,
 * given to the agent as context with each prompt while ORUNMILA_CLAIMS_BLOCK=1. Its example is itself a block.
 */
const ASK = [
  'Orunmila checks what you say you did against its own record of what happened. At the end of your final message this turn, add one block:',
  '```orunmila-claims',
  'changed: <each file you changed this turn, comma-separated>',
  'proved: <one command you ran this turn that shows the work passes; one line each>',
  'not done: <anything asked that you did not do; one line each>',
  '```',
  'Leave out a line you have nothing for. Each line is checked: a changed file the record does not show changed, or a proved command that did not run and pass, is a finding.',
].join('\n');

module.exports = { parseClaimsBlock, provedBy, mentions, ASK };
