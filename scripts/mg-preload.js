// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/mg-preload.js — MG4: loaded with --require into the node suite the mutation gate's launcher starts, and
 * into nothing else (the variable is removed here, so the suite's children never see it). At the suite's exit, while
 * every process it started is still its child, it writes them to the file the launcher named; the launcher kills
 * them once the suite is gone, even one that left the suite's group and cleared its environment.
 */

const file = process.env.ORUNMILA_MG_TREE;
delete process.env.ORUNMILA_MG_TREE;

if (file) {
  const tree = require('./mg-tree');
  process.on('exit', () => {
    try {
      require('fs').appendFileSync(file, tree.formatTracked(tree.track(tree.table(), [process.pid], new Map())));
    } catch (e) {
      void e; // a gate that cannot read the table falls back to its poll and its kills; the suite is never disturbed
    }
  });
}
