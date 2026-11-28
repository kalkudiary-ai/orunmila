// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

// Loaded with `node -r` by scripts/hook-reach.js: on exit, writes every module
// this process loaded from the repo to $HOOK_REACH_OUT, as repo-relative paths.

const fs = require('fs');
const path = require('path');

const root = process.env.HOOK_REACH_ROOT;
process.on('exit', () => {
  // W3c: module paths use the OS separator (`\` on Windows); the list is written with `/` on every OS.
  const files = Object.keys(require.cache)
    .filter((f) => f.startsWith(root + path.sep) && f !== __filename)
    .map((f) => f.slice(root.length + 1).split(path.sep).join('/'))
    .sort();
  fs.writeFileSync(process.env.HOOK_REACH_OUT, JSON.stringify(files));
});
