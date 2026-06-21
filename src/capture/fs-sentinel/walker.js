'use strict';

/**
 * walker.js
 *
 * Portable recursive watching WITHOUT fs.watch(recursive:true). Node's recursive
 * mode is only reliable on macOS/Windows; on Linux it's experimental and has
 * historically dropped events. A trust tool can't ship a watcher that silently
 * misses writes, so we do it the explicit way (PRD 6.4, design SENTINEL §1):
 *
 *   1. Walk the tree once, attaching a NON-recursive fs.watch per directory.
 *   2. When any watched dir reports a change, if a brand-new subdirectory
 *      appeared, attach a watcher to it too (and walk it, in case files landed
 *      inside before we got there).
 *
 * The walker does not hash or diff — it only answers "a path under here may have
 * changed" and hands that path to the caller's onPath callback. Ignore decisions
 * are made here (so we never even attach a watcher inside node_modules/).
 *
 * Failure visibility (PRD: a silently-dead watcher is the worst outcome):
 *   - per-dir attach errors go to onError with the dir and the errno;
 *   - ENOSPC (Linux inotify watch limit) is surfaced with the actual fix, not
 *     swallowed.
 */

const fs = require('fs');
const path = require('path');

function createWalker({ root, isIgnored, onPath, onError, onWatcherCount }) {
  const watchers = new Map(); // absDir -> FSWatcher
  let closed = false;

  function rel(absPath) {
    return path.relative(root, absPath);
  }

  function ignored(absPath) {
    const r = rel(absPath);
    if (r === '') return false; // never ignore the root itself
    return isIgnored(r);
  }

  function attach(absDir) {
    if (closed || watchers.has(absDir) || ignored(absDir)) return;
    let watcher;
    try {
      watcher = fs.watch(absDir, { persistent: true }, (eventType, filename) => {
        if (closed) return;
        // filename can be null on some platforms; fall back to re-scanning dir.
        if (!filename) {
          rescanDir(absDir);
          return;
        }
        const abs = path.join(absDir, String(filename));
        handle(abs);
      });
    } catch (err) {
      reportAttachError(absDir, err);
      return;
    }
    watcher.on('error', (err) => reportAttachError(absDir, err));
    watchers.set(absDir, watcher);
    if (onWatcherCount) onWatcherCount(watchers.size);
  }

  function reportAttachError(absDir, err) {
    if (err && err.code === 'ENOSPC') {
      onError(
        new Error(
          `fs-sentinel: inotify watch limit hit attaching to ${absDir}. ` +
            'Raise it with: echo fs.inotify.max_user_watches=524288 | ' +
            'sudo tee -a /etc/sysctl.conf && sudo sysctl -p'
        )
      );
    } else {
      onError(new Error(`fs-sentinel: cannot watch ${absDir}: ${err && err.message}`));
    }
  }

  // Something changed at `abs`. If it's a (new) directory, start watching it and
  // walk it. Either way, tell the caller a path may have changed so it can hash.
  function handle(abs) {
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      // Path vanished (delete/rename). Still report it so the store can record
      // a deletion; don't try to watch it.
      onPath(abs);
      return;
    }
    if (stat.isDirectory()) {
      if (!ignored(abs)) {
        attach(abs);
        // Files that landed in this newly-appeared dir before our watcher
        // attached are genuinely new writes — report them, don't silently
        // seed them. Without this, a file created in a brand-new subdir
        // during the attach window is lost (the race is wider on Windows,
        // where parent-dir change delivery lags behind the write). onPath is
        // idempotent via the store's hash compare, so re-reporting a file the
        // freshly-attached watcher also caught emits nothing the second time.
        for (const f of walk(abs)) onPath(f);
      }
      return;
    }
    if (!ignored(abs)) onPath(abs);
  }

  // On a filename-less raw event, we can't know which child changed; re-stat the
  // directory's entries and let the store's hash compare decide what's real.
  function rescanDir(absDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      if (ignored(abs)) continue;
      if (ent.isDirectory()) attach(abs);
      else onPath(abs);
    }
  }

  /**
   * Walk a directory tree, attaching watchers. Returns the list of regular files
   * discovered (absolute paths) so the caller can SEED their hashes as baselines
   * — seeding matters so a pre-existing file edited later reads as 'modify', and
   * so the very first walk doesn't emit a write for every file already on disk.
   */
  function walk(absDir) {
    const files = [];
    const stack = [absDir];
    while (stack.length) {
      const dir = stack.pop();
      if (ignored(dir)) continue;
      attach(dir);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        onError(new Error(`fs-sentinel: cannot read ${dir}: ${err && err.message}`));
        continue;
      }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        if (ignored(abs)) continue;
        if (ent.isDirectory()) stack.push(abs);
        else if (ent.isFile()) files.push(abs);
      }
    }
    return files;
  }

  function start() {
    return walk(root);
  }

  function close() {
    closed = true;
    for (const w of watchers.values()) {
      try {
        w.close();
      } catch {
        /* already gone */
      }
    }
    watchers.clear();
  }

  function watcherCount() {
    return watchers.size;
  }

  return { start, walk, attach, close, watcherCount };
}

module.exports = { createWalker };
