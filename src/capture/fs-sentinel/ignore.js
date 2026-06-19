'use strict';

/**
 * ignore.js
 *
 * The sentinel's one deliberate blind spot, made VISIBLE (PRD 6.4). The whole
 * selling point of the watcher is "no hidden gaps," so the set of things it
 * intentionally does NOT watch must be the most transparent part of the config,
 * not a buried hardcoded list. `stainmap status` prints exactly what
 * effectiveIgnore() returns.
 *
 * Two tiers, on purpose:
 *   ALWAYS_IGNORE  - structural, you basically never want these. Critically
 *                    includes `.stainmap/` so the sentinel doesn't watch its own
 *                    event log and loop forever, and `.git/` whose churn is not
 *                    agent work.
 *   BUILD_DIRS     - build output. This is a SEPARATE toggle (ignoreBuildOutput)
 *                    because "I built it" is exactly the kind of claim a user may
 *                    want checked against real files in dist/. Default on for
 *                    signal-to-noise, but one flip away from off, and labeled.
 *
 * User overrides come from `.stainmap/ignore` in the watched root (one glob-ish
 * path fragment per line, `#` comments allowed). Overrides ADD to the defaults;
 * a leading `!` un-ignores a default (e.g. `!dist/` to watch build output).
 */

const fs = require('fs');
const path = require('path');

const ALWAYS_IGNORE = ['.git/', 'node_modules/', '.stainmap/', '.hg/', '.svn/'];

const BUILD_DIRS = ['dist/', 'build/', '.next/', 'out/', 'coverage/', 'target/', '.turbo/', '.cache/'];

/**
 * Read user overrides from <root>/.stainmap/ignore. Returns { add, unignore }.
 * Lines starting with '!' un-ignore a default; everything else is an extra
 * ignore. Missing file is fine (returns empty sets) — overrides are optional.
 */
function readUserOverrides(root) {
  const file = path.join(root, '.stainmap', 'ignore');
  const add = [];
  const unignore = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { add, unignore };
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      const v = line.slice(1).trim();
      if (v) unignore.push(v);
    } else {
      add.push(line);
    }
  }
  return { add, unignore };
}

/**
 * The full effective ignore list for a given root, after applying the
 * ignoreBuildOutput toggle and any user overrides. This is what status prints.
 */
function effectiveIgnore(root, opts = {}) {
  const ignoreBuildOutput = opts.ignoreBuildOutput !== false; // default true
  const { add, unignore } = readUserOverrides(root || process.cwd());

  let list = [...ALWAYS_IGNORE];
  if (ignoreBuildOutput) list = list.concat(BUILD_DIRS);
  list = list.concat(add);

  // Apply un-ignores last so a user can pull a default back into view.
  if (unignore.length) {
    const drop = new Set(unignore.map(norm));
    list = list.filter((entry) => !drop.has(norm(entry)));
  }

  // De-dupe, keep order.
  const seen = new Set();
  return list.filter((e) => {
    const k = norm(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function norm(entry) {
  return String(entry).replace(/\/+$/, '').replace(/^\.\//, '');
}

/**
 * Is `relPath` (relative to the watched root, posix-ish) ignored by `list`?
 * Match is a path-segment prefix test: an entry `node_modules/` ignores
 * `node_modules/foo/bar.js` and the dir itself, but NOT `my-node_modules.txt`.
 * A bare filename entry (no slash) matches that file anywhere in the tree.
 */
function isIgnored(relPath, list) {
  if (!relPath) return false;
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  for (const rawEntry of list) {
    const entry = norm(rawEntry);
    if (!entry) continue;
    if (entry.includes('/')) {
      // Directory-ish prefix: match against the joined relative path prefix.
      const entrySegs = entry.split('/').filter(Boolean);
      if (segmentsStartWith(segments, entrySegs)) return true;
    } else {
      // Bare name: match any segment (dir or file) equal to it.
      if (segments.includes(entry)) return true;
    }
  }
  return false;
}

function segmentsStartWith(segments, prefixSegs) {
  if (prefixSegs.length > segments.length) {
    // Could still match if the prefix names a single segment present anywhere.
    return prefixSegs.length === 1 && segments.includes(prefixSegs[0]);
  }
  for (let i = 0; i < prefixSegs.length; i++) {
    if (segments[i] !== prefixSegs[i]) {
      // Fall back to "appears as a contiguous run anywhere" for nested matches.
      return containsRun(segments, prefixSegs);
    }
  }
  return true;
}

function containsRun(segments, run) {
  if (!run.length) return false;
  for (let i = 0; i + run.length <= segments.length; i++) {
    let ok = true;
    for (let j = 0; j < run.length; j++) {
      if (segments[i + j] !== run[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

module.exports = {
  ALWAYS_IGNORE,
  BUILD_DIRS,
  effectiveIgnore,
  isIgnored,
  readUserOverrides,
};
