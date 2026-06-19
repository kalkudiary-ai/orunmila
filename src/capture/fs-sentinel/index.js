#!/usr/bin/env node
'use strict';

/**
 * index.js  (stainmap watch-fs)
 *
 * The Filesystem Sentinel entry point — PRD 6.4, "the most important addition."
 * This is the independent observer: it watches the project tree itself and logs
 * a file_write event for every real content change, whether or not any agent
 * hook announced it. The hook stream is what the agent SAYS it did; this stream
 * is what the disk actually shows. The gap between them is the untracked_write
 * the reconciler later surfaces at the top of the report.
 *
 * It deliberately reuses the SAME event log and the SAME unifiedDiff() the hook
 * layer uses, with source:"fs-sentinel" as the only discriminator — so the
 * reconciler can compare like with like.
 *
 * Correlation honesty: this process does not know Claude Code's session_id or
 * turn_id (it's a separate process). So sentinel events are stamped
 * turn_id:null / session_id:null and the reconciler buckets them into a turn by
 * TIMESTAMP WINDOW (see matcher untracked_write). That heuristic is documented,
 * not hidden — its one failure mode (a write near a turn boundary landing in the
 * adjacent turn) is visible, never silent.
 *
 * Pipeline per raw fs event:
 *   walker(onPath) -> debounce(~150ms per path) -> store.diffAndUpdate (hash
 *   compare, drops touch-without-modify) -> append file_write event.
 */

const path = require('path');
const { append, TYPES } = require('../../store/eventlog');
const { unifiedDiff } = require('../../reconcile/difftool');
const { createWalker } = require('./walker');
const { createStore } = require('./hasher');
const { effectiveIgnore, isIgnored } = require('./ignore');

const DEBOUNCE_MS = 150;

function startSentinel(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const ignoreList = effectiveIgnore(root, opts);
  const store = createStore();

  const pending = new Map(); // absPath -> timeout handle (debounce)
  const log = opts.log || ((msg) => process.stderr.write(msg + '\n'));

  function onError(err) {
    log(`[fs-sentinel] ${err.message}`);
  }

  function emit(absPath) {
    const change = store.diffAndUpdate(absPath);
    if (!change) return; // unchanged content — the touch-without-modify drop.

    const relPath = path.relative(root, absPath);
    const diff = change.binary
      ? `Binary file ${relPath} changed (${change.kind}).`
      : unifiedDiff(change.before, change.after, relPath);

    append({
      session_id: null, // unknown from this process; correlated by time window
      turn_id: null,
      agent: 'fs-sentinel',
      source: 'fs-sentinel',
      type: TYPES.FILE_WRITE,
      path: absPath,
      rel_path: relPath,
      diff,
      hash_before: change.hash_before,
      hash_after: change.hash_after,
      binary: !!change.binary,
      change_kind: change.kind,
      failed: false,
    });

    if (opts.verbose) log(`[fs-sentinel] ${change.kind} ${relPath}`);
  }

  function onPath(absPath) {
    // Coalesce a burst of raw events for the same path (atomic-save dance).
    const prev = pending.get(absPath);
    if (prev) clearTimeout(prev);
    pending.set(
      absPath,
      setTimeout(() => {
        pending.delete(absPath);
        emit(absPath);
      }, DEBOUNCE_MS)
    );
  }

  const walker = createWalker({
    root,
    isIgnored: (rel) => isIgnored(rel, ignoreList),
    onPath,
    onError,
    onWatcherCount: opts.onWatcherCount,
  });

  // Initial walk seeds baselines so pre-existing files don't all emit a write,
  // and so a later edit reads as a real diff against known content.
  const files = walker.start();
  for (const f of files) store.seed(f);

  log(
    `[fs-sentinel] watching ${root} ` +
      `(${walker.watcherCount()} dirs, ${files.length} files baselined)`
  );
  log(`[fs-sentinel] ignoring: ${ignoreList.join('  ')}`);

  function stop() {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    walker.close();
  }

  return { stop, walker, store, ignoreList, root };
}

// CLI entry: `node src/capture/fs-sentinel/index.js [root]`
function main() {
  const root = process.argv[2] || process.cwd();
  const sentinel = startSentinel({ root, verbose: true });

  const shutdown = () => {
    sentinel.stop();
    process.stderr.write('[fs-sentinel] stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { startSentinel, DEBOUNCE_MS };
