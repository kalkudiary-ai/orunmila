'use strict';

/**
 * difftool.js
 *
 * Two jobs:
 *   1. unifiedDiff()  - produce a real unified diff between before/after content.
 *   2. substanceStats() - count lines that are actual logic vs comments/blank/
 *      docstring-only additions. This is what stops a stub function with a nice
 *      comment from scoring the same as a real implementation (forensic gap #4).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function unifiedDiff(before, after, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stainmap-'));
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  fs.writeFileSync(a, before || '');
  fs.writeFileSync(b, after || '');
  let out = '';
  try {
    out = execFileSync('diff', ['-u', '--label', `${label} (before)`, '--label', `${label} (after)`, a, b], {
      encoding: 'utf8',
    });
  } catch (err) {
    // diff exits 1 when files differ - that's not a failure, that's the normal case
    out = err.stdout || '';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

// Crude but cheap: a line counts as "substance" if it's not blank, not a
// line-comment-only line, and not inside a docstring/block-comment-only hunk.
// This intentionally errs toward under-counting substance for unfamiliar
// languages rather than guessing wrong - the matcher treats "no substance
// signal" as "fall back to raw line count", never as "assume it's empty".
const COMMENT_ONLY = /^\s*(\/\/|#|\*|\/\*|"""|'''|<!--)/;

function substanceStats(diffText) {
  let added = 0;
  let removed = 0;
  let addedSubstance = 0;
  if (!diffText) return { added, removed, addedSubstance };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added++;
      const body = line.slice(1);
      if (body.trim() !== '' && !COMMENT_ONLY.test(body)) addedSubstance++;
    } else if (line.startsWith('-')) {
      removed++;
    }
  }
  return { added, removed, addedSubstance };
}

module.exports = { unifiedDiff, substanceStats };
