// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

// Loaded with `node -r` by scripts/hook-reach.js: on exit, writes every module
// this process loaded from the repo to $HOOK_REACH_OUT, as repo-relative paths.

const fs = require('fs');

const root = process.env.HOOK_REACH_ROOT;
process.on('exit', () => {
  const files = Object.keys(require.cache)
    .filter((f) => f.startsWith(root + '/') && f !== __filename)
    .map((f) => f.slice(root.length + 1))
    .sort();
  fs.writeFileSync(process.env.HOOK_REACH_OUT, JSON.stringify(files));
});
