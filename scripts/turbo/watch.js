'use strict';

/**
 * scripts/turbo/watch.js — the checks that make an escape from a TURBO session show up and stop
 * the run (O, 2026-11-22: "record where every write lands, check it, and make the close-out
 * declare it"; slices T18-T21, LD125-LD130).
 *
 * They detect; they do not prevent. The sandbox and the guard prevent, and these catch what got
 * past them: after each session, before the driver runs git again or starts the next session.
 *
 *   writeSentinelIgnore(root)   the clone's .orunmila/ignore: its Sentinel watches .turbo/ and
 *                               every build folder (T18), so a session's write there has a disk record
 */

const fs = require('fs');
const path = require('path');

const { BUILD_DIRS } = require('../../src/capture/fs-sentinel/ignore');

// --- T18: what the clone's Sentinel watches ------------------------------------------

/** The clone's Sentinel overrides: every build folder back in view, .turbo/ (TURBO's state) among them. */
function sentinelIgnoreText() {
  return [
    '# Written by the TURBO driver at the start of every run (slice T18, LD125); edits are overwritten.',
    '# The Sentinel watches the run state and every build folder, so a session write there has a disk record.',
    ...BUILD_DIRS.map((d) => `!${d}`),
    '',
  ].join('\n');
}

/** Write <root>/.orunmila/ignore, never through a link a session planted (LD117). Returns its path. */
function writeSentinelIgnore(root) {
  const dir = path.join(root, '.orunmila');
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {}
  if (st && !st.isDirectory()) throw new Error(`${dir} is not a directory (a symlink?); TURBO does not write through it`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ignore');
  try {
    fs.unlinkSync(file);
  } catch {}
  fs.writeFileSync(file, sentinelIgnoreText(), { flag: 'wx' });
  return file;
}

module.exports = { sentinelIgnoreText, writeSentinelIgnore };
